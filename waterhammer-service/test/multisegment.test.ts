import { describe, expect, it } from "vitest";
import { GRAVITY, runSimulation, summarize, validateRequest } from "../src/index.js";
import type { PipeSpec, SimulationRequest } from "../src/index.js";

/** 构造多段请求的小工具。 */
function multiRequest(
  pipes: PipeSpec[],
  opts: Partial<SimulationRequest> = {},
): SimulationRequest {
  return {
    pipes,
    reservoirHead: 50,
    initialVelocity: 1,
    closure: { type: "linear", duration: 0 },
    discretization: { segments: [1] },
    duration: 10,
    ...opts,
  };
}

/**
 * 判据一：本可写成单段的主线，人为切成两段等参数子段串联，
 * 阀门峰值与末态（以及完整阀门水头序列、连接点序列）必须在容差内一致，
 * 证明无损连接点不引入伪反射。
 */
describe("多段：等参数切分与单管严格等价（连接点无伪反射）", () => {
  const common = {
    diameter: 0.5,
    waveSpeed: 1000,
    frictionFactor: 0.02,
  };

  const single = () =>
    runSimulation(
      validateRequest({
        pipe: { length: 1000, ...common },
        reservoirHead: 50,
        initialVelocity: 1,
        closure: { type: "linear", duration: 0 },
        discretization: { timeStep: 0.05 }, // N=20
        duration: 12,
      }),
    );

  const split = () =>
    runSimulation(
      validateRequest(
        multiRequest(
          [
            { length: 600, ...common },
            { length: 400, ...common },
          ],
          {
            reservoirHead: 50,
            initialVelocity: 1,
            closure: { type: "linear", duration: 0 },
            discretization: { segments: [12, 8] }, // 同一公共 dt=0.05
            duration: 12,
          },
        ),
      ),
    );

  it("阀门水头完整序列长度一致、时间网格一致（相对容差 1e-12），水头逐点 < 1e-9 m", () => {
    const a = single();
    const b = split();
    expect(b.valve.time.length).toBe(a.valve.time.length);
    for (let i = 0; i < a.valve.time.length; i++) {
      expect(Math.abs(b.valve.time[i] - a.valve.time[i])).toBeLessThan(1e-12);
    }
    let maxDiff = 0;
    for (let i = 0; i < a.valve.head.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a.valve.head[i] - b.valve.head[i]));
    }
    expect(maxDiff).toBeLessThan(1e-9);
  });

  it("峰值、峰值时刻、末态阀门水头一致（容差 1e-9）", () => {
    const sa = summarize(single());
    const sb = summarize(split());
    expect(Math.abs(sb.peakHead - sa.peakHead)).toBeLessThan(1e-9);
    expect(Math.abs(sb.peakTime - sa.peakTime)).toBeLessThan(1e-9);
    const fa = single().valve.head.at(-1)!;
    const fb = split().valve.head.at(-1)!;
    expect(Math.abs(fb - fa)).toBeLessThan(1e-9);
  });

  it("连接点水头序列 = 单管 x=600 节点（node 12），且里程/初态正确", () => {
    const a = single();
    const b = split();
    const j = b.junctions[0];
    expect(j.x).toBeCloseTo(600, 9);
    expect(b.finalState.x.length).toBe(21); // 12+8 段 => 21 个唯一节点
    const node12 = 12;
    expect(b.finalState.x[node12]).toBeCloseTo(600, 9);
    expect(Math.abs(b.finalState.head[node12] - a.finalState.head[node12])).toBeLessThan(1e-9);
    expect(Math.abs(j.head.at(-1)! - a.finalState.head[node12])).toBeLessThan(1e-9);
    // 初始稳态连接点头 = 50 - f*600*V^2/(2gD)
    const h600 = 50 - (0.02 * 600 * 1) / (2 * GRAVITY * 0.5);
    expect(j.head[0]).toBeCloseTo(h600, 9);
  });

  it("两种写法的末态全线 H、Q 逐节点一致（容差 1e-9）", () => {
    const a = single();
    const b = split();
    expect(b.finalState.x.length).toBe(a.finalState.x.length);
    for (let i = 0; i < a.finalState.x.length; i++) {
      expect(Math.abs(b.finalState.x[i] - a.finalState.x[i])).toBeLessThan(1e-9);
      expect(Math.abs(b.finalState.head[i] - a.finalState.head[i])).toBeLessThan(1e-9);
      expect(Math.abs(b.finalState.flow[i] - a.finalState.flow[i])).toBeLessThan(1e-9);
    }
  });
});

/**
 * 判据二：粗慢管（D1=1, a1=500, B1）接细快管（D2=0.5, a2=1000, B2），
 * B2/B1 = a2 A1/(a1 A2) = 8。无摩阻、瞬时关闭，MOC 对该问题精确，
 * 故容差放到 1e-9（相对）。
 *
 * 事件时序（dt=0.1）：
 *  - n=1 阀门采到全关，升压 Δ = B2|Q0|；波在细快管走 10 步，
 *    t=1.1 到连接点（自细快侧向粗慢侧入射）；
 *  - 压力透射到粗慢管：ΔH_j = 2B1/(B1+B2)·Δ = (2/9)Δ；
 *  - 反射回细快管并在 t=2.1 回到阀门（波幅 -7/9·Δ），封闭端压力再反射翻倍，
 *    阀门水头总跳变 -14/9·Δ；
 *  - 透射波在粗慢管走到水库（25 步）反号，再下行，t=6.1 回到连接点
 *    （自粗慢侧向细快侧入射）：在 pipe1 的黎曼变量分解中，
 *    上行反射波幅/下行入射波幅 = +7/9，即 (B2-B1)/(B2+B1)。
 */
describe("多段：异波速连接点的部分反射与透射", () => {
  const D1 = 1.0;
  const a1 = 500;
  const D2 = 0.5;
  const a2 = 1000;
  const V0 = 0.5;
  const Hres = 100;
  const dt = 0.1;

  const setup = () => {
    const res = runSimulation(
      validateRequest(
        multiRequest(
          [
            { length: 1250, diameter: D1, waveSpeed: a1, frictionFactor: 0 }, // τ1=2.5 s
            { length: 1000, diameter: D2, waveSpeed: a2, frictionFactor: 0 }, // τ2=1.0 s
          ],
          {
            reservoirHead: Hres,
            initialVelocity: V0,
            discretization: { segments: [25, 10] }, // 公共 dt=0.1
            duration: 8,
          },
        ),
      ),
    );
    const A1 = (Math.PI / 4) * D1 ** 2;
    const A2 = (Math.PI / 4) * D2 ** 2;
    const B1 = a1 / (GRAVITY * A1);
    const B2 = a2 / (GRAVITY * A2);
    const Q0 = V0 * A1;
    return { res, B1, B2, Q0 };
  };

  it("阻抗比 B2/B1 = 8", () => {
    const { B1, B2 } = setup();
    expect(Math.abs(B2 / B1 - 8) / 8).toBeLessThan(1e-12);
  });

  it("细快→粗慢：连接点压力透射阶跃 = 2B1/(B1+B2)·B2|Q0|（容差 1e-9）", () => {
    const { res, B1, B2, Q0 } = setup();
    const j = res.junctions[0];
    const idx = (t: number) => j.time.findIndex((x) => Math.abs(x - t) < 1e-9);
    const delta = B2 * Math.abs(Q0);
    const dH = j.head[idx(1.1)] - j.head[idx(1.0)];
    const T = (2 * B1) / (B1 + B2); // = 2/9
    expect(Math.abs(dH - T * delta) / delta).toBeLessThan(1e-9);
    expect(dH).toBeGreaterThan(0); // 升压透射，符号为正
  });

  it("细快→粗慢：反射波 t=2.1 回到阀门，封闭端压力反射再翻倍（总跳变 -14/9·Δ，容差 1e-9）", () => {
    const { res, B2, Q0 } = setup();
    const { time, head } = res.valve;
    const idx = (t: number) => time.findIndex((x) => Math.abs(x - t) < 1e-9);
    const delta = B2 * Math.abs(Q0);
    const dH = head[idx(2.1)] - head[idx(2.0)];
    // 连接点产生的反射压力波幅为 R·Δ = -7/9·Δ；该波回到封闭阀门端时，
    // 端边界 Q=0 使压力再反射一次（压力系数 +1，幅度翻倍），故阀门总跳变 -14/9·Δ。
    expect(Math.abs(dH - (-(14 / 9)) * delta) / delta).toBeLessThan(1e-9);
  });

  it("粗慢→细快：水库反号波 t=6.1 到连接点，反射系数 +7/9（容差 1e-9）", () => {
    const { res, B1, B2, Q0 } = setup();
    const j = res.junctions[0];
    const idx = (t: number) => j.time.findIndex((x) => Math.abs(x - t) < 1e-9);
    // pipe1 黎曼变量：下行(往阀门) w+ = (H+B1 Q)/2，上行(往水库) w- = (H-B1 Q)/2
    const wp = (i: number) => (j.head[i] + B1 * j.flow[i]) / 2;
    const wm = (i: number) => (j.head[i] - B1 * j.flow[i]) / 2;
    const iBefore = idx(6.0);
    const iAfter = idx(6.1);
    const dIncident = wp(iAfter) - wp(iBefore);
    const dReflected = wm(iAfter) - wm(iBefore);
    expect(Math.abs(dIncident - (-(2 / 9)) * B2 * Math.abs(Q0)) / (B2 * Math.abs(Q0))).toBeLessThan(1e-9);
    expect(Math.abs(dReflected / dIncident - 7 / 9)).toBeLessThan(1e-9);
    expect(dReflected / dIncident).toBeGreaterThan(0); // 同号部分反射
  });

  it("连接点始终流量连续、水头连续（两侧同一组解），序列有限", () => {
    const { res, B1, B2, Q0 } = setup();
    const j = res.junctions[0];
    expect(j.head.every(Number.isFinite)).toBe(true);
    expect(j.flow.every(Number.isFinite)).toBe(true);
    // t=1.1 透射解的流量跳变：ΔQ = −2/(B1+B2)·Δ（体积流量守恒，不是流速相等）
    const idx = (t: number) => j.time.findIndex((x) => Math.abs(x - t) < 1e-9);
    const dQ = j.flow[idx(1.1)] - j.flow[idx(1.0)];
    const dQTheory = -(2 / (B1 + B2)) * (B2 * Math.abs(Q0));
    expect(Math.abs(dQ - dQTheory) / Math.abs(Q0)).toBeLessThan(1e-9);
    // 末态中连接点（x=1250, 全局节点 25）与连接点序列取到同一个解
    const k = res.finalState.x.findIndex((x) => Math.abs(x - 1250) < 1e-9);
    expect(k).toBe(25);
    expect(Math.abs(j.head.at(-1)! - res.finalState.head[k])).toBeLessThan(1e-12);
    expect(Math.abs(j.flow.at(-1)! - res.finalState.flow[k])).toBeLessThan(1e-12);
  });

  it("公共 dt 与逐段贴格：dt=0.1，N1=25、N2=10，dx_s=a_s·dt", () => {
    const { res } = setup();
    expect(res.grid.dt).toBeCloseTo(dt, 12);
    expect(res.grid.pipes[0].segments).toBe(25);
    expect(res.grid.pipes[1].segments).toBe(10);
    expect(res.grid.pipes[0].dx).toBeCloseTo(a1 * dt, 12);
    expect(res.grid.pipes[1].dx).toBeCloseTo(a2 * dt, 12);
    expect(res.grid.totalSegments).toBe(35);
    expect(res.grid.totalLength).toBe(2250);
  });
});

/**
 * 判据三：多段接口退化成单段（pipes 只放一段）时，儒可夫斯基升压、
 * 往返周期 4L/a、缓关峰值低于瞬关仍成立——走的是同一条多段内核路径。
 */
describe("多段接口退化为单段：经典判据仍成立", () => {
  const oneSegment = (over: Partial<SimulationRequest> = {}) =>
    runSimulation(
      validateRequest({
        pipes: [{ length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 }],
        reservoirHead: 50,
        initialVelocity: 1,
        closure: { type: "linear", duration: 0 },
        discretization: { segments: [20] },
        duration: 12,
        ...over,
      }),
    );

  it("瞬时关闭峰值抬升 = aV0/g（无摩阻，1e-6）", () => {
    const s = summarize(oneSegment());
    expect(Math.abs(s.peakHeadRise - 1000 / GRAVITY) / (1000 / GRAVITY)).toBeLessThan(1e-6);
  });

  it("观测往返周期 ≈ 4L/a（2%）", () => {
    const s = summarize(oneSegment());
    expect(s.observedRoundTripPeriod).not.toBeNull();
    expect(Math.abs(s.observedRoundTripPeriod! - 4) / 4).toBeLessThan(0.02);
  });

  it("缓关（Tc=16s ≫ 2L/a=2s）峰值低于瞬关", () => {
    const inst = summarize(oneSegment({ duration: 12 }));
    const slow = summarize(
      oneSegment({ closure: { type: "linear", duration: 16 }, duration: 24 }),
    );
    expect(slow.peakHead).toBeLessThan(inst.peakHead);
    expect(slow.peakToJoukowskyRatio!).toBeLessThan(1);
  });
});

/**
 * 多段积分平衡：等参数两段（600+400，f=0.02）串联时，连接点两侧的
 * 蓄水连续系数 c = a²/(gA) 相同，内部交界通量在全线求和中相消，
 * 故仍满足 d/dt Σ_s∫H dx = c(Q_in − Q_out)。若连接点没被当成
 * 同一个耦合点处理，这个跨过人为切点的平衡会对不上。容差 5%。
 */
describe("多段：跨连接点的蓄水-流量积分平衡", () => {
  it("带摩阻、缓关、覆盖多个往返周期（容差 5%）", () => {
    const a = 1000;
    const D = 0.5;
    const A = (Math.PI / 4) * D ** 2;
    const res = runSimulation(
      validateRequest(
        multiRequest(
          [
            { length: 600, diameter: D, waveSpeed: a, frictionFactor: 0.02 },
            { length: 400, diameter: D, waveSpeed: a, frictionFactor: 0.02 },
          ],
          {
            reservoirHead: 50,
            initialVelocity: 1,
            closure: { type: "linear", duration: 3 },
            discretization: { segments: [12, 8] },
            duration: 10,
          },
        ),
      ),
    );

    const { time, storage, inflow, outflow } = res.diagnostics;
    const lhs = storage.at(-1)! - storage[0]!;
    let integral = 0;
    for (let i = 1; i < time.length; i++) {
      integral += 0.5 * (inflow[i - 1] - outflow[i - 1] + inflow[i] - outflow[i]) * (time[i] - time[i - 1]);
    }
    const rhs = (a * a) / (GRAVITY * A) * integral;
    const scale = 1000 * res.derived.joukowskyRise;
    expect(Math.abs(lhs - rhs) / scale).toBeLessThan(0.05);
  });
});
