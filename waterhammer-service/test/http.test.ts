import { describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { baseRequest, JOUKOWSKY } from "./helpers.js";

describe("HTTP 层", () => {
  it("POST /simulate 返回阀门序列、摘要与末态", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/simulate",
      payload: baseRequest(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.grid.courant).toBe(1);
    expect(body.valve.time.length).toBe(body.valve.head.length);
    expect(body.summary.peakHead).toBeGreaterThan(body.summary.initialValveHead);
    expect(Math.abs(body.summary.peakHeadRise - JOUKOWSKY) / JOUKOWSKY).toBeLessThan(1e-6);
    expect(body.summary.observedRoundTripPeriod).toBeCloseTo(4, 1);
    expect(body.finalState.head.length).toBe(body.grid.segments + 1);
    expect(body.finalState.flow.length).toBe(body.grid.segments + 1);
    await app.close();
  });

  it("非法参数 -> 400 + 结构化错误 INVALID_INPUT", async () => {
    const app = buildApp();
    const payload = baseRequest();
    payload.pipe.waveSpeed = -5;
    const res = await app.inject({ method: "POST", url: "/simulate", payload });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(typeof body.error.message).toBe("string");
    await app.close();
  });

  it("网格不贴格 -> 400 + 结构化错误 GRID_NOT_CONFORMING", async () => {
    const app = buildApp();
    const payload = baseRequest();
    payload.discretization = { timeStep: 0.07 };
    const res = await app.inject({ method: "POST", url: "/simulate", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("GRID_NOT_CONFORMING");
    await app.close();
  });

  it("步数超限 -> 400 + 结构化错误 STEPS_EXCEEDED", async () => {
    const app = buildApp();
    const payload = baseRequest();
    payload.maxSteps = 5;
    const res = await app.inject({ method: "POST", url: "/simulate", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("STEPS_EXCEEDED");
    await app.close();
  });

  it("GET /health", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("多段请求：返回逐段网格与连接点序列，单段响应形状不变", async () => {
    const app = buildApp();
    const payload = {
      pipes: [
        { length: 1250, diameter: 1.0, waveSpeed: 500, frictionFactor: 0 },
        { length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 },
      ],
      reservoirHead: 100,
      initialVelocity: 0.5,
      closure: { type: "linear", duration: 0 },
      discretization: { segments: [25, 10] },
      duration: 8,
    };
    const res = await app.inject({ method: "POST", url: "/simulate", payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 多段网格：公共时步 + 总长 + 两段各自分段
    expect(body.grid.dt).toBeCloseTo(0.1, 10);
    expect(body.grid.totalLength).toBe(2250);
    expect(body.grid.totalSegments).toBe(35);
    expect(body.grid.pipes).toHaveLength(2);
    expect(body.grid.pipes[0].segments).toBe(25);
    expect(body.grid.pipes[1].segments).toBe(10);
    // 一个内部连接点，水头序列与时间等长
    expect(body.junctions).toHaveLength(1);
    expect(body.junctions[0].x).toBeCloseTo(1250, 9);
    expect(body.junctions[0].head.length).toBe(body.junctions[0].time.length);
    // 末态节点数 = 25+10+1
    expect(body.finalState.x.length).toBe(36);
    await app.close();

    // 单段响应保持旧形状：无 totalLength / pipes / junctions
    const app2 = buildApp();
    const single = await app2.inject({
      method: "POST",
      url: "/simulate",
      payload: baseRequest(),
    });
    const sb = single.json();
    expect(sb.grid).toEqual({
      segments: 20,
      dx: 50,
      dt: 0.05,
      steps: 200,
      courant: 1,
    });
    expect(sb.junctions).toEqual([]);
    expect(sb.grid.totalLength).toBeUndefined();
    expect(sb.grid.pipes).toBeUndefined();
    await app2.close();
  });

  it("多段凑不出公共时步 -> 400 GRID_NOT_CONFORMING", async () => {
    const app = buildApp();
    const payload = {
      pipes: [
        { length: 1250, diameter: 1.0, waveSpeed: 500, frictionFactor: 0 },
        { length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 },
      ],
      reservoirHead: 100,
      initialVelocity: 0.5,
      closure: { type: "linear", duration: 0 },
      discretization: { timeStep: 0.07 },
      duration: 4,
    };
    const res = await app.inject({ method: "POST", url: "/simulate", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("GRID_NOT_CONFORMING");
    await app.close();
  });
});
