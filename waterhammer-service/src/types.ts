/**
 * 对外请求/响应与内核共享的类型定义。
 * 所有物理量均为 SI 单位：长度 m、时间 s、水头 m、流速 m/s、流量 m^3/s。
 *
 * 主线是「有序串联的管段序列」：上游端接恒定水库，下游端接动作阀门，
 * 相邻管段在内部连接点处焊死（流量连续、水头相等、不计局部损失）。
 * 单根管是序列长度为 1 的特例（请求仍可用旧的 pipe 字段）。
 */

/** 单根管段的几何与物性。多段串联时各段可分别给出。 */
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
 * 离散参数。全主线共享同一个时间步 dt，且每段都必须严格贴格：
 *   L_s = N_s * a_s * dt  （每段库朗数恰为 1）
 * - segments 给标量：每段都分这么多段，仅当各段行程时间 L_s/a_s 相等时才贴格；
 * - segments 给数组：逐段指定 N_s（长度必须等于管段数），要求各自导出的
 *   dt_s = L_s/(a_s*N_s) 全线一致，否则 GRID_NOT_CONFORMING；
 * - 只给 timeStep：要求每段 L_s/(a_s*dt) 都是整数（相对容差 1e-6）；
 * - segments 与 timeStep 同给：逐段要求 N_s*a_s*dt == L_s。
 * 凑不出公共时步时直接报错，绝不做特征线插值或数值耗散硬推。
 */
export interface DiscretizationSpec {
  /** 标量 = 每段段数；数组 = 逐段段数 */
  segments?: number | number[];
  timeStep?: number;
}

/** POST /simulate 的请求体。pipe 与 pipes 二选一（单段旧写法仍受支持）。 */
export interface SimulationRequest {
  /** 单管旧写法：与 pipes 互斥 */
  pipe?: PipeSpec;
  /** 多段串联新写法：自上游到下游的有序管段序列 */
  pipes?: PipeSpec[];
  /** 上游水库恒定水头 H_res */
  reservoirHead: number;
  /**
   * 初始（稳态）断面平均流速 V0。多段时约定为**最上游第一段**内的流速，
   * 全线初始体积流量 Q0 = V0*A_1，其余段稳态流速 V_s = Q0/A_s。
   */
  initialVelocity: number;
  closure: ClosureSpec;
  discretization: DiscretizationSpec;
  /** 仿真总时长 > 0 */
  duration: number;
  /** 推进步数上限，缺省 DEFAULT_MAX_STEPS；超过即报 STEPS_EXCEEDED */
  maxSteps?: number;
}

/** 校验通过、已归一成管段序列的求解器输入（字段齐备、类型收窄）。 */
export interface ValidatedRequest {
  /** 自上游到下游的有序管段序列（长度 >= 1） */
  pipes: PipeSpec[];
  reservoirHead: number;
  initialVelocity: number;
  closure: ClosureSpec;
  discretization: { segments?: number | number[]; timeStep?: number };
  duration: number;
  maxSteps: number;
}

/** 单根管段贴格后的网格信息。 */
export interface PipeGrid {
  /** 段序号，0 = 最上游 */
  index: number;
  length: number;
  diameter: number;
  waveSpeed: number;
  frictionFactor: number;
  /** 过流面积 A = pi*D^2/4 */
  area: number;
  /** 该段被分成的管段数 N_s */
  segments: number;
  /** 该段空间步长 dx_s = L_s/N_s = a_s*dt */
  dx: number;
  /** 波走过该段的时间 L_s/a_s */
  travelTime: number;
}

/** 全主线贴格网格：各段 N_s 可不同，但共享同一个 dt。 */
export interface Grid {
  /** 全线公共时间步长 */
  dt: number;
  /** 推进总步数 */
  steps: number;
  /** 库朗数恒为 1 */
  courant: 1;
  /** 各段分段数之和 ΣN_s */
  totalSegments: number;
  /** 各段长度之和 ΣL_s */
  totalLength: number;
  /** 逐段网格（顺序自上游到下游） */
  pipes: PipeGrid[];
  /** 总分段数（单段时即该段 N，与旧响应一致） */
  segments: number;
  /** 仅单段时给出：该段空间步长（向后兼容旧响应） */
  dx?: number;
}

/** 某一时刻的全主线状态（内部连接点只计一次）。 */
export interface LineState {
  time: number;
  /** 自水库起算的累计节点坐标 */
  x: number[];
  /** 节点水头 */
  head: number[];
  /** 节点体积流量 */
  flow: number[];
}

/** 内部连接点的时间序列（求解器原始输出含流量，HTTP 层只报水头）。 */
export interface JunctionSeries {
  /** 连接点序号，0 = 第 1、2 段之间，余类推 */
  index: number;
  /** 连接点距水库的里程 x */
  x: number;
  time: number[];
  head: number[];
  flow: number[];
}

/** 求解器原始输出（HTTP 层再裁剪）。 */
export interface SimulationResult {
  grid: Grid;
  /** 阀门处水头时间序列 */
  valve: { time: number[]; head: number[] };
  /** 各内部连接点（P-1 个）的水头/流量时间序列；单段时为空 */
  junctions: JunctionSeries[];
  /** 末态全主线水头/流量沿程分布 */
  finalState: LineState;
  /** 初始稳态阀门水头（峰值抬升的基准） */
  initialValveHead: number;
  /** 连续性诊断序列：供流量协调校验/测试使用 */
  diagnostics: {
    time: number[];
    /** 全主线水头的长度加权平均（= 蓄水积分 / 总长） */
    meanHead: number[];
    /** 全主线蓄水积分 Σ_s ∫H dx（逐段梯形积分） */
    storage: number[];
    /** 上游（水库）断面流量 Q(0,t) */
    inflow: number[];
    /** 下游（阀门）断面流量 Q(L,t) */
    outflow: number[];
    /** 逐连接点流量 Q_j(t)：多段积分平衡的交界项 */
    junctionFlows: number[][];
  };
  /** 派生量计算所需的常量 */
  derived: {
    /** 最上游第一段面积（单段时即全管面积，保持旧含义） */
    area: number;
    /** 逐段面积 */
    areas: number[];
    /** 逐段波速 */
    waveSpeeds: number[];
    /** 逐段长度 */
    lengths: number[];
    /** 阀门处儒可夫斯基升压 a_last*|V_last|/g = B_last*|Q0|；单段即 a*|V0|/g */
    joukowskyRise: number;
    /** 单向波传播时间 Σ L_s/a_s（单段即 L/a） */
    oneWayTravelTime: number;
    /** 波往返周期理论值 2*ΣL_s/a_s（单段即 4L/a） */
    theoreticalPeriod: number;
  };
}
