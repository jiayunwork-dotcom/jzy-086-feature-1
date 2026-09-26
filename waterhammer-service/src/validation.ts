import { ServiceError } from "./errors.js";
import type { PipeSpec, SimulationRequest, ValidatedRequest } from "./types.js";

/** 推进步数缺省上限：超过即报 STEPS_EXCEEDED，防止失控循环。 */
export const DEFAULT_MAX_STEPS = 200_000;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new ServiceError("INVALID_INPUT", message, details);
}

/** 校验单根管段的几何/物性。 */
function validatePipe(pipe: unknown, label: string): PipeSpec {
  if (typeof pipe !== "object" || pipe === null) fail(`${label} is required`);
  const { length, diameter, waveSpeed, frictionFactor } = pipe as PipeSpec;
  if (!isFiniteNumber(length) || length <= 0) fail(`${label}.length must be a positive number`, { length });
  if (!isFiniteNumber(diameter) || diameter <= 0) fail(`${label}.diameter must be a positive number`, { diameter });
  if (!isFiniteNumber(waveSpeed) || waveSpeed <= 0) fail(`${label}.waveSpeed must be a positive number`, { waveSpeed });
  if (!isFiniteNumber(frictionFactor) || frictionFactor < 0) {
    fail(`${label}.frictionFactor must be a non-negative number`, { frictionFactor });
  }
  return { length, diameter, waveSpeed, frictionFactor };
}

/**
 * 输入校验。以下情况一律判非法（INVALID_INPUT）：
 * - 波速、管长、管径非正，摩阻系数为负（逐段检查）；
 * - pipe 与 pipes 同时给出、两者都缺、或 pipes 不是非空有序序列；
 * - 关闭历时为负（或分段折线非法）；
 * - 缺水库水头或初始流速；
 * - 仿真时长非正、maxSteps 非正。
 * 网格贴格与否由 grid.ts 单独判定（GRID_NOT_CONFORMING）。
 *
 * 单段写法（pipe）在归一化阶段吸收为「只有一段的 pipes 序列」，
 * 求解器此后只见有序管段序列，保证两条路径数值一致。
 */
export function validateRequest(raw: unknown): ValidatedRequest {
  if (typeof raw !== "object" || raw === null) {
    fail("request body must be a JSON object");
  }
  const req = raw as Partial<SimulationRequest>;

  // ---- 管段：单段 pipe 与多段 pipes 二选一 ----
  const hasPipe = req.pipe !== undefined;
  const hasPipes = req.pipes !== undefined;
  if (hasPipe && hasPipes) {
    fail("provide either pipe (single segment) or pipes (ordered series), not both");
  }
  let pipes: PipeSpec[];
  if (hasPipes) {
    if (!Array.isArray(req.pipes) || req.pipes.length === 0) {
      fail("pipes must be a non-empty ordered array of pipe segments");
    }
    pipes = req.pipes.map((p, k) => validatePipe(p, `pipes[${k}]`));
  } else if (hasPipe) {
    pipes = [validatePipe(req.pipe, "pipe")];
  } else {
    fail("pipe (single segment) or pipes (ordered series) is required");
  }

  // ---- 水库水头 / 初始流速（缺失即非法） ----
  if (!isFiniteNumber(req.reservoirHead)) fail("reservoirHead is required and must be a finite number");
  if (!isFiniteNumber(req.initialVelocity)) fail("initialVelocity is required and must be a finite number");

  // ---- 关闭规律 ----
  const closure = req.closure;
  if (typeof closure !== "object" || closure === null) fail("closure is required");
  if (closure!.type === "linear") {
    const d = (closure as { duration?: unknown }).duration;
    if (!isFiniteNumber(d)) fail("closure.duration is required and must be a finite number");
    if (d < 0) fail("closure.duration must be >= 0", { duration: d });
  } else if (closure!.type === "piecewise") {
    const points = (closure as { points?: unknown }).points;
    if (!Array.isArray(points) || points.length === 0) {
      fail("closure.points must be a non-empty array for piecewise closure");
    }
    let prevTime = -Infinity;
    for (const p of points) {
      if (typeof p !== "object" || p === null) fail("closure.points entries must be objects");
      const { time, opening } = p as { time?: unknown; opening?: unknown };
      if (!isFiniteNumber(time) || time < 0) fail("closure point time must be a finite number >= 0", { time });
      if (!isFiniteNumber(opening) || opening < 0 || opening > 1) {
        fail("closure point opening must be within [0, 1]", { opening });
      }
      if (time < prevTime) fail("closure points must be ordered by non-decreasing time");
      prevTime = time;
    }
  } else {
    fail("closure.type must be 'linear' or 'piecewise'", { type: (closure as { type?: unknown }).type });
  }

  // ---- 离散参数（存在性/基本合法；公共时步贴格判定在 grid.ts） ----
  const disc = req.discretization;
  if (typeof disc !== "object" || disc === null) {
    fail("discretization is required (segments and/or timeStep)");
  }
  const d = disc!;
  if (d.segments === undefined && d.timeStep === undefined) {
    fail("discretization requires at least one of segments / timeStep");
  }
  if (d.segments !== undefined) {
    if (typeof d.segments === "number") {
      // 标量写法只对单段主线合法（沿用历史单段请求格式）
      if (pipes.length !== 1) {
        fail("discretization.segments must be an array with one integer per pipe segment", {
          segments: d.segments,
        });
      }
      if (!Number.isInteger(d.segments) || d.segments < 1) {
        fail("discretization.segments must be an integer >= 1", { segments: d.segments });
      }
    } else if (Array.isArray(d.segments)) {
      if (d.segments.length !== pipes.length) {
        fail("discretization.segments length must match the number of pipe segments", {
          given: d.segments.length,
          expected: pipes.length,
        });
      }
      for (const n of d.segments) {
        if (!Number.isInteger(n) || n < 1) {
          fail("every discretization.segments entry must be an integer >= 1", { segments: d.segments });
        }
      }
    } else {
      fail("discretization.segments must be an integer or an integer array", { segments: d.segments });
    }
  }
  if (d.timeStep !== undefined && (!isFiniteNumber(d.timeStep) || d.timeStep <= 0)) {
    fail("discretization.timeStep must be a positive number", { timeStep: d.timeStep });
  }

  // ---- 仿真时长与步数上限 ----
  if (!isFiniteNumber(req.duration) || req.duration <= 0) {
    fail("duration must be a positive number", { duration: req.duration });
  }
  const maxSteps = req.maxSteps ?? DEFAULT_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    fail("maxSteps must be an integer >= 1", { maxSteps: req.maxSteps });
  }

  return {
    pipes,
    reservoirHead: req.reservoirHead,
    initialVelocity: req.initialVelocity,
    closure: closure as ValidatedRequest["closure"],
    discretization: d as ValidatedRequest["discretization"],
    duration: req.duration,
    maxSteps,
  };
}
