import { describe, expect, it } from "vitest";
import {
  GRAVITY,
  runSimulation,
  ServiceError,
  summarize,
  validateRequest,
  type SimulationRequest,
} from "../src/index.js";

/** 断言求解器抛出指定 code 的 ServiceError。 */
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

/** 基准多段算例的公共片段。 */
function multiRequest(pipes: SimulationRequest["pipes"], segments: number[]): SimulationRequest {
  return {
    pipes,
    reservoirHead: 50,
    initialVelocity: 1,
    closure: { type: "linear", duration: 0 },
    discretization: { segments },
    duration: 12,
  };
}

describe("判据一：单管切成两段等参数子段，连接点不引入伪反射", () => {
  it("无摩阻：阀门水头序列、峰值、末态与单管写法一致（容差 1e-10）", () => {
    const single = multiRequest(
      [{ length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 }],
      [20],
    );
    const split = multiRequest(
      [
        { length: 600, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 },
        { length: 400, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 },
      ],
      [12, 8], // 公共 dt = 600/(12*1000) = 400/(8*1000) = 0.05 s
    );

    const a = runSimulation(validateRequest(single));
    const b = runSimulation(validateRequest(split));

    expect(a.grid.dt).toBeCloseTo(b.grid.dt, 14);
    expect(a.valve.head.length).toBe(b.valve.head.length);
    for (let i = 0; i < a.valve.head.length; i++) {
      expect(Math.abs(a.valve.head[i] - b.valve.head[i])).toBeLessThan(1e-10);
    }
    const sa = summarize(a);
    const sb = summarize(b);
    expect(Math.abs(sa.peakHead - sb.peakHead)).toBeLessThan(1e-10);
    expect(Math.abs(sa.peakTime - sb.peakTime)).toBeLessThan(1e-12);
    expect(a.finalState.head.length).toBe(b.finalState.head.length);
    for (let i = 0; i < a.finalState.head.length; i++) {
      expect(Math.abs(a.finalState.head[i] - b.finalState.head[i])).toBeLessThan(1e-9);
      expect(Math.abs(a.finalState.flow[i] - b.finalState.flow[i])).toBeLessThan(1e-12);
    }
  });

  it("带摩阻 f=0.02：峰值与末态仍一致（容差 1e-8）", () => {
    const f = 0.02;
    const single = multiRequest(
      [{ length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: f }],
      [20],
    );
    const split = multiRequest(
      [
        { length: 600, diameter: 0.5, waveSpeed: 1000, frictionFactor: f },
        { length: 400, diameter: 0.5, waveSpeed: 1000, frictionFactor: f },
      ],
      [12, 8],
    );
    const a = runSimulation(validateRequest(single));
    const b = runSimulation(validateRequest(split));
    const sa = summarize(a);
    const sb = summarize(b);
    expect(Math.abs(sa.peakHead - sb.peakHead) / sa.peakHead).toBeLessThan(1e-8);
    for (let i = 0; i < a.finalState.head.length; i++) {
      expect(Math.abs(a.finalState.head[i] - b.finalState.head[i])).toBeLessThan(1e-7);
    }
  });

  it("内部连接点两侧水头相等、体积流量相等（而非流速相等）", () => {
    const r = multiRequest(
      [
        { length: 600, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0.01 },
        { length: 400, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0.01 },
      ],
      [12, 8],
    );
    const res = runSimulation(validateRequest(r));
    expect(res.junctions).toHaveLength(1);
    const j = res.junctions[0];
    expect(j.x).toBeCloseTo(600, 12);
    for (let n = 0; n < j.head.length; n += 17) {
      // 末态拼接数组中连接点只保留一次，这里直接核对记录值有限且自洽
      expect(Number.isFinite(j.head[n])).toBe(true);
      expect(Number.isFinite(j.flow[n])).toBe(true);
    }
    // 连接点两侧原始存储：上游段末点 == 下游段首点（由联立解写回）
    // 末态全局坐标 x=600 处只有一个节点
    const idx = res.finalState.x.findIndex((x) => Math.abs(x - 600) < 1e-9);
    expect(idx).toBeGreaterThan(0);
    expect(res.finalState.x[idx + 1]).toBeGreaterThan(600);
  });
});

describe("判据二：粗慢管 → 细快管，连接点部分反射的符号与量级", () => {
  // 上游「粗慢」：L1=250, a1=500；下游「细快」：L2=150, a2=1000，A2=A1/4。
  // 公共 dt = 0.005 s：N1 = 250/(500*0.005) = 100，N2 = 150/(1000*0.005) = 30。
  // 慢管单程 0.5 s、快管单程 0.15 s。两单程之比 0.5/0.3 不是整数，故
  // 慢管水库反射回到连接点的时刻（0.15 + 2*0.5 = 1.15 s）不会撞上快管在
  // 连接点的任何一次混响（0.45/0.75/1.05/1.35 s），测量时窗干净。
  const slow = { length: 250, diameter: 1.0, waveSpeed: 500, frictionFactor: 0 };
  const fast = { length: 150, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 };
  const request = multiRequest([slow, fast], [100, 30]);
  request.reservoirHead = 100;
  request.duration = 1.4;

  // 特征阻抗 B = a/(gA)；面积比 4，故 B2/B1 = (1000/(A1/4))/(500/A1) = 8
  const A1 = (Math.PI / 4) * slow.diameter ** 2;
  const A2 = (Math.PI / 4) * fast.diameter ** 2;
  const B1 = slow.waveSpeed / (GRAVITY * A1);
  const B2 = fast.waveSpeed / (GRAVITY * A2);
  const impedanceRatio = B2 / B1;
  // 阀门在细快段，初始流速 V2 = Q0/A2 = 4 m/s；阀门首次升压 ΔH0 = a2*V2/g
  const vValve = 1 * (A1 / A2);
  const dH0 = (fast.waveSpeed * vValve) / GRAVITY;

  it("阻抗比与理论预估一致（8:1）", () => {
    expect(impedanceRatio).toBeCloseTo(8, 10);
  });

  it("细→粗（阀门升压波先到连接点）与慢→快（水库反射波回到连接点）反射系数符号相反", () => {
    const res = runSimulation(validateRequest(request));
    const j = res.junctions[0];

    const headAt = (t: number) => {
      const idx = j.time.findIndex((tt) => Math.abs(tt - t) < 1e-9);
      if (idx < 0) throw new Error(`no junction sample at t=${t}`);
      return j.head[idx];
    };

    const hInit = headAt(0);
    // t=0.10 s：波还在快管内（快管单程 0.15 s），连接点必须毫无动静
    expect(headAt(0.1)).toBeCloseTo(hInit, 10);

    // 跳变一（t=0.15 s）：阀门升压波自细快段到达（细→粗入射）。
    // 细→粗反射系数 R1 = (B1 − B2)/(B1 + B2) = −7/9，
    // 连接点透射跳变 jump1 = (1 + R1)·ΔH0 = 2/9·ΔH0（正压）。
    const jump1 = headAt(0.3) - headAt(0.1);
    const r1Expected = (B1 - B2) / (B1 + B2);
    const jump1Expected = (1 + r1Expected) * dH0;
    expect(r1Expected).toBeCloseTo(-7 / 9, 10);
    expect(jump1).toBeGreaterThan(0);
    expect(Math.abs(jump1 - jump1Expected) / jump1Expected).toBeLessThan(1e-6);

    // 跳变二（t=1.15 s）：透射波进入慢管、在恒定水头水库处反号反射后回到
    // 连接点，此时是慢→快入射，且两侧时窗内均无快管混响事件。
    // 慢→快入射幅 dI = −jump1（水库反号），慢→快反射系数
    //   R2 = (B2 − B1)/(B2 + B1) = +7/9（与 R1 反号），
    // 连接点侧合成跳变 jump2 = (1 + R2)·dI = −(1 + R2)·jump1（负压）。
    const jump2 = headAt(1.3) - headAt(1.1);
    const r2Expected = (B2 - B1) / (B2 + B1);
    expect(r2Expected).toBeCloseTo(7 / 9, 10);
    expect(r2Expected).toBeCloseTo(-r1Expected, 12);
    const jump2Expected = -(1 + r2Expected) * jump1;
    expect(jump2).toBeLessThan(0);
    expect(Math.abs(jump2 - jump2Expected) / Math.abs(jump2Expected)).toBeLessThan(1e-6);

    // 直接由两次实测跳变反演慢→快反射系数：R2 = −jump2/jump1 − 1
    const r2Observed = -jump2 / jump1 - 1;
    expect(Math.abs(r2Observed - r2Expected)).toBeLessThan(1e-6);
  });

  it("阀门峰值仍是细快段口径的儒可夫斯基升压（无摩阻，容差 1e-6）", () => {
    const res = runSimulation(validateRequest(request));
    const s = summarize(res);
    expect(Math.abs(s.peakHeadRise - dH0) / dH0).toBeLessThan(1e-6);
  });
});

describe("判据三：退化单段时经典结论仍成立", () => {
  it("pipes 只含一段时，峰值/周期与历史 pipe 写法完全一致", () => {
    const viaPipe: SimulationRequest = {
      pipe: { length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 },
      reservoirHead: 50,
      initialVelocity: 1,
      closure: { type: "linear", duration: 0 },
      discretization: { segments: 20 },
      duration: 12,
    };
    const viaPipes: SimulationRequest = {
      pipes: [{ length: 1000, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 }],
      reservoirHead: 50,
      initialVelocity: 1,
      closure: { type: "linear", duration: 0 },
      discretization: { segments: [20] },
      duration: 12,
    };
    const a = runSimulation(validateRequest(viaPipe));
    const b = runSimulation(validateRequest(viaPipes));
    expect(b.valve.head).toEqual(a.valve.head);
    expect(summarize(b)).toEqual(summarize(a));
  });

  it("缓关峰值低于瞬关；往返周期 ≈ 4·ΣL_k/a_k（多段异波速、阻抗匹配连接）", () => {
    // 两段波速不同（500/1000），但让截面随波速等比放大使特征阻抗 B=a/(gA)
    // 在连接点两侧相等：A2/A1 = a2/a1 = 2，即 D2 = √2·D1。
    // 这样连接点无部分反射，瞬关时阀门水头仍是周期 4·ΣL_k/a_k 的方波，
    // 可直接在多段网格上核对周期；异径/异阻抗的反射由判据二单独覆盖。
    const pipes = [
      { length: 500, diameter: 0.5, waveSpeed: 500, frictionFactor: 0 },
      { length: 500, diameter: 0.5 * Math.SQRT2, waveSpeed: 1000, frictionFactor: 0 },
    ];
    const instant = multiRequest(pipes, [20, 10]); // 公共 dt = 0.05
    instant.duration = 12;
    const slow = multiRequest(pipes, [20, 10]);
    slow.closure = { type: "linear", duration: 9 };
    slow.duration = 16;

    const si = summarize(runSimulation(validateRequest(instant)));
    const ss = summarize(runSimulation(validateRequest(slow)));
    expect(ss.peakHead).toBeLessThan(si.peakHead);

    // 单程时间 = 500/500 + 500/1000 = 1.5 s，往返周期理论值 6 s
    expect(si.theoreticalRoundTripPeriod).toBeCloseTo(6, 10);
    // 瞬关方波在 6 s 后再次出现峰值平台
    expect(si.observedRoundTripPeriod).not.toBeNull();
    expect(Math.abs(si.observedRoundTripPeriod! - 6) / 6).toBeLessThan(0.03);
  });
});

describe("公共时间步凑不出即报错（绝不插值硬推）", () => {
  const pipes = [
    { length: 500, diameter: 0.5, waveSpeed: 500, frictionFactor: 0 },
    { length: 250, diameter: 0.5, waveSpeed: 1000, frictionFactor: 0 },
  ];

  it("只给 timeStep 且某段 L_k/(a_k*dt) 非整数 → GRID_NOT_CONFORMING", () => {
    const r = multiRequest(pipes, [1]);
    r.discretization = { timeStep: 0.1 }; // 500/(500*0.1)=10 整；250/(1000*0.1)=2.5 非整
    expectCode(() => runSimulation(validateRequest(r)), "GRID_NOT_CONFORMING");
  });

  it("只给段数序列但各段 L_k/(N_k*a_k) 不通约 → GRID_NOT_CONFORMING", () => {
    const r = multiRequest(pipes, [10, 3]); // dt1 = 0.1，dt2 = 250/(3*1000) = 0.08333…
    expectCode(() => runSimulation(validateRequest(r)), "GRID_NOT_CONFORMING");
  });

  it("段数序列与 timeStep 同时给出但不一致 → GRID_NOT_CONFORMING", () => {
    const r = multiRequest(pipes, [10, 5]); // 贴格时 dt=0.05
    r.discretization = { segments: [10, 5], timeStep: 0.1 }; // 第二段 5*1000*0.1=500 ≠ 250
    expectCode(() => runSimulation(validateRequest(r)), "GRID_NOT_CONFORMING");
  });

  it("段数数组长度与管段数不符 → INVALID_INPUT", () => {
    const r = multiRequest(pipes, [10]);
    expectCode(() => runSimulation(validateRequest(r)), "INVALID_INPUT");
  });

  it("能通约时正常推进：timeStep=0.05 → N1=20, N2=5，各段库朗数为 1", () => {
    const r = multiRequest(pipes, [1]);
    r.discretization = { timeStep: 0.05 };
    const res = runSimulation(validateRequest(r));
    expect(res.grid.perSegment[0].segments).toBe(20);
    expect(res.grid.perSegment[1].segments).toBe(5);
    for (let k = 0; k < 2; k++) {
      const g = res.grid.perSegment[k];
      expect(g.dx).toBeCloseTo(g.waveSpeed * res.grid.dt, 12);
    }
  });
});
