import { describe, expect, it } from "vitest";
import { runSimulation, ServiceError, validateRequest } from "../src/index.js";
import type { PipeSpec, SimulationRequest } from "../src/index.js";

/** 断言求解/校验抛出指定 code 的 ServiceError。 */
function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code);
    return;
  }
  throw new Error(`expected ServiceError(${code}), but nothing was thrown`);
}

function req(pipes: PipeSpec[], disc: SimulationRequest["discretization"]): SimulationRequest {
  return {
    pipes,
    reservoirHead: 100,
    initialVelocity: 0.5,
    closure: { type: "linear", duration: 0 },
    discretization: disc,
    duration: 4,
  };
}

const slow = { diameter: 1.0, waveSpeed: 500, frictionFactor: 0 };
const fast = { diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 };

/**
 * 多段公共时步约束：每段都必须 L_s/(a_s*dt) ∈ ℤ 且共享同一 dt，
 * 凑不出来一律 GRID_NOT_CONFORMING——不做插值、不引入耗散。
 *
 * 取 L1=1250/a1=500 => τ1=2.5 s；L2=1000/a2=1000 => τ2=1.0 s。
 * 公共 dt 必须同时整除 2.5 和 1.0（如 0.1、0.05），
 * 而 0.07 两段都不整除。
 */
describe("多段公共时步网格", () => {
  it("timeStep 使某段 τ_s/dt 非整数 -> GRID_NOT_CONFORMING", () => {
    const r = req(
      [
        { length: 1250, ...slow },
        { length: 1000, ...fast },
      ],
      { timeStep: 0.07 }, // 2.5/0.07=35.71…，1.0/0.07=14.29…
    );
    expectCode(() => runSimulation(validateRequest(r)), "GRID_NOT_CONFORMING");
  });

  it("timeStep 只让一段贴格（另一段不贴）-> GRID_NOT_CONFORMING", () => {
    const r = req(
      [
        { length: 1250, ...slow },
        { length: 1000, ...fast },
      ],
      { timeStep: 0.04 }, // 2.5/0.04=62.5，1.0/0.04=25
    );
    expectCode(() => runSimulation(validateRequest(r)), "GRID_NOT_CONFORMING");
  });

  it("逐段段数导出的 dt 互不重合 -> GRID_NOT_CONFORMING", () => {
    const r = req(
      [
        { length: 1250, ...slow },
        { length: 1000, ...fast },
      ],
      { segments: [25, 20] }, // dt1=0.1, dt2=0.05
    );
    expectCode(() => runSimulation(validateRequest(r)), "GRID_NOT_CONFORMING");
  });

  it("标量 segments 但各段行程时间不等 -> GRID_NOT_CONFORMING", () => {
    const r = req(
      [
        { length: 1250, ...slow },
        { length: 1000, ...fast },
      ],
      { segments: 20 }, // 等 N 要求 τ1=τ2，这里 2.5 ≠ 1.0
    );
    expectCode(() => runSimulation(validateRequest(r)), "GRID_NOT_CONFORMING");
  });

  it("segments 数组长度与管段数不符 -> INVALID_INPUT", () => {
    const r = req(
      [
        { length: 1250, ...slow },
        { length: 1000, ...fast },
      ],
      { segments: [25] },
    );
    expectCode(() => runSimulation(validateRequest(r)), "INVALID_INPUT");
  });

  it("公共 dt 同时整除两段 -> 正常推进，各段严格贴格", () => {
    const r = req(
      [
        { length: 1250, ...slow },
        { length: 1000, ...fast },
      ],
      { timeStep: 0.05 }, // N1=50, N2=20
    );
    const res = runSimulation(validateRequest(r));
    expect(res.grid.dt).toBeCloseTo(0.05, 12);
    expect(res.grid.pipes[0].segments).toBe(50);
    expect(res.grid.pipes[1].segments).toBe(20);
    expect(res.grid.pipes[0].dx).toBeCloseTo(500 * 0.05, 12);
    expect(res.grid.pipes[1].dx).toBeCloseTo(1000 * 0.05, 12);
  });

  it("逐段段数导出同一 dt -> 正常推进", () => {
    const r = req(
      [
        { length: 1250, ...slow },
        { length: 1000, ...fast },
      ],
      { segments: [25, 10] }, // dt1=0.1, dt2=0.1
    );
    const res = runSimulation(validateRequest(r));
    expect(res.grid.dt).toBeCloseTo(0.1, 12);
    expect(res.grid.pipes[0].segments).toBe(25);
    expect(res.grid.pipes[1].segments).toBe(10);
  });

  it("逐段段数与 timeStep 同给但自相矛盾 -> GRID_NOT_CONFORMING", () => {
    const r = req(
      [
        { length: 1250, ...slow },
        { length: 1000, ...fast },
      ],
      { segments: [25, 10], timeStep: 0.05 },
    );
    expectCode(() => runSimulation(validateRequest(r)), "GRID_NOT_CONFORMING");
  });

  it("三段串联，公共 dt 三段全贴格才放行", () => {
    const r = req(
      [
        { length: 900, diameter: 0.6, waveSpeed: 600, frictionFactor: 0 }, // τ=1.5
        { length: 1000, ...fast }, // τ=1.0
        { length: 500, diameter: 0.8, waveSpeed: 250, frictionFactor: 0 }, // τ=2.0
      ],
      { timeStep: 0.1 }, // 1.5/0.1=15, 1.0/0.1=10, 2.0/0.1=20
    );
    const res = runSimulation(validateRequest(r));
    expect(res.grid.pipes.map((p) => p.segments)).toEqual([15, 10, 20]);
  });
});

describe("多段输入校验", () => {
  it("pipe 与 pipes 同时给出 -> INVALID_INPUT", () => {
    const r = {
      pipe: { length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 },
      pipes: [{ length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 }],
      reservoirHead: 50,
      initialVelocity: 1,
      closure: { type: "linear", duration: 0 },
      discretization: { segments: [1] },
      duration: 4,
    } as unknown as SimulationRequest;
    expectCode(() => validateRequest(r), "INVALID_INPUT");
  });

  it("pipes 为空数组 / 含非法管段 -> INVALID_INPUT", () => {
    expectCode(
      () => validateRequest(req([], { segments: [] })),
      "INVALID_INPUT",
    );
    const r = req(
      [{ length: -1, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 }],
      { segments: [1] },
    );
    expectCode(() => validateRequest(r), "INVALID_INPUT");
  });

  it("旧的单段 pipe 请求仍被接受并归一成一段序列", () => {
    const v = validateRequest({
      pipe: { length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 },
      reservoirHead: 50,
      initialVelocity: 1,
      closure: { type: "linear", duration: 0 },
      discretization: { segments: 20 },
      duration: 4,
    });
    expect(v.pipes).toHaveLength(1);
    expect(v.pipes[0].length).toBe(1000);
  });
});
