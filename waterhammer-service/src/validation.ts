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

/** 校验单根管段的几何/物性，返回带序号前缀的错误信息。 */
function validatePipe(pipe: unknown, label: string): PipeSpec {
  if (typeof pipe !== "object" || pipe === null) fail(`${label} must be an object`);
  const p = pipe as Partial<PipeSpec>;
  if (!isFiniteNumber(p.length) || p.length <= 0) {
    fail(`${label}.length must be a positive number`, { length: p.length });
  }
  if (!isFiniteNumber(p.diameter) || p.diameter <= 0) {
    fail(`${label}.diameter must be a positive number`, { diameter: p.diameter });
  }
  if (!isFiniteNumber(p.waveSpeed) || p.waveSpeed <= 0) {
    fail(`${label}.waveSpeed must be a positive number`, { waveSpeed: p.waveSpeed });
  }
  if (!isFiniteNumber(p.frictionFactor) || p.frictionFactor < 0) {
    fail(`${label}.frictionFactor must be a non-negative number`, {
      frictionFactor: p.frictionFactor,
    });
  }
  return {
    length: p.length,
    diameter: p.diameter,
    waveSpeed: p.waveSpeed,
    frictionFactor: p.frictionFactor,
  };
}

/**
 * 输入校验。以下情况一律判非法（INVALID_INPUT）：
 * - pipe 与 pipes 同时给出、或两者都不给；pipes 为空；
 * - 任一段波速、管长、管径非正，摩阻系数为负；
 * - 关闭历时为负（或分段折线非法）；
 * - 缺水库水头或初始流速；
 * - 仿真时长非正、maxSteps 非正；
 * - segments 数组长度与管段数不符。
 * 网格能否凑出全线公共时步由 grid.ts 单独判定（GRID_NOT_CONFORMING）。
 */
export function validateRequest(raw: unknown): ValidatedRequest {
  if (typeof raw !== "object" || raw === null) {
    fail("request body must be a JSON object");
  }
  const req = raw as Partial<SimulationRequest>;

  // ---- 管段序列：pipe（单段旧写法）与 pipes（多段新写法）互斥 ----
  const hasPipe = req.pipe !== undefined;
  const hasPipes = req.pipes !== undefined;
  if (hasPipe && hasPipes) {
    fail("provide either pipe (single segment) or pipes (ordered segment sequence), not both");
  }
  if (!hasPipe && !hasPipes) {
    fail("pipes is required (or pipe for the legacy single-segment request)");
  }
  let pipes: PipeSpec[];
  if (hasPipes) {
    if (!Array.isArray(req.pipes) || req.pipes.length === 0) {
      fail("pipes must be a non-empty ordered array of pipe segments");
    }
    pipes = req.pipes!.map((p, s) => validatePipe(p, `pipes[${s}]`));
  } else {
    pipes = [validatePipe(req.pipe, "pipe")];
  }

  // ---- 水库水头 / 初始流速（缺失即非法） ----
  if (!isFiniteNumber(req.reservoirHead)) {
    fail("reservoirHead is required and must be a finite number");
  }
  if (!isFiniteNumber(req.initialVelocity)) {
    fail("initialVelocity is required and must be a finite number");
  }
  if (req.initialVelocity < 0) {
    fail("initialVelocity must be >= 0", { initialVelocity: req.initialVelocity });
  }

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
      if (!isFiniteNumber(time) || time < 0) {
        fail("closure point time must be a finite number >= 0", { time });
      }
      if (!isFiniteNumber(opening) || opening < 0 || opening > 1) {
        fail("closure point opening must be within [0, 1]", { opening });
      }
      if (time < prevTime) fail("closure points must be ordered by non-decreasing time");
      prevTime = time;
    }
  } else {
    fail("closure.type must be 'linear' or 'piecewise'", {
      type: (closure as { type?: unknown }).type,
    });
  }

  // ---- 离散参数（存在性/基本合法；公共时步贴格判定在 grid.ts） ----
  const disc = req.discretization;
  if (typeof disc !== "object" || disc === null) {
    fail("discretization is required (segments and/or timeStep)");
  }
  const segments = disc!.segments;
  const timeStep = disc!.timeStep;
  if (segments === undefined && timeStep === undefined) {
    fail("discretization requires at least one of segments / timeStep");
  }
  if (segments !== undefined) {
    if (Array.isArray(segments)) {
      if (segments.some((n) => !Number.isInteger(n) || n < 1)) {
        fail("discretization.segments entries must be integers >= 1", { segments });
      }
      if (segments.length !== pipes.length) {
        fail(
          "discretization.segments array length must equal the number of pipe segments",
          { segmentsGiven: segments.length, pipeCount: pipes.length },
        );
      }
    } else if (!Number.isInteger(segments) || segments < 1) {
      fail(
        "discretization.segments must be an integer >= 1 (or an array with one count per segment)",
        { segments },
      );
    }
  }
  if (timeStep !== undefined && (!isFiniteNumber(timeStep) || timeStep <= 0)) {
    fail("discretization.timeStep must be a positive number", { timeStep });
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
    closure: req.closure!,
    discretization: {
      segments: disc!.segments,
      timeStep: disc!.timeStep,
    },
    duration: req.duration,
    maxSteps,
  };
}
