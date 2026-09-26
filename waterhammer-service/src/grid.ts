import { GRAVITY } from "./constants.js";
import { ServiceError } from "./errors.js";
import type { DiscretizationSpec, Grid, PipeGrid, PipeSpec } from "./types.js";

/** 判定 L_s/(a_s*dt) 是否为整数、以及各段导出 dt 是否重合的相对容差。 */
export const CONFORM_TOL = 1e-6;

/** 逐段网格 + MOC 系数（阻抗 B、每 reach 摩阻 R），求解器直接使用。 */
export interface RuntimePipe extends PipeGrid {
  /** 管道阻抗 B = a/(g*A) */
  impedance: number;
  /** 每管段摩阻系数 R = f*dx/(2*g*D*A^2)，使 hf = R*Q*|Q| */
  friction: number;
}

export interface BuiltGrid {
  grid: Grid;
  runtime: RuntimePipe[];
}

/**
 * 多段串联主线的贴格网格构造。
 *
 * 特征线法要求全线库朗数恰为 1：每段都满足 dx_s = a_s*dt，且整条主线
 * 共享**同一个**时间步 dt。于是第 s 段必须切成整数
 *   N_s = (L_s / a_s) / dt        （波走过该段的行程时间 ÷ 公共时步）
 * 多段时各段波速不同，一般凑不出让所有 τ_s/dt 同时为整数的 dt；
 * 凑不出就抛 GRID_NOT_CONFORMING，绝不靠插值或数值耗散硬推。
 *
 * 三种合法指定方式（多段语义，重新组织，不复用单段旧判定）：
 *  1. 只给 timeStep：逐段判 τ_s/dt ∈ ℤ，任一非整即报错；
 *  2. segments 给数组 [N_0,…,N_{P-1}]：各段自带 dt_s = L_s/(a_s*N_s)，
 *     要求所有 dt_s 相对重合，否则报错；
 *  3. segments 给标量 N：每段都取 N 段，要求各段行程时间 τ_s 全部相等
 *     （即每段导出的 dt_s 重合），否则报错——多段异波速时通常凑不上；
 * 若同时给 timeStep，再在每段上复核 N_s*a_s*dt == L_s。
 *
 * 单段（P=1）是序列长度为 1 的特例，数值行为与旧实现严格一致：
 * 只给 N 时 dx = L/N、dt = dx/a；只给 dt 时按容差贴成整数 N。
 */
export function buildGrid(
  pipes: PipeSpec[],
  disc: DiscretizationSpec,
  duration: number,
): BuiltGrid {
  const P = pipes.length;
  const hasN = disc.segments !== undefined;
  const hasDt = disc.timeStep !== undefined;
  if (P < 1) {
    throw new ServiceError("INVALID_INPUT", "at least one pipe segment is required");
  }
  if (!hasN && !hasDt) {
    throw new ServiceError(
      "INVALID_INPUT",
      "discretization requires at least one of segments / timeStep",
    );
  }

  const specs = pipes.map((p) => ({
    spec: p,
    area: (Math.PI / 4) * p.diameter ** 2,
    travelTime: p.length / p.waveSpeed, // τ_s = L_s/a_s
  }));

  let ns: number[];
  let dt: number;
  const segmentsIsArray = Array.isArray(disc.segments);

  if (hasN && segmentsIsArray) {
    // ---- 逐段指定 N_s：各段 dt_s = τ_s/N_s 必须全线重合 ----
    const arr = disc.segments as number[];
    if (arr.length !== P) {
      throw new ServiceError(
        "INVALID_INPUT",
        "discretization.segments array length must equal the number of pipe segments",
        { segmentsGiven: arr.length, pipeCount: P },
      );
    }
    if (arr.some((n) => !Number.isInteger(n) || n < 1)) {
      throw new ServiceError(
        "INVALID_INPUT",
        "discretization.segments entries must be integers >= 1",
        { segments: arr },
      );
    }
    ns = arr.slice();
    const dts = specs.map((q, s) => q.travelTime / ns[s]);
    dt = dts[0];
    for (let s = 1; s < P; s++) {
      const mismatch = Math.abs(dts[s] - dt) / dt;
      if (mismatch > CONFORM_TOL) {
        throw new ServiceError(
          "GRID_NOT_CONFORMING",
          "per-segment segment counts imply different time steps; a common dt is required (dt_s = L_s/(a_s*N_s) must agree across segments)",
          { segments: ns, timeSteps: dts, badSegment: s, relativeMismatch: mismatch },
        );
      }
    }
    if (hasDt) {
      const dtGiven = disc.timeStep as number;
      const mismatch = Math.abs(dtGiven - dt) / dt;
      if (mismatch > CONFORM_TOL) {
        throw new ServiceError(
          "GRID_NOT_CONFORMING",
          "timeStep is inconsistent with the per-segment segment counts (require L_s/(a_s*N_s) == timeStep for every segment)",
          { timeStep: dtGiven, impliedTimeStep: dt, relativeMismatch: mismatch },
        );
      }
    }
  } else if (hasN) {
    // ---- 标量 N：每段都切 N 段，要求各段行程时间相等 ----
    const N = disc.segments as number;
    if (!Number.isInteger(N) || N < 1) {
      throw new ServiceError(
        "INVALID_INPUT",
        "discretization.segments must be an integer >= 1 (or a per-segment array for multi-segment lines)",
        { segments: N },
      );
    }
    ns = specs.map(() => N);
    dt = specs[0].travelTime / N;
    for (let s = 1; s < P; s++) {
      const dtS = specs[s].travelTime / N;
      const mismatch = Math.abs(dtS - dt) / dt;
      if (mismatch > CONFORM_TOL) {
        throw new ServiceError(
          "GRID_NOT_CONFORMING",
          "a scalar segment count cannot fit all segments: wave travel times L_s/a_s differ, so no common dt exists with equal N_s; use per-segment segment counts or a timeStep",
          {
            segments: N,
            segment: s,
            travelTimes: specs.map((q) => q.travelTime),
            relativeMismatch: mismatch,
          },
        );
      }
    }
    if (hasDt) {
      const dtGiven = disc.timeStep as number;
      const mismatch = Math.abs(dtGiven - dt) / dt;
      if (mismatch > CONFORM_TOL) {
        throw new ServiceError(
          "GRID_NOT_CONFORMING",
          "segments and timeStep are inconsistent with Courant = 1: require N_s * a_s * timeStep == L_s for every segment",
          { segments: N, timeStep: dtGiven, impliedTimeStep: dt, relativeMismatch: mismatch },
        );
      }
    }
  } else {
    // ---- 只给 timeStep：每段 τ_s/dt 必须为整数 ----
    dt = disc.timeStep as number;
    if (!(dt > 0) || !Number.isFinite(dt)) {
      throw new ServiceError(
        "INVALID_INPUT",
        "discretization.timeStep must be a positive number",
        { timeStep: dt },
      );
    }
    ns = specs.map((q, s) => {
      const nReal = q.travelTime / dt;
      const nRound = Math.round(nReal);
      const mismatch = Math.abs(nReal - nRound) / nReal;
      if (nRound < 1 || mismatch > CONFORM_TOL) {
        throw new ServiceError(
          "GRID_NOT_CONFORMING",
          "length / (waveSpeed * timeStep) is not an integer for every segment; the common time step cannot satisfy Courant = 1 along the whole line",
          {
            timeStep: dt,
            badSegment: s,
            length: q.spec.length,
            waveSpeed: q.spec.waveSpeed,
            reachesReal: nReal,
            relativeMismatch: mismatch,
          },
        );
      }
      return nRound;
    });
  }

  // ---- 组装逐段网格与 MOC 系数 ----
  // dx 一律取几何贴格值 L_s/N_s；它在容差内等于 a_s*dt（上面已逐段保证）。
  // 单段时 dt 也回到 dx/a = L/(N*a)，与旧实现逐位一致。
  const runtime: RuntimePipe[] = specs.map((q, s) => {
    const n = ns[s];
    const dx = q.spec.length / n;
    return {
      index: s,
      length: q.spec.length,
      diameter: q.spec.diameter,
      waveSpeed: q.spec.waveSpeed,
      frictionFactor: q.spec.frictionFactor,
      area: q.area,
      segments: n,
      dx,
      travelTime: q.travelTime,
      impedance: q.spec.waveSpeed / (GRAVITY * q.area),
      friction:
        (q.spec.frictionFactor * dx) /
        (2 * GRAVITY * q.spec.diameter * q.area * q.area),
    };
  });

  const dtConforming = P === 1 ? runtime[0].dx / runtime[0].waveSpeed : dt;
  const steps = Math.ceil(duration / dtConforming - 1e-12);
  const totalSegments = ns.reduce((a, b) => a + b, 0);
  const totalLength = pipes.reduce((a, p) => a + p.length, 0);

  const grid: Grid = {
    dt: dtConforming,
    steps,
    courant: 1,
    totalSegments,
    totalLength,
    pipes: runtime.map(stripRuntime),
    segments: totalSegments,
  };
  if (P === 1) grid.dx = runtime[0].dx;
  return { grid, runtime };
}

function stripRuntime(p: RuntimePipe): PipeGrid {
  const { impedance: _imp, friction: _fr, ...grid } = p;
  return grid;
}
