import { describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import type { SimulationRequest } from "../src/index.js";

/**
 * 两段异波速串联的 HTTP 端到端：
 * 粗慢管（L=250, D=1.0, a=500）接细快管（L=150, D=0.5, a=1000），
 * 公共 dt=0.005（N1=100, N2=30），连接点位于 x=250。
 */
function twoSegmentRequest(): SimulationRequest {
  return {
    pipes: [
      { length: 250, diameter: 1.0, waveSpeed: 500, frictionFactor: 0 },
      { length: 150, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 },
    ],
    reservoirHead: 100,
    initialVelocity: 1,
    closure: { type: "linear", duration: 0 },
    discretization: { segments: [100, 30] },
    duration: 1.4,
  };
}

describe("HTTP 层：多段串联", () => {
  it("POST /simulate 返回 perSegment 网格与 junctions 序列", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/simulate",
      payload: twoSegmentRequest(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.grid.dt).toBeCloseTo(0.005, 14);
    expect(body.grid.segments).toBe(130);
    expect(body.grid.courant).toBe(1);
    expect(body.grid.perSegment).toHaveLength(2);
    expect(body.grid.perSegment[0]).toMatchObject({ segments: 100, waveSpeed: 500 });
    expect(body.grid.perSegment[1]).toMatchObject({ segments: 30, waveSpeed: 1000 });
    // 多段响应不出现单段标量 dx
    expect(body.grid.dx).toBeUndefined();

    expect(body.junctions).toHaveLength(1);
    expect(body.junctions[0].x).toBeCloseTo(250, 12);
    expect(body.junctions[0].time.length).toBe(body.junctions[0].head.length);
    // 末态节点总数 = ΣN_k + 1 = 131（内部连接点只存一次）
    expect(body.finalState.head.length).toBe(131);
    expect(body.finalState.x[100]).toBeCloseTo(250, 10);
    await app.close();
  });

  it("公共时步凑不出 -> 400 GRID_NOT_CONFORMING", async () => {
    const app = buildApp();
    const payload = twoSegmentRequest();
    payload.discretization = { timeStep: 0.1 }; // 150/(1000*0.1) = 1.5 非整数
    const res = await app.inject({ method: "POST", url: "/simulate", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("GRID_NOT_CONFORMING");
    await app.close();
  });

  it("pipe 与 pipes 同时给出 -> 400 INVALID_INPUT", async () => {
    const app = buildApp();
    const payload = twoSegmentRequest() as unknown as Record<string, unknown>;
    payload.pipe = { length: 1, diameter: 1, waveSpeed: 1, frictionFactor: 0 };
    const res = await app.inject({ method: "POST", url: "/simulate", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_INPUT");
    await app.close();
  });

  it("只给 timeStep 且两段都贴格 -> 正常，段数自动推出", async () => {
    const app = buildApp();
    const payload = twoSegmentRequest();
    payload.discretization = { timeStep: 0.005 };
    const res = await app.inject({ method: "POST", url: "/simulate", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.grid.perSegment[0].segments).toBe(100);
    expect(body.grid.perSegment[1].segments).toBe(30);
    await app.close();
  });
});
