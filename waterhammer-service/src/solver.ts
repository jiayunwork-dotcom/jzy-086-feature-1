import { GRAVITY } from "./constants.js";
import { buildClosure } from "./closure.js";
import { ServiceError } from "./errors.js";
import { buildGrid, type RuntimePipe } from "./grid.js";
import {
  interiorNode,
  minusRelation,
  plusRelation,
} from "./characteristics.js";
import { reservoirBoundary, valveBoundary } from "./boundaries.js";
import type { JunctionSeries, SimulationResult, ValidatedRequest } from "./types.js";

/**
 * 多段串联主线的时间推进内核：特征线法（MOC），全线库朗数恒为 1。
 *
 * 状态按段存储：第 s 段有 N_s+1 个节点，head_s/flow_s。两段共用一个
 * 连接点节点（上游段末端、下游段首端），物理约束为：
 *   - 体积流量连续（截面不同也守恒的是 Q，不是流速）；
 *   - 水头相等（无损连接，不计局部损失）。
 *
 * 每个时步全部从旧时层构造特征线系数、一次性写出新时层（显式、无生代循环）：
 *  1. 各段内部节点 i=1..N_s-1：联立本段 i-1 到达的 C+ 与 i+1 到达的 C-；
 *  2. 内部连接点 j：联立**上游段**末端内侧到达的 C+ 与**下游段**首端内侧
 *     到达的 C-，两侧阻抗 B、摩阻 R 各按本段取值；解出的 (H,Q) 同时写入
 *     上游段末端与下游段首端——不是把两段各算各的再拼；
 *  3. 最上游节点：水库水头锁死，与第 0 段的 C- 联立；
 *  4. 最下游节点：阀门孔口关系与末段 C+ 联立。
 */
export function runSimulation(req: ValidatedRequest): SimulationResult {
  const { pipes: pipeSpecs, reservoirHead, initialVelocity, duration, maxSteps } = req;
  const P = pipeSpecs.length;
  const { grid, runtime } = buildGrid(pipeSpecs, req.discretization, duration);

  if (grid.steps > maxSteps) {
    throw new ServiceError(
      "STEPS_EXCEEDED",
      `simulation requires ${grid.steps} time steps, exceeding the limit of ${maxSteps}`,
      { steps: grid.steps, maxSteps },
    );
  }

  const dt = grid.dt;
  const steps = grid.steps;

  // 每段状态数组（N_s+1 个节点）
  const Ns = runtime.map((p) => p.segments);
  const head = runtime.map((p) => new Array<number>(p.segments + 1));
  const flow = runtime.map((p) => new Array<number>(p.segments + 1));
  const headNew = runtime.map((p) => new Array<number>(p.segments + 1));
  const flowNew = runtime.map((p) => new Array<number>(p.segments + 1));

  // ---- 初始稳态：全线同一个体积流量 Q0 = V0*A_0（约定 V0 为最上游段流速），
  // 水头自水库起按各段二次损失逐 reach 递减；各段流速 V_s = Q0/A_s 不必相同。 ----
  const q0 = initialVelocity * runtime[0].area;
  let loss = 0;
  for (let s = 0; s < P; s++) {
    const p = runtime[s];
    for (let i = 0; i <= Ns[s]; i++) {
      flow[s][i] = q0;
      head[s][i] = reservoirHead - (loss + i * p.friction * q0 * Math.abs(q0));
    }
    loss += Ns[s] * p.friction * q0 * Math.abs(q0);
  }
  const last = P - 1;
  const initialValveHead = head[last][Ns[last]];
  if (!(initialValveHead > 0)) {
    throw new ServiceError(
      "INVALID_INPUT",
      "steady-state valve head is non-positive (friction loss exceeds reservoir head); cannot calibrate valve",
      { reservoirHead, initialValveHead },
    );
  }
  const valveCoeff = q0 / Math.sqrt(initialValveHead);
  const tau = buildClosure(req.closure);

  // ---- 序列记录 ----
  const vTime = new Array<number>(steps + 1);
  const vHead = new Array<number>(steps + 1);

  const junctionCount = P - 1;
  // 连接点里程：第 j 个连接点 = 前 j+1 段（索引 0..j）累计长度
  const junctionX: number[] = [];
  let accumX = 0;
  for (let j = 0; j < junctionCount; j++) {
    accumX += runtime[j].length;
    junctionX.push(accumX);
  }
  const junctions: JunctionSeries[] = Array.from({ length: junctionCount }, (_, j) => ({
    index: j,
    x: junctionX[j],
    time: new Array<number>(steps + 1),
    head: new Array<number>(steps + 1),
    flow: new Array<number>(steps + 1),
  }));

  const dTime = new Array<number>(steps + 1);
  const dStorage = new Array<number>(steps + 1);
  const dMean = new Array<number>(steps + 1);
  const dIn = new Array<number>(steps + 1);
  const dOut = new Array<number>(steps + 1);
  const dJunctionFlows: number[][] = junctions.map(() => new Array<number>(steps + 1));

  /** 全主线蓄水积分 Σ_s ∫H dx：每段按 reach 做梯形积分。 */
  const storageOf = (h: number[][]): number => {
    let s = 0;
    for (let k = 0; k < P; k++) {
      const p = runtime[k];
      const hk = h[k];
      let seg = 0.5 * (hk[0] + hk[Ns[k]]);
      for (let i = 1; i < Ns[k]; i++) seg += hk[i];
      s += seg * p.dx;
    }
    return s;
  };

  vTime[0] = 0;
  vHead[0] = initialValveHead;
  for (let j = 0; j < junctionCount; j++) {
    junctions[j].time[0] = 0;
    junctions[j].head[0] = head[j + 1][0];
    junctions[j].flow[0] = flow[j + 1][0];
    dJunctionFlows[j][0] = flow[j + 1][0];
  }
  dTime[0] = 0;
  dStorage[0] = storageOf(head);
  dMean[0] = dStorage[0] / grid.totalLength;
  dIn[0] = flow[0][0];
  dOut[0] = flow[last][Ns[last]];

  for (let n = 1; n <= steps; n++) {
    const t = n * dt;
    const tauNow = tau(t);

    // 1) 各段内部节点
    for (let s = 0; s < P; s++) {
      const p = runtime[s];
      for (let i = 1; i < Ns[s]; i++) {
        const plus = plusRelation(head[s][i - 1], flow[s][i - 1], p.impedance, p.friction);
        const minus = minusRelation(head[s][i + 1], flow[s][i + 1], p.impedance, p.friction);
        const { head: h, flow: q } = interiorNode(plus, minus);
        headNew[s][i] = h;
        flowNew[s][i] = q;
      }
    }

    // 2) 内部连接点：上游段 C+ × 下游段 C-（两侧 B、R 各自不同）
    for (let j = 0; j < junctionCount; j++) {
      const up = runtime[j];
      const dn = runtime[j + 1];
      const plus = plusRelation(
        head[j][Ns[j] - 1],
        flow[j][Ns[j] - 1],
        up.impedance,
        up.friction,
      );
      const minus = minusRelation(head[j + 1][1], flow[j + 1][1], dn.impedance, dn.friction);
      const { head: h, flow: q } = interiorNode(plus, minus);
      // 同一个物理点：同时落到上游段末端与下游段首端
      headNew[j][Ns[j]] = h;
      flowNew[j][Ns[j]] = q;
      headNew[j + 1][0] = h;
      flowNew[j + 1][0] = q;
    }

    // 3) 上游边界：水库（第 0 段首端）
    const p0 = runtime[0];
    const ub = reservoirBoundary(
      reservoirHead,
      minusRelation(head[0][1], flow[0][1], p0.impedance, p0.friction),
    );
    headNew[0][0] = ub.head;
    flowNew[0][0] = ub.flow;

    // 4) 下游边界：阀门（末段末端）
    const pl = runtime[last];
    const vb = valveBoundary(
      plusRelation(
        head[last][Ns[last] - 1],
        flow[last][Ns[last] - 1],
        pl.impedance,
        pl.friction,
      ),
      tauNow,
      valveCoeff,
    );
    headNew[last][Ns[last]] = vb.head;
    flowNew[last][Ns[last]] = vb.flow;

    // 连接点新值已写入两侧；若某段同时是两个连接点的邻段，
    // 其首/末端在上面循环 2 中各被赋值一次，互不重叠。
    for (let s = 0; s < P; s++) {
      for (let i = 0; i <= Ns[s]; i++) {
        head[s][i] = headNew[s][i];
        flow[s][i] = flowNew[s][i];
      }
    }

    vTime[n] = t;
    vHead[n] = head[last][Ns[last]];
    for (let j = 0; j < junctionCount; j++) {
      junctions[j].time[n] = t;
      junctions[j].head[n] = head[j + 1][0];
      junctions[j].flow[n] = flow[j + 1][0];
      dJunctionFlows[j][n] = flow[j + 1][0];
    }
    dTime[n] = t;
    dStorage[n] = storageOf(head);
    dMean[n] = dStorage[n] / grid.totalLength;
    dIn[n] = flow[0][0];
    dOut[n] = flow[last][Ns[last]];
  }

  // ---- 末态沿全线拼接（连接点只计一次） ----
  const xOut: number[] = [0];
  const hOut: number[] = [head[0][0]];
  const qOut: number[] = [flow[0][0]];
  let xAccum = 0;
  for (let s = 0; s < P; s++) {
    for (let i = 1; i <= Ns[s]; i++) {
      xAccum += runtime[s].dx;
      xOut.push(xAccum);
      hOut.push(head[s][i]);
      qOut.push(flow[s][i]);
    }
  }

  const oneWay = runtime.reduce((a, p) => a + p.travelTime, 0);
  const lastPipe = runtime[last];

  return {
    grid,
    valve: { time: vTime, head: vHead },
    junctions,
    finalState: { time: steps * dt, x: xOut, head: hOut, flow: qOut },
    initialValveHead,
    diagnostics: {
      time: dTime,
      meanHead: dMean,
      storage: dStorage,
      inflow: dIn,
      outflow: dOut,
      junctionFlows: dJunctionFlows,
    },
    derived: {
      area: runtime[0].area,
      areas: runtime.map((p) => p.area),
      waveSpeeds: runtime.map((p) => p.waveSpeed),
      lengths: runtime.map((p) => p.length),
      // B_last*|Q0| = a_last/(g*A_last) * |V0*A_0|；单段即 a*|V0|/g
      joukowskyRise: lastPipe.impedance * Math.abs(q0),
      oneWayTravelTime: oneWay,
      theoreticalPeriod: 2 * oneWay,
    },
  };
}
