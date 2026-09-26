import { describe, expect, it } from "vitest";
import { GRAVITY, runSimulation, validateRequest } from "../src/index.js";
import { baseRequest } from "./helpers.js";

/**
 * 流量协调（连续性积分平衡）：
 * 各段连续方程 d/dt ∫_k H dx = (a_k^2/(g*A_k)) * (Q_in,k − Q_out,k)，
 * 即管内蓄水（以长度加权平均水头表征）的变化必须和该段两端进出流量之差
 * 对得上。对整条仿真历程逐段做梯形积分再求和，相对容差 5%。
 */
describe("流量协调：管内蓄水变化 = 两端流量差累积", () => {
  it("带摩阻、历时覆盖多个往返周期", () => {
    const r = baseRequest();
    r.pipe.frictionFactor = 0.02;
    r.closure = { type: "linear", duration: 3 };
    r.duration = 10;
    const res = runSimulation(validateRequest(r));

    const { time, inflow, outflow, perSegmentMeanHead } = res.diagnostics;
    const { areas, waveSpeeds, lengths } = res.derived;
    const m = areas.length;

    // 每段两端的流量序列：内部连接点处直接取连接点记录（两侧严格相等）
    const leftFlow: number[][] = [];
    const rightFlow: number[][] = [];
    for (let k = 0; k < m; k++) {
      leftFlow.push(k === 0 ? inflow : res.junctions[k - 1].flow);
      rightFlow.push(k === m - 1 ? outflow : res.junctions[k].flow);
    }

    // 左端：Σ_k L_k * (meanH_k(T) − meanH_k(0))
    let lhs = 0;
    for (let k = 0; k < m; k++) {
      const series = perSegmentMeanHead[k];
      lhs += lengths[k] * (series[series.length - 1] - series[0]);
    }

    // 右端：Σ_k (a_k^2/(g*A_k)) ∫(Q_left − Q_right) dt
    let rhs = 0;
    for (let k = 0; k < m; k++) {
      const coeff = (waveSpeeds[k] * waveSpeeds[k]) / (GRAVITY * areas[k]);
      const qL = leftFlow[k];
      const qR = rightFlow[k];
      let integral = 0;
      for (let i = 1; i < time.length; i++) {
        integral +=
          0.5 * (qL[i - 1] - qR[i - 1] + qL[i] - qR[i]) * (time[i] - time[i - 1]);
      }
      rhs += coeff * integral;
    }

    const scale = lengths.reduce((s, L) => s + L, 0) * res.derived.joukowskyRise;
    expect(Math.abs(lhs - rhs) / scale).toBeLessThan(0.05);
  });
});
