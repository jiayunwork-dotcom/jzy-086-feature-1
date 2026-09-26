# waterhammer-service

关阀水锤瞬变验算的轻量 HTTP 服务。喂入**一条主线的有序管段序列**与阀门关闭
规律（JSON），内核用**特征线法（MOC）**沿时间和管轴逐步推进，回报整条主线
水头/流量随空间、时间的演化，重点给出**末端阀门处水头峰值**及其与儒可夫斯基
值之比；多段场景另附**各内部连接点的水头序列**，可直接看到波在管径/波速
突变处的部分反射与透射。

- 运行时：Node.js 20（锁定），TypeScript，HTTP 层 Fastify
- 只经 HTTP 收 JSON、回 JSON，**无前端页面**
- 全部物理量为 SI 单位：m、s、m（水头）、m/s、m³/s

## 快速开始

```bash
# 容器一键启动（推荐）
docker compose up --build

# 或本地开发
npm ci
npm test          # 自动化测试
npm run dev       # tsx 热重载，监听 3000
# 或：npm run build && npm start
```

## 物理模型与数值方法

### 控制方程

串联主线的每一段都是等截面弹性管（H 水头，Q **体积流量**，a 波速，f 摩阻）：

```
∂H/∂t + (a²/(gA)) ∂Q/∂x = 0
∂Q/∂t + gA ∂H/∂x + (f/(2DA)) Q|Q| = 0
```

各段可有自己的管长 L_k、内径 D_k（截面积 A_k）、波速 a_k、摩阻系数 f_k，
首尾焊死。最上游接恒定水库，最下游是按关闭规律动作的阀门。

### 段间内部连接点：无损、流量连续

连接点既无水库也无阀门，只按两条物理规律耦合（不计局部损失）：

1. **体积流量连续**：进、出连接点的 Q 相等。两段截面不同时是 Q 守恒，
   两侧流速并不相等（V = Q/A）；
2. **水头连续**：连接点两侧水头为同一个值 H。

推进时连接点不是各算各的，而是由**上游段末点到达的 C+ 特征线**与
**下游段首点到达的 C− 特征线**在新时层联立：

```
C+:  H = Cp − Bp_u·Q      （来自上游段，B_u = a_u/(gA_u)）
C−:  H = Cm + Bm_d·Q      （来自下游段，B_d = a_d/(gA_d)）
=>  Q = (Cp − Cm)/(Bp_u + Bm_d)，H 代回任一式
```

与段内内部节点是同一个联立解，只是两侧 B、R 取自不同管段。解出的同一对
(H, Q) 同时写回两段端点。阻抗 B 在焊口两侧跳变正是部分反射的来源：
入射波反射系数 r = (B_to − B_from)/(B_to + B_from)。

### 多段公共时步与贴格网格（重新组织的离散逻辑）

特征线法要求全场库朗数恰为 1。多段时这是一个**比单段强得多的全局约束**：

```
dx_k = a_k·dt 对每一段成立，且整条主线共享同一个 dt
⇔  dt = L_k/(N_k·a_k)  对所有段 k 取同一个值
```

- 只给段数序列 `segments:[N_0,…,N_{m−1}]`：各段导出 dt_k = L_k/(N_k·a_k)，
  要求所有 dt_k 在相对容差 1e-6 内相等，否则 `GRID_NOT_CONFORMING`；
- 只给 `timeStep`：要求每段 L_k/(a_k·dt) 都是整数，否则 `GRID_NOT_CONFORMING`
  （错误 details 里指出是哪一段、实际 reach 数是多少）；
- 两者都给：每段都要求 N_k·a_k·dt == L_k。

各段允许分到不同段数。**长度/波速无法通约出公共时步时直接报错，绝不靠
特征线插值或数值耗散硬推。** 单段是「只有一段的序列」的特例，走同一套代码、
同一容差，数值与历史版本逐位一致。

推进步数 `steps = ceil(duration/dt)` 超过 `maxSteps`（默认 200000）即报
`STEPS_EXCEEDED`。

### 特征线系数（src/characteristics.ts）

```
C+:  H_P = Cp − Bp·Q_P      Cp = H_{i−1} + B·Q_{i−1},  Bp = B + R·|Q_{i−1}|
C−:  H_P = Cm + Bm·Q_P      Cm = H_{i+1} − B·Q_{i+1},  Bm = B + R·|Q_{i+1}|
```

其中 `B = a/(gA)` 为管道阻抗，`R = f·dx/(2gDA²)` 为每 reach 摩阻系数，
旧时层取值。内部节点/连接点联立：`Q = (Cp − Cm)/(Bp + Bm)`。

### 摩阻线性化

稳态二次损失 `R·Q|Q|` 沿特征线**线性化为 `R·|Q_old|·Q_P`**（Wylie &
Streeter 一阶近似），旧时层流量的模吸收进 Bp/Bm，避免节点级非线性求解，
且对流量变号稳健。

### 边界条件（src/boundaries.ts）

- **上游水库**：水头锁死 `H = H_res`，与第 0 段到达的 C− 联立。
- **下游阀门**：孔口关系 `Q = τ(t)·Cv·√H`（`Cv = Q0/√Hv0` 由初始稳态
  标定）与最后一段到达的 C+ 联立，解关于 `√H` 的二次方程取正根；
  τ=0 退化为 `Q=0, H=Cp`。

### 初始稳态

`initialVelocity` 按**最上游第一段**的截面给出，稳态体积流量
`Q0 = V0·A_0` 全主线守恒（其余各段初始流速为 Q0/A_k）；水头自水库起
逐段按二次损失递减，阀门稳态水头 `Hv0 = H_res − Σ f_k L_k V_k²/(2g)`，
`Hv0 ≤ 0` 判 `INVALID_INPUT`。

### 关闭规律

- `{"type":"linear","duration":Tc}`：开度 1→0；`Tc=0` 为瞬时关闭；
- `{"type":"piecewise","points":[{time,opening},…]}`：分段折线线性插值。

## HTTP API

### `POST /simulate`

**单段写法（向后兼容，字段与历史版本完全一致）：**

```json
{
  "pipe": { "length": 1000, "diameter": 0.5, "waveSpeed": 1000, "frictionFactor": 0.02 },
  "reservoirHead": 50,
  "initialVelocity": 1,
  "closure": { "type": "linear", "duration": 0 },
  "discretization": { "segments": 20 },
  "duration": 12
}
```

**多段写法（`pipes` 有序序列；`discretization.segments` 为等长整数数组）：**

```json
{
  "pipes": [
    { "length": 250, "diameter": 1.0, "waveSpeed": 500,  "frictionFactor": 0 },
    { "length": 150, "diameter": 0.5, "waveSpeed": 1000, "frictionFactor": 0 }
  ],
  "reservoirHead": 100,
  "initialVelocity": 1,
  "closure": { "type": "linear", "duration": 0 },
  "discretization": { "segments": [100, 30] },
  "duration": 1.4
}
```

`pipe` 与 `pipes` 二选一；多段也可只给 `"discretization": {"timeStep": dt}`，
由服务逐段核验贴格并反推段数。完整算例：
`examples/two-segment-junction.json`。

**响应**（多段）：

```json
{
  "grid": {
    "segments": 130, "dt": 0.005, "steps": 280, "courant": 1,
    "perSegment": [
      { "segments": 100, "dx": 2.5, "waveSpeed": 500,  "length": 250, "travelTime": 0.5 },
      { "segments": 30,  "dx": 5.0, "waveSpeed": 1000, "length": 150, "travelTime": 0.15 }
    ]
  },
  "pipes": [ …回显入参管段序列… ],
  "valve": { "time": [0, 0.005, "…"], "head": [100.0, "…"] },
  "junctions": [
    { "index": 0, "x": 250, "time": ["…"], "head": ["…"], "flow": ["…"] }
  ],
  "summary": { "peakHead": 507.75, "peakTime": 0.15, "…": "…" },
  "finalState": { "time": 1.4, "x": ["…131 个坐标…"], "head": ["…"], "flow": ["…"] }
}
```

- `grid.perSegment`：逐段网格（dx_k、N_k、L_k/a_k）；单段响应保持
  历史形状（`grid.dx` 为标量，无 `perSegment`/`junctions`）；
- `junctions`：每个内部连接点（m−1 个）的共同水头与共同体积流量序列；
- `finalState`：各段节点首尾相接、内部连接点只存一次，共 ΣN_k+1 个节点；
- `summary`：阀门峰值、峰值/儒可夫斯基之比、第二峰值与往返周期；多段的
  理论往返周期为 `4·Σ L_k/a_k`，儒可夫斯基基准按阀门所在段口径
  `a_valve·|V_valve|/g`。

### 错误响应（400）

```json
{ "error": { "code": "GRID_NOT_CONFORMING", "message": "…", "details": { "…": "…" } } }
```

| code | 含义 |
| --- | --- |
| `INVALID_INPUT` | 几何/物性非法、`pipe` 与 `pipes` 同给或都缺、段数数组长度不符、关闭规律非法等 |
| `GRID_NOT_CONFORMING` | 多段凑不出共享且各段库朗数=1 的公共时步（details 指出失配段与实际 reach 数） |
| `STEPS_EXCEEDED` | 推进步数超过 `maxSteps` |

### `GET /health` → `{ "status": "ok" }`

## 算例

### 单段：近乎瞬时关闭 vs 儒可夫斯基

```bash
curl -s -X POST http://localhost:3000/simulate \
  -H 'Content-Type: application/json' \
  -d @examples/instantaneous-closure.json | jq .summary
```

### 两段异波速串联：连接点处的部分反射

```bash
curl -s -X POST http://localhost:3000/simulate \
  -H 'Content-Type: application/json' \
  -d @examples/two-segment-junction.json | jq .junctions[0].head
```

粗慢管（a=500，D=1.0）接细快管（a=1000，D=0.5），面积比 4、特征阻抗比
B₂/B₁ = 8。阀门瞬关产生的升压波 ΔH₀ = a₂V₂/g = 407.75 m：

- t = 0.15 s 波到达连接点。细→粗入射反射系数
  r₁ = (B₁−B₂)/(B₁+B₂) = **−7/9**，连接点透射升压
  (1+r₁)·ΔH₀ = **90.61 m**（100 → 190.61 m）；
- 透射波进慢管，在恒定水头水库反号，t = 1.15 s 回到连接点。此时为
  慢→快入射，反射系数 r₂ = (B₂−B₁)/(B₂+B₁) = **+7/9**（与 r₁ 反号），
  连接点出现 **−161.09 m** 的负压跳变（132.32 → −28.77 m）；
- 阀门峰值 507.75 m，抬升 407.75 m，与儒可夫斯基值之比恰为 1。

自动化测试用上述两次跳变直接反演 r₂，容差 1e-6。

## 自动化测试（vitest）

```bash
npm test
```

| 文件 | 覆盖 |
| --- | --- |
| `test/validation.test.ts` | 单段非法输入、单段贴格判定、步数上限（历史行为不变） |
| `test/joukowsky.test.ts` | 单段瞬关峰值 ≈ aV/g；带摩阻 ±5% |
| `test/period.test.ts` | 单段第二峰值往返周期 ≈ 4L/a（2%） |
| `test/slowClosure.test.ts` | 单段缓关峰值 < 瞬关；折线与线性一致 |
| `test/massBalance.test.ts` | 逐段连续性积分平衡（含连接点流量），容差 5% |
| `test/multisegment.test.ts` | ① 单管切成两等参子段：阀门序列/峰值/末态一致（1e-10），无伪反射；② 粗慢→细快连接点反射符号与量级（反演 r=±7/9，1e-6）+ 阀门儒可夫斯基峰值；③ 退化为单段经典结论与多段阻抗匹配周期 4ΣLₖ/aₖ；④ 公共时步凑不出即报错的各分支 |
| `test/httpMulti.test.ts` | 多段 HTTP 端到端：perSegment 网格、junctions 序列、报错分支 |
| `test/http.test.ts` | 单段 HTTP 端到端（响应形状不变） |

## 模块划分（src/）

| 文件 | 职责 |
| --- | --- |
| `grid.ts` | 多段公共时步构造：逐段 L_k/(N_k a_k) 通约判定与 L_k/(a_k dt) 整数判定 |
| `characteristics.ts` | 正/负特征线系数、联立节点解（段内与段间共用）、摩阻线性化 |
| `boundaries.ts` | 上游水库、下游阀门边界 |
| `solver.ts` | 多段时间推进：段内节点、连接点 C+/C− 联立、边界、序列记录 |
| `closure.ts` | 阀门开度规律（线性/分段） |
| `validation.ts` | 输入校验与 pipe→[pipes] 归一化 |
| `analysis.ts` | 峰值、往返周期等摘要量 |
| `http.ts` / `server.ts` | Fastify 路由（单段/多段响应整形）/ 进程入口 |
| `errors.ts` / `types.ts` / `constants.ts` | 结构化错误 / 类型 / 常数 |

## 已知限制

- 一维、两相无滑移纯液柱；不含空化（汽蚀）——水头低于汽化压力时不做断流
  弥合，负水头原样出现在结果里；
- 段间为无损焊接：体积流量连续、水头相等，不含局部损失与连接点附加质量；
- 摩阻为准稳态二次损失的线性化，不含非恒定摩阻；
- 阀门特性用单一孔口系数 + 相对开度表示。
