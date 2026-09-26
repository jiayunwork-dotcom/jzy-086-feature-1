import { GRAVITY } from "./constants.js";
import { buildClosure } from "./closure.js";
import { ServiceError } from "./errors.js";
import { buildGrid } from "./grid.js";
import {
  interiorNode,
  minusRelation,
  plusRelation,
  reachFriction,
  waveImpedance,
} from "./characteristics.js";
import { reservoirBoundary, valveBoundary } from "./boundaries.js";
import type {
  Grid,
  JunctionSeries,
  PipeSpec,
  SimulationResult,
  ValidatedRequest,
} from "./types.js";

/** 段内的预计算常量与工作数组。 */
interface SegmentWorkspace {
  spec: PipeSpec;
  count: number;
  dx: number;
  area: number;
  /** 管道阻抗 B_k = a_k/(g*A_k) */
  B: number;
  /** 每 reach 摩阻系数 R_k */
  R: number;
  /** 该段节点坐标的主线累积偏移 */
  x0: number;
  head: number[];
  flow: number[];
  headNew: number[];
  flowNew: number[];
}

/**
 * 时间推进内核：特征线法（MOC），全主线库朗数恒为 1、共享同一时间步。
 *
 * 主线由 m 段等截面管首尾焊死而成。每段独立分网（dx_k = a_k·dt），
 * 每步更新时：
 *  1. 各段内部节点 i=1..N_k-1：联立本段从 i-1 到达的 C+ 与从 i+1 到达的 C-；
 *  2. 段间内部连接点：由上游段末点到达的 C+ 与下游段首点到达的 C- 联立，
 *     解出连接点共同水头与共同的体积流量（流量连续，而非流速相等），
 *     再把同一对 (H,Q) 写回两段的端点——无损连接，不计局部损失；
 *  3. 主线首端：水库水头锁死，与第 0 段到达的 C- 联立；
 *  4. 主线末端：阀门孔口关系与最后一段到达的 C+ 联立。
 * 全部特征线系数取旧时层状态，新时层一次性更新（显式、无生代循环）。
 */
export function runSimulation(req: ValidatedRequest): SimulationResult {
  const { pipes, reservoirHead, initialVelocity, duration, maxSteps } = req;
  const m = pipes.length;
  const grid: Grid = buildGrid(pipes, req.discretization, duration);

  if (grid.steps > maxSteps) {
    throw new ServiceError(
      "STEPS_EXCEEDED",
      `simulation requires ${grid.steps} time steps, exceeding the limit of ${maxSteps}`,
      { steps: grid.steps, maxSteps },
    );
  }

  const dt = grid.dt;

  // ---- 逐段工作区 ----
  const segments: SegmentWorkspace[] = [];
  let offset = 0;
  for (let k = 0; k < m; k++) {
    const spec = pipes[k];
    const g = grid.perSegment[k];
    const area = (Math.PI / 4) * spec.diameter ** 2;
    const ws: SegmentWorkspace = {
      spec,
      count: g.segments,
      dx: g.dx,
      area,
      B: waveImpedance(spec.waveSpeed, area),
      R: reachFriction(spec.frictionFactor, g.dx, spec.diameter, area),
      x0: offset,
      head: new Array<number>(g.segments + 1),
      flow: new Array<number>(g.segments + 1),
      headNew: new Array<number>(g.segments + 1),
      flowNew: new Array<number>(g.segments + 1),
    };
    segments.push(ws);
    offset += spec.length;
  }
  const totalLength = offset;

  // ---- 初始稳态：体积流量全主线守恒（Q0 按最上游段 V0 标定）----
  const q0 = initialVelocity * segments[0].area;
  let headValve = reservoirHead;
  // 水头沿程按各段二次损失逐 reach 递减；连接点处取上游段算出的值，
  // 再原样写进下游段首点，保证两侧初始水头严格相等（无伪跳变）。
  for (let k = 0; k < m; k++) {
    const ws = segments[k];
    ws.flow.fill(q0);
    ws.head[0] = headValve;
    for (let i = 1; i <= ws.count; i++) {
      ws.head[i] = ws.head[i - 1] - ws.R * q0 * Math.abs(q0);
    }
    headValve = ws.head[ws.count];
  }
  const initialValveHead = headValve;
  if (!(initialValveHead > 0)) {
    throw new ServiceError(
      "INVALID_INPUT",
      "steady-state valve head is non-positive (friction loss exceeds reservoir head); cannot calibrate valve",
      { reservoirHead, initialValveHead },
    );
  }
  const valveCoeff = q0 / Math.sqrt(initialValveHead);
  const tau = buildClosure(req.closure);

  // ---- 记录序列 ----
  const steps = grid.steps;
  const vTime = new Array<number>(steps + 1);
  const vHead = new Array<number>(steps + 1);
  const dTime = new Array<number>(steps + 1);
  const dMean = new Array<number>(steps + 1);
  const dIn = new Array<number>(steps + 1);
  const dOut = new Array<number>(steps + 1);
  const dPerSeg: number[][] = segments.map(() => new Array<number>(steps + 1));

  // 内部连接点（m-1 个）记录
  const junctionX: number[] = [];
  let jx = 0;
  for (let k = 0; k < m - 1; k++) {
    jx += segments[k].spec.length;
    junctionX.push(jx);
  }
  const jHead: number[][] = junctionX.map(() => new Array<number>(steps + 1));
  const jFlow: number[][] = junctionX.map(() => new Array<number>(steps + 1));

  /** 一段内水头的梯形长度加权平均。 */
  const segmentMeanHead = (ws: SegmentWorkspace, h: number[]): number => {
    let s = 0.5 * (h[0] + h[ws.count]);
    for (let i = 1; i < ws.count; i++) s += h[i];
    return s / ws.count;
  };
  /** 全主线长度加权平均水头。 */
  const globalMeanHead = (): number => {
    let acc = 0;
    for (const ws of segments) acc += ws.spec.length * segmentMeanHead(ws, ws.head);
    return acc / totalLength;
  };
  const recordJunctionHeads = (n: number): void => {
    for (let k = 0; k < m - 1; k++) {
      // 以上游段末点为准（推进后与下游段首点同值）
      jHead[k][n] = segments[k].head[segments[k].count];
      jFlow[k][n] = segments[k].flow[segments[k].count];
    }
  };

  vTime[0] = 0;
  vHead[0] = initialValveHead;
  dTime[0] = 0;
  dMean[0] = globalMeanHead();
  dIn[0] = segments[0].flow[0];
  dOut[0] = segments[m - 1].flow[segments[m - 1].count];
  for (let k = 0; k < m; k++) dPerSeg[k][0] = segmentMeanHead(segments[k], segments[k].head);
  recordJunctionHeads(0);

  for (let n = 1; n <= steps; n++) {
    const t = n * dt;
    const tauNow = tau(t);

    // 1) 各段内部节点
    for (const ws of segments) {
      for (let i = 1; i < ws.count; i++) {
        const plus = plusRelation(ws.head[i - 1], ws.flow[i - 1], ws.B, ws.R);
        const minus = minusRelation(ws.head[i + 1], ws.flow[i + 1], ws.B, ws.R);
        const node = interiorNode(plus, minus);
        ws.headNew[i] = node.head;
        ws.flowNew[i] = node.flow;
      }
    }

    // 2) 段间内部连接点：上游段 C+ × 下游段 C-，水头相等、体积流量连续
    for (let k = 0; k < m - 1; k++) {
      const up = segments[k];
      const down = segments[k + 1];
      const plus = plusRelation(
        up.head[up.count - 1],
        up.flow[up.count - 1],
        up.B,
        up.R,
      );
      const minus = minusRelation(down.head[1], down.flow[1], down.B, down.R);
      const node = interiorNode(plus, minus);
      up.headNew[up.count] = node.head;
      up.flowNew[up.count] = node.flow;
      down.headNew[0] = node.head;
      down.flowNew[0] = node.flow;
    }

    // 3) 上游边界：水库（第 0 段首点）
    const first = segments[0];
    const upb = reservoirBoundary(
      reservoirHead,
      minusRelation(first.head[1], first.flow[1], first.B, first.R),
    );
    first.headNew[0] = upb.head;
    first.flowNew[0] = upb.flow;

    // 4) 下游边界：阀门（最后一段末点）
    const last = segments[m - 1];
    const downb = valveBoundary(
      plusRelation(last.head[last.count - 1], last.flow[last.count - 1], last.B, last.R),
      tauNow,
      valveCoeff,
    );
    last.headNew[last.count] = downb.head;
    last.flowNew[last.count] = downb.flow;

    for (const ws of segments) {
      for (let i = 0; i <= ws.count; i++) {
        ws.head[i] = ws.headNew[i];
        ws.flow[i] = ws.flowNew[i];
      }
    }

    vTime[n] = t;
    vHead[n] = last.head[last.count];
    dTime[n] = t;
    dMean[n] = globalMeanHead();
    dIn[n] = first.flow[0];
    dOut[n] = last.flow[last.count];
    for (let k = 0; k < m; k++) dPerSeg[k][n] = segmentMeanHead(segments[k], segments[k].head);
    recordJunctionHeads(n);
  }

  // ---- 末态：各段节点首尾相接，内部连接点只保留一次 ----
  const xOut: number[] = [];
  const hOut: number[] = [];
  const qOut: number[] = [];
  for (let k = 0; k < m; k++) {
    const ws = segments[k];
    const iEnd = k === m - 1 ? ws.count : ws.count - 1;
    for (let i = 0; i <= iEnd; i++) {
      xOut.push(ws.x0 + i * ws.dx);
      hOut.push(ws.head[i]);
      qOut.push(ws.flow[i]);
    }
  }

  const junctions: JunctionSeries[] = junctionX.map((x, k) => ({
    index: k,
    x,
    time: [...dTime],
    head: jHead[k],
    flow: jFlow[k],
  }));

  const areas = segments.map((ws) => ws.area);
  const waveSpeeds = segments.map((ws) => ws.spec.waveSpeed);
  const lengths = segments.map((ws) => ws.spec.length);
  const waveTravelTime = grid.perSegment.reduce((s, g) => s + g.travelTime, 0);
  const valveVelocity = q0 / segments[m - 1].area;

  return {
    grid,
    valve: { time: vTime, head: vHead },
    junctions,
    finalState: { time: steps * dt, x: xOut, head: hOut, flow: qOut },
    initialValveHead,
    diagnostics: {
      time: dTime,
      meanHead: dMean,
      inflow: dIn,
      outflow: dOut,
      perSegmentMeanHead: dPerSeg,
    },
    derived: {
      area: segments[0].area,
      areas,
      waveSpeeds,
      lengths,
      initialFlow: q0,
      joukowskyRise: (segments[m - 1].spec.waveSpeed * Math.abs(valveVelocity)) / GRAVITY,
      waveTravelTime,
      theoreticalPeriod: 4 * waveTravelTime,
    },
  };
}
