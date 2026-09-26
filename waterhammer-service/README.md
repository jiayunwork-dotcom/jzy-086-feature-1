# waterhammer-service

管道水锤瞬变验算的轻量 HTTP 服务。喂入**有序串联的管段序列**（各段可有不同
管径、波速、壁厚/摩阻）与阀门关闭规律（JSON），内核用**特征线法（MOC）**沿
时间和管轴逐步推进，回报整条主线的水头/流量演化，重点给出**末端阀门处水头
峰值**及其与儒可夫斯基值之比；多段场景另给各内部连接点的水头时间序列。

- 运行时：Node.js 20（锁定），TypeScript，HTTP 层 Fastify
- 只经 HTTP 收 JSON、回 JSON，**无前端页面**
- 全部物理量为 SI 单位：m、s、m（水头）、m/s、m³/s
- **向后兼容**：旧的单管 `pipe` 请求体原样可用，单段结果与历史版本逐位一致

## 快速开始

```bash
# 容器一键启动（推荐）
docker compose up --build

# 或本地开发
npm ci
npm test          # 自动化测试（53 例）
npm run dev       # tsx 热重载，监听 3000
# 或：npm run build && npm start
```

## 物理模型与数值方法

主线由 P 段管子首尾焊接而成：最上游接恒定水库，最下游接动作阀门，相邻两段
在内部连接点处焊死（无水库、无阀门）。等截面单管是 P=1 的特例。

### 控制方程（每段内）

```
∂H/∂t + (a_s²/(gA_s)) ∂Q/∂x = 0
∂Q/∂t + gA_s ∂H/∂x + (f_s/(2D_s A_s)) Q|Q| = 0
```

各段波速 a_s、面积 A_s、摩阻 f_s 可不同；**跨段连续的是体积流量 Q 与水头 H**
（截面不同时流速不相等），连接点不计局部损失（无损连接）。

### 多段贴格网格与公共时步（src/grid.ts）

特征线法要求全场库朗数恰为 1：每段都 `dx_s = a_s·dt`，而整条主线必须共享
**同一个时间步 dt**。第 s 段于是必须切成整数

```
N_s = (L_s / a_s) / dt        （该段波传播行程时间 ÷ 公共时步）
```

各段波速不同，一般凑不出让所有 `(L_s/a_s)/dt` 同时为整数的 dt。本服务**绝不
插值、不靠数值耗散硬推**：找不到公共时步就直接报 `GRID_NOT_CONFORMING`。

离散参数 `discretization` 支持（多段语义是全新组织的，不复用单段旧判定）：

- `timeStep`：逐段判 `(L_s/a_s)/dt` 为整数（相对容差 1e-6），任一非整即报错；
- `segments: [N_0,…,N_{P-1}]`：逐段给段数，要求各自导出的
  `dt_s = L_s/(a_s·N_s)` 全线重合，否则报错；
- `segments: N`（标量）：每段都切 N 段，仅当各段行程时间全部相等时贴格；
- `segments` 与 `timeStep` 同给：逐段复核 `N_s·a_s·dt == L_s`。

单段（P=1）时行为与历史实现严格一致：只给 N 则 `dx=L/N、dt=dx/a`。
推进步数 `steps = duration/dt` 超过 `maxSteps`（默认 200000）即报
`STEPS_EXCEEDED`。

### 特征线系数（src/characteristics.ts）

```
C+:  H_P = Cp − Bp·Q_P      Cp = H_up   + B_s·Q_up,    Bp = B_s + R_s·|Q_up|
C−:  H_P = Cm + Bm·Q_P      Cm = H_down − B_s·Q_down,  Bm = B_s + R_s·|Q_down|
```

`B_s = a_s/(gA_s)` 为该段特征阻抗，`R_s = f_s·dx_s/(2gD_sA_s²)` 为每 reach
摩阻系数，均取旧时层值（Wylie & Streeter 一阶线性化摩阻）。

### 内部连接点：两条异阻抗特征线联立（src/solver.ts）

连接点 j 同时是上游段 s 的末端与下游段 s+1 的首端。把**上游段末端内侧**到达
的 C+ 与**下游段首端内侧**到达的 C− 联立（两侧 B、R 各按本段取值）：

```
H = Cp_up − Bp_up·Q  =  Cm_dn + Bm_dn·Q
Q = (Cp_up − Cm_dn) / (Bp_up + Bm_dn)
```

解出的同一组 `(H, Q)` 同时写入上游段末端与下游段首端——体积流量连续、水头
相等，两段不是各算各的再拼接。压力波在阻抗突变处的部分反射/透射系数由
特征阻抗比给出（与本内核数值结果在无摩阻下精确一致）：

```
R_p = (B_2 − B_1)/(B_2 + B_1)     （自 1 侧入射的压力反射系数）
T_p = 2B_2/(B_1 + B_2)            （透射到 2 侧的压力系数）
```

粗慢管（B 小）→ 细快管（B 大）入射时 R_p<0（异号卸压反射），反之同号。

### 边界条件（src/boundaries.ts）

- **上游水库**：H 锁死为 H_res，与第 0 段到达的 C− 联立；
- **下游阀门**：孔口关系 `Q = τ(t)·Cv·√H`（`Cv = Q0/√Hv0` 由初始稳态标定，
  Q0 为全线初始体积流量）与末段 C+ 联立解二次方程；τ=0 退化为 `Q=0, H=Cp`。

### 初始稳态

全线同一初始体积流量 Q0。约定 `initialVelocity` 为**最上游第一段**内流速，
`Q0 = V0·A_0`，其余段稳态流速 `V_s = Q0/A_s`（截面不同则流速不同）。水头自
水库起按各段二次损失逐 reach 递减；阀门稳态水头 Hv0 ≤ 0 判 `INVALID_INPUT`。

### 关闭规律

- `{"type":"linear","duration":Tc}`：开度 1→0 线性；`Tc=0` 瞬时关闭；
- `{"type":"piecewise","points":[{time,opening},…]}`：单调不减折线，线性插值。

## HTTP API

### `POST /simulate`

单段（旧写法，响应与历史版本逐字段一致）：见
`examples/instantaneous-closure.json`。

多段（新写法，完整算例见 `examples/two-segment-reflection.json`）：

```json
{
  "pipes": [
    { "length": 1250, "diameter": 1.0, "waveSpeed": 500,  "frictionFactor": 0 },
    { "length": 1000, "diameter": 0.5, "waveSpeed": 1000, "frictionFactor": 0 }
  ],
  "reservoirHead": 100,
  "initialVelocity": 0.5,
  "closure": { "type": "linear", "duration": 0 },
  "discretization": { "segments": [25, 10] },
  "duration": 8
}
```

`pipe` 与 `pipes` 互斥；`pipes` 按**自上游到下游**的顺序给出。多段响应：

```json
{
  "grid": {
    "totalSegments": 35, "totalLength": 2250,
    "dt": 0.1, "steps": 80, "courant": 1,
    "pipes": [
      { "index": 0, "segments": 25, "dx": 50,  "length": 1250, "diameter": 1.0, "waveSpeed": 500,  "frictionFactor": 0, "travelTime": 2.5 },
      { "index": 1, "segments": 10, "dx": 100, "length": 1000, "diameter": 0.5, "waveSpeed": 1000, "frictionFactor": 0, "travelTime": 1.0 }
    ]
  },
  "valve": { "time": [0, 0.1, "…"], "head": [100, 303.87, "…"] },
  "junctions": [
    { "index": 0, "x": 1250, "time": ["…"], "head": ["…"] }
  ],
  "summary": { "…": "峰值、峰值/儒可夫斯基比、往返周期等" },
  "finalState": { "time": 8, "x": ["…"], "head": ["…"], "flow": ["…"] }
}
```

- `valve`：末端阀门水头完整时间序列；
- `junctions`：P−1 个内部连接点（含里程 x）的水头时间序列，可直接观察波在
  管径/波速突变处的部分反射与透射；单段时为 `[]`；
- `finalState`：末态沿**整条主线**拼接的水头/流量（连接点只计一次，
  共 ΣN_s+1 个节点）。

单段响应保持旧形状：`grid = {segments, dx, dt, steps, courant}`，无
`pipes/totalLength` 字段，`junctions: []`。

### 错误响应（400）

```json
{ "error": { "code": "GRID_NOT_CONFORMING", "message": "…", "details": { "…": "…" } } }
```

| code | 含义 |
| --- | --- |
| `INVALID_INPUT` | 几何/物性非正、摩阻为负、pipe 与 pipes 同给或都不给、段数数组长度不符、关闭历时为负、缺水库水头/初速等 |
| `GRID_NOT_CONFORMING` | 各段凑不出共享同一 dt、库朗数全为 1 的贴格网格（含逐段 dt 不重合、标量段数配不等行程时间等） |
| `STEPS_EXCEEDED` | 推进步数超过 `maxSteps` |

### `GET /health` → `{ "status": "ok" }`

## 算例

### 单管：近乎瞬时关闭 vs 儒可夫斯基

```bash
curl -s -X POST http://localhost:3000/simulate \
  -H 'Content-Type: application/json' \
  -d @examples/instantaneous-closure.json | jq .summary
```

### 两段异波速串联：连接点反射一目了然

粗慢管（L=1250 m, D=1.0 m, a=500 m/s）接细快管（L=1000 m, D=0.5 m,
a=1000 m/s），瞬时全关，无摩阻，公共 dt=0.1（25×0.1=2.5 s、10×0.1=1.0 s）。
阻抗比 B₂/B₁ = a₂A₁/(a₁A₂) = 8，理论反射系数 ±7/9、压力透射系数 2/9：

```bash
curl -s -X POST http://localhost:3000/simulate \
  -H 'Content-Type: application/json' \
  -d @examples/two-segment-reflection.json | jq '.junctions[0]'
```

- t=1.1（阀门升压波沿细快管上行到连接点）：连接点头 100 → 145.305 m，
  抬升恰为 `(2/9)·B₂|Q₀|`（压力透射），反射 −7/9 折回阀门；
- t=2.1（反射波回到封闭阀门端，压力再反射翻倍）：阀门 303.874 → −13.263 m，
  总跳变 −14/9·ΔH；
- t=6.1（粗慢管内透射波经水库反号后下行再到连接点）：出现 +7/9 的同号部分
  反射。自动测试对这三个事件的系数断言到 1e-9。

## 自动化测试（vitest，53 例）

```bash
npm test
```

| 文件 | 覆盖 |
| --- | --- |
| `test/multisegment.test.ts` | ① 等参数两段切分与单管阀门序列/峰值/末态逐点一致（<1e-9，连接点无伪反射）；② 粗慢→细快连接点的部分反射/透射系数 ±7/9、2/9（解析核对，1e-9）；③ 多段接口退化为单段时儒可夫斯基（1e-6）/往返周期（2%）/缓关峰值仍成立；④ 跨连接点蓄水-流量积分平衡（5%） |
| `test/multisegmentGrid.test.ts` | 公共时步各分支：timeStep 非整除、只贴一段、逐段 dt 不重合、标量段数配不等行程、自相矛盾 → `GRID_NOT_CONFORMING`；数组长度不符/空 pipes/pipe 与 pipes 同给 → `INVALID_INPUT`；可通约网格放行；三段串联 |
| `test/joukowsky.test.ts` | 单段瞬时关闭峰值 ≈ aV₀/g（无摩阻 1e-6，带摩阻 ±5%） |
| `test/period.test.ts` | 单段往返周期 ≈ 4L/a（2%） |
| `test/slowClosure.test.ts` | 缓关峰值 < 瞬关；折线与线性一致 |
| `test/massBalance.test.ts` | 单段积分流量协调（5%） |
| `test/validation.test.ts` / `http.test.ts` | 非法输入与三类结构化错误、单段响应旧形状、多段端到端 |

> 多段理论往返周期为 `2·Σ_s L_s/a_s`（单段即 4L/a）；儒可夫斯基基准取阀门
> 所在末段 `B_last·|Q₀| = a_last|V_last|/g`。

## 模块划分（src/）

| 文件 | 职责 |
| --- | --- |
| `grid.ts` | 多段公共时步贴格网格（逐段 N_s、共享 dt，库朗数=1 判定）+ 每段 B、R |
| `characteristics.ts` | 正/负特征线系数、内部节点联立、摩阻线性化 |
| `boundaries.ts` | 上游水库、下游阀门边界 |
| `solver.ts` | 多段时间推进内核：内部节点、内部连接点联立、两端边界、序列记录 |
| `closure.ts` | 阀门开度规律（线性/分段） |
| `validation.ts` | pipe/pipes 输入校验与归一 |
| `analysis.ts` | 峰值、往返周期等摘要量 |
| `http.ts` / `server.ts` | Fastify 路由 / 进程入口 |
| `errors.ts` / `types.ts` / `constants.ts` | 结构化错误 / 类型 / 常数 |

## 已知限制

- 管段仅**串联**（无分叉/环状管网）；不含空化（汽蚀）模型——水头低于汽化
  压力时仍按纯液柱推进，负水头原样出现在结果里；
- 内部连接点为无损焊接（不计局部损失、不允许变径处质量/能量源汇）；
- 摩阻为准稳态二次损失的线性化，不含非恒定摩阻；
- 阀门特性用单一孔口系数 + 相对开度表示。
