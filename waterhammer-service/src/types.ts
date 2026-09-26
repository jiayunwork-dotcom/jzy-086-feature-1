/**
 * 对外请求/响应与内核共享的类型定义。
 * 所有物理量均为 SI 单位：长度 m、时间 s、水头 m、流速 m/s、流量 m^3/s。
 */

/** 单根管段的几何与物性（串联主线中的一段）。 */
export interface PipeSpec {
  /** 管长 L > 0 */
  length: number;
  /** 内径 D > 0 */
  diameter: number;
  /** 波速 a > 0 */
  waveSpeed: number;
  /** 达西摩阻系数 f >= 0（取 0 即无摩阻） */
  frictionFactor: number;
}

/** 线性关闭：开度从 1 线性降到 0，历时 duration（可为 0，表示瞬时关闭）。 */
export interface LinearClosure {
  type: "linear";
  /** 关闭历时 Tc >= 0 */
  duration: number;
}

/** 分段关闭：调用方给出 (time, opening) 折线，开度在相邻点间线性插值。 */
export interface PiecewiseClosure {
  type: "piecewise";
  points: Array<{ time: number; opening: number }>;
}

export type ClosureSpec = LinearClosure | PiecewiseClosure;

/**
 * 离散参数。全主线共享同一个时间步长 dt；每段各自的空间步长必须满足
 * dx_k = a_k*dt（该段库朗数恰为 1）。
 *
 * - `timeStep`：直接指定公共 dt，要求每段 L_k/(a_k*dt) 都是整数；
 * - `segments`：多段时给出与管段等长的整数数组 [N_0,…,N_{m-1}]，
 *   各段 dt_k = L_k/(N_k*a_k) 必须彼此相等（相对容差 1e-6）；
 *   单段时沿用历史写法，可直接给一个整数；
 * - 两者都给：每段的 N_k*a_k*dt 必须等于 L_k。
 *
 * 凑不出全主线一致且各段贴格的公共时间步时一律报 GRID_NOT_CONFORMING，
 * 不做插值、不做数值耗散式硬推。
 */
export interface DiscretizationSpec {
  segments?: number | number[];
  timeStep?: number;
}

/** POST /simulate 的请求体。pipe（单管）与 pipes（有序串联序列）二选一。 */
export interface SimulationRequest {
  /** 单段写法（向后兼容）；与 pipes 同时出现属非法 */
  pipe?: PipeSpec;
  /** 多段写法：从上游水库到下游阀门的有序管段序列，首尾焊死 */
  pipes?: PipeSpec[];
  /** 上游水库恒定水头 H_res */
  reservoirHead: number;
  /**
   * 初始（稳态）断面平均流速 V0，按最上游第一段的截面取值；
   * 稳态体积流量 Q0 = V0*A_0，全主线守恒，其余各段流速为 Q0/A_k。
   */
  initialVelocity: number;
  closure: ClosureSpec;
  discretization: DiscretizationSpec;
  /** 仿真总时长 > 0 */
  duration: number;
  /** 推进步数上限，缺省 DEFAULT_MAX_STEPS；超过即报 STEPS_EXCEEDED */
  maxSteps?: number;
}

/** 校验通过、归一化为多段序列后的求解器输入。 */
export type ValidatedRequest = {
  pipes: PipeSpec[];
  reservoirHead: number;
  initialVelocity: number;
  closure: ClosureSpec;
  discretization: DiscretizationSpec;
  duration: number;
  maxSteps: number;
};

/** 单根管段上的贴格网格。 */
export interface SegmentGrid {
  /** 该段管段数 N_k */
  segments: number;
  /** 该段空间步长 dx_k = L_k/N_k */
  dx: number;
  /** 该段波速 */
  waveSpeed: number;
  /** 波走过该段全长的时间 L_k/a_k */
  travelTime: number;
}

/** 全主线网格：各段独立分网，共享同一个 dt。 */
export interface Grid {
  /** 全主线管段数之和 */
  segments: number;
  /** 全主线空间步长序列（每段一个），仅单段时由 HTTP 层展平为标量 dx */
  dx: number[];
  /** 公共时间步长 */
  dt: number;
  /** 推进总步数 */
  steps: number;
  /** 逐段网格明细 */
  perSegment: SegmentGrid[];
}

/** 某一时刻的全主线状态：各段节点首尾相接，内部连接点只存一次。 */
export interface PipeState {
  time: number;
  /** 节点坐标 x（沿主线累积） */
  x: number[];
  /** 节点水头 */
  head: number[];
  /** 节点体积流量 */
  flow: number[];
}

/** 内部连接点（两段交界处）的记录序列。 */
export interface JunctionSeries {
  /** 连接点编号，从上游起 0（位于第 0 段与第 1 段之间） */
  index: number;
  /** 连接点沿主线的坐标 */
  x: number;
  /** 时间序列（含 t=0） */
  time: number[];
  /** 连接点共同水头 H */
  head: number[];
  /** 通过连接点的体积流量 Q（两侧相等） */
  flow: number[];
}

/** 求解器原始输出（HTTP 层再裁剪）。 */
export interface SimulationResult {
  grid: Grid;
  /** 主线末端阀门处水头时间序列 */
  valve: { time: number[]; head: number[] };
  /** 各内部连接点的水头/流量时间序列（无内部连接点时为空数组） */
  junctions: JunctionSeries[];
  /** 末态全主线水头/流量分布 */
  finalState: PipeState;
  /** 初始稳态阀门水头（峰值抬升的基准） */
  initialValveHead: number;
  /** 连续性诊断序列：供流量协调校验/测试使用 */
  diagnostics: {
    time: number[];
    /** 全主线水头的长度加权平均 */
    meanHead: number[];
    /** 上游（水库）断面流量 Q(0,t) */
    inflow: number[];
    /** 下游（阀门）断面流量 Q(L,t) */
    outflow: number[];
    /** 逐段的长度加权平均水头，供分段连续性核对 */
    perSegmentMeanHead: number[][];
  };
  /** 派生量计算所需的常量 */
  derived: {
    /** 最上游（第一段）截面；单段时即为唯一截面 */
    area: number;
    /** 各段截面积 */
    areas: number[];
    /** 各段波速 */
    waveSpeeds: number[];
    /** 各段长度 */
    lengths: number[];
    /** 稳态体积流量 Q0 = V0*A_0 */
    initialFlow: number;
    /** 儒可夫斯基水锤升压 a_valve*|V_valve|/g（按阀门所在段口径） */
    joukowskyRise: number;
    /** 波从水库到阀门的单程时间 Σ L_k/a_k */
    waveTravelTime: number;
    /** 波往返周期理论值 4·Σ L_k/a_k */
    theoreticalPeriod: number;
  };
}
