import { ServiceError } from "./errors.js";
import type { DiscretizationSpec, Grid, PipeSpec, SegmentGrid } from "./types.js";

/**
 * 多段串联主线的贴格判定容差：
 *  - L_k/(a_k*dt) 与整数的相对偏差；
 *  - 各段各自导出的公共 dt 之间的相对展宽。
 */
const CONFORM_TOL = 1e-6;

function roundToInteger(value: number): { ok: boolean; n: number } {
  const n = Math.round(value);
  const mismatch = Math.abs(value - n) / value;
  return { ok: n >= 1 && mismatch <= CONFORM_TOL, n };
}

/**
 * 为多段串联主线构造自洽网格。
 *
 * 特征线法要求全场库朗数恰为 1，即每段都满足 dx_k = a_k·dt，而整条主线
 * 必须共享同一个时间步长 dt。因此段数 N_k 与公共 dt 必须同时满足
 *
 *     dt = L_k / (N_k · a_k)        （对每一段 k）
 *
 * 三种入口：
 *  1. 只给段数序列 {segments:[N_k]}：各段导出 dt_k = L_k/(N_k·a_k)，
 *     要求所有 dt_k 在 CONFORM_TOL 内彼此相等，否则 GRID_NOT_CONFORMING；
 *  2. 只给 {timeStep: dt}：要求每个 L_k/(a_k·dt) 都是整数，否则报错；
 *  3. 两者都给：每段都要求 N_k·a_k·dt == L_k，否则报错。
 *
 * 单段是「只有一段的序列」的特例：数值路径与历史单段实现逐位一致
 * （只给段数时 dt 严格取 dx/a，只给时步时贴格后也回写为 dx/a）。
 * 凑不出公共时步时绝不插值、绝不硬推。
 */
export function buildGrid(
  pipes: PipeSpec[],
  disc: DiscretizationSpec,
  duration: number,
): Grid {
  const hasSegments = disc.segments !== undefined;
  const hasDt = disc.timeStep !== undefined;
  if (!hasSegments && !hasDt) {
    throw new ServiceError(
      "INVALID_INPUT",
      "discretization requires at least one of segments / timeStep",
    );
  }
  if (hasDt && (!(disc.timeStep! > 0) || !Number.isFinite(disc.timeStep!))) {
    throw new ServiceError("INVALID_INPUT", "discretization.timeStep must be a positive number", {
      timeStep: disc.timeStep,
    });
  }

  const m = pipes.length;

  // ---- 归一化段数序列：单段允许历史标量写法 ----
  let segmentCounts: number[] | null = null;
  if (hasSegments) {
    const raw = disc.segments;
    const list = typeof raw === "number" ? [raw] : raw;
    if (!Array.isArray(list) || list.length !== m) {
      throw new ServiceError(
        "INVALID_INPUT",
        "discretization.segments must be an integer array with one entry per pipe segment",
        { given: raw, segmentCount: m },
      );
    }
    for (const n of list) {
      if (!Number.isInteger(n) || n < 1) {
        throw new ServiceError(
          "INVALID_INPUT",
          "every discretization.segments entry must be an integer >= 1",
          { segments: list },
        );
      }
    }
    segmentCounts = list as number[];
  }

  const dtGiven = hasDt ? (disc.timeStep as number) : null;

  // ---- 情形一：只给段数序列，求公共 dt ----
  if (segmentCounts !== null && dtGiven === null) {
    const dtPerSegment = pipes.map((p, k) => p.length / (segmentCounts![k] * p.waveSpeed));
    const dtRef = dtPerSegment[0];
    for (let k = 1; k < m; k++) {
      const spread = Math.abs(dtPerSegment[k] - dtRef) / dtRef;
      if (spread > CONFORM_TOL) {
        throw new ServiceError(
          "GRID_NOT_CONFORMING",
          "per-segment lengths L_k/(N_k*a_k) do not agree on one common time step; " +
            "multi-segment mainline requires a shared dt with Courant = 1 on every segment",
          {
            segmentTimeSteps: dtPerSegment,
            segmentIndex: k,
            relativeSpread: spread,
            tolerance: CONFORM_TOL,
          },
        );
      }
    }
    return assembleGrid(pipes, segmentCounts, dtRef, duration);
  }

  // ---- 情形二/三：给定公共 dt，逐段要求 L_k/(a_k*dt) 为整数 ----
  const dt = dtGiven as number;
  const counts: number[] = [];
  for (let k = 0; k < m; k++) {
    const p = pipes[k];
    const nReal = p.length / (p.waveSpeed * dt);
    const { ok, n } = roundToInteger(nReal);
    if (!ok) {
      throw new ServiceError(
        "GRID_NOT_CONFORMING",
        "length / (waveSpeed * timeStep) is not an integer on segment " +
          `${k}: the shared time step cannot satisfy Courant = 1 on every segment`,
        {
          segmentIndex: k,
          timeStep: dt,
          waveSpeed: p.waveSpeed,
          length: p.length,
          reachesReal: nReal,
          tolerance: CONFORM_TOL,
        },
      );
    }
    // 情形三：段数也显式给出时必须与贴格整数一致
    if (segmentCounts !== null && segmentCounts[k] !== n) {
      throw new ServiceError(
        "GRID_NOT_CONFORMING",
        `segments[${k}] is inconsistent with timeStep and that segment's length/waveSpeed: ` +
          `require N_${k} * waveSpeed_${k} * timeStep == length_${k}`,
        {
          segmentIndex: k,
          givenSegments: segmentCounts[k],
          conformingSegments: n,
          timeStep: dt,
        },
      );
    }
    counts.push(n);
  }

  // 单段历史路径里 dt 回写为严格的 dx/a；多段时以各段 dx_k/a_k 的均值为
  // 公共 dt（它们在容差内相等），避免把某一段的舍入误差固定进全程。
  const dtConforming =
    m === 1
      ? (pipes[0].length / counts[0]) / pipes[0].waveSpeed
      : counts.reduce((s, n, k) => s + pipes[k].length / (n * pipes[k].waveSpeed), 0) / m;

  return assembleGrid(pipes, counts, dtConforming, duration);
}

/** 由段数序列与公共 dt 组装最终网格。 */
function assembleGrid(
  pipes: PipeSpec[],
  counts: number[],
  dt: number,
  duration: number,
): Grid {
  const perSegment: SegmentGrid[] = pipes.map((p, k) => ({
    segments: counts[k],
    dx: p.length / counts[k],
    waveSpeed: p.waveSpeed,
    travelTime: p.length / p.waveSpeed,
  }));
  const steps = Math.ceil(duration / dt - 1e-12);
  return {
    segments: counts.reduce((s, n) => s + n, 0),
    dx: perSegment.map((g) => g.dx),
    dt,
    steps,
    perSegment,
  };
}
