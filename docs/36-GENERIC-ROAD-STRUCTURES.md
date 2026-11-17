# 通用道路结构面（立交、高架、隧道）

本轮目标（用户 m00134 / m00180，选择 B）：橙黄色（bridge 或 layer≠0）的道路不再依赖人工审核的
`data/source/road-structures.json`，改由**路网图 + 地形**按统一规则派生可通行结构面；审核结果只留作
离线校验，运行时不再 import。桥面保留层高、净空、上层护栏；结构边缘有通用的两层接线和辅路接线；
隧道洞口按通用规则自动裁地形。

## 派生口径

结构边 = `!isGroundRoad(metadata) && metadata.tunnel !== true`，即 `bridge` 或 `|layer| > 0`。
隧道边 = `metadata.tunnel === true`（与 bridge 互斥优先隧道）。

| 项 | 规则 | 依据 |
| --- | --- | --- |
| 层高 | `LAYER_HEIGHT_M = 4.8`；桥面标高 = 地面 + 4.8 × max(1, layer)；`layer < 0` 的非隧道边按 0 抬升（下沉/地面层） | 既有 sz-elevated-roads.js |
| 落地端 | 与地面边共享 OSM 节点的一端落到地形高程 | 既有 groundNodes |
| 悬空端 | 端头不与地面共享节点时，补 8–40 m 引道（按高差/12% 反推长度），坡度 ≤ 12%，落到地形；限长内接不上标 `dangling`，仍显示但不进车行；同节点两条结构边高差 ≤ 0.35 m 视为相接 | 端头实测 52 个悬空端 |
| 护栏 | 桥面离地 > 0.75 m 的段落连续设置，0.95 m 高 × 0.35 m 宽，只在上层 | 既有 addBarriers |
| 桥墩 | 约 28 m 间距，净空 > 2 m 才设 | 既有 planLink/addPiers |
| 车行 | 非隧道、有真实层高（`layer ≠ 0` 或跨路抬升 `effectiveLiftM > 0.05`）、纵坡 ≤ 12%；共享节点高差 ≤ 0.35 m 才交接；不满足的结构面仍显示但标 `drive: false` | 既有 driveLinks + 本轮修正 |
| 端部搭接 | 已接通的端头沿切向补 4 m 平段，与相邻桥面/地面接触面重叠，避免支撑高度跳变 >1.5 m；该端有引道时不补，避免同一 (x,z) 两个高度 | js/sz-elevated-roads.js `pushDeckExtension` |
| 宽度 | `max(源宽, 6.5 m)`；两侧各留 0.35 m 护栏内缘 | 既有 |
| 隧道埋深 | `TUNNEL_LAYER_DEPTH_M = 6` × `|layer|`；`layer = 0` 的隧道只登记来源，不建洞身 | 既有 tools/qa/sz-tunnels.js（运行时已迁到 js/sz-tunnels.js） |
| 隧道纵断面 | 洞底 `floorY = terrain - 6×|layer| × min(startSink, endSink)`，`startSink/endSink` 在共享地面端 12 m 内由 0 线性到 1；洞底即通行面 | 既有 planTunnel |
| 洞口 | 洞顶 `floorY + 5` 高出地面的段落即洞口；等价于覆土 `6×|layer| × min(startSink, endSink) ∈ (0.05, 5.6)`，与地形无关 | 既有 portal 判定 |
| 裁地形 | 构建期按同一纵断面逐 4 m 站采样，对开敞段用 `max(源宽, 9 m) + 1.5 m` 走廊裁地形（`cut_ground_openings`）；参数须与 js 侧 `PORTAL_TRANSITION_M/TUNNEL_LAYER_DEPTH_M/TUNNEL_BORE_HEIGHT_M` 同步 | 本轮新增 |

平面（二维地图）同步：结构边按 ground / deck / tunnel 三态分色分宽，先 casing 后 fill，线宽封顶；
不再用单一黄色描所有边。

## 不变量

- 显示、接触面、车行链路同源：桥面顶面三角面同时是 controller surface；护栏和桥墩碰撞体来自同一批顶点。
- 每栋楼 `heightSource` 不受影响；结构面高程一律 `estimate`，不得写成实测。
- 隧道不宣称可通行到未核实洞身：洞口开敞段之外以洞身为准，洞身净空不足 5.2 m 的边 `drive: false`。
- 不引入新依赖、不新增外部模型；全部程序化建模。

## 文件所有权（并行开发）

| 范围 | 文件 |
| --- | --- |
| 桥面通用化 | `js/sz-elevated-roads.js`、`tests/sz-elevated-roads.test.cjs` |
| 隧道通用化 | `tools/qa/sz-tunnels.js` → `js/sz-tunnels.js`（已迁移 + 扩全城）、`tests/sz-tunnels.test.cjs`、`tools/qa/audit-tunnels.mjs` |
| 构建期洞口裁地形 | `tools/sz/tunnel_portals.py`（新建）、`tools/sz/build.py` 挂接、`tools/sz/tests/test_tunnel_portals.py` |
| 场景接线、车流、二维地图 | lead 在三个模块合入后统一改 `js/sz-scene-site.js`、`js/main.js`、`js/sz-traffic.js`、`js/sz-map*.js` |

## 已知限制（估计口径，不宣称实测）

- 车行连边只认源节点身份（`js/sz-traffic.js` 的有向图按共享 OSM 节点连边）：带引道落地的悬空端没有共享节点，
  即使铺了引道也无法接入车行路线，只作为可见结构面和接触面存在。
- 洞口 12 m 压深段的坡度（最高约 6 m / 12 m = 50%）不计入车行纵坡，否则所有共享地面端的隧道都会因洞口而不可车行；
  这条取舍使「洞口压深段能否安全通过」目前未由车行判定覆盖。
- 隧道纵坡靠地形采样估算；地形缺站的链路跳过洞身，不猜高程。
- 审核结构（`data/source/road-structures.json`）降到离线校验与截图抽查用途，运行时不再载入；它的
  `portalCutM2` 与本轮通用裁切（`report.tunnelPortals.genericCutM2`）分开统计，不合并。

## 实施结果（2026-11-17）

- 桥面：运行时派生 1,342 条结构边、顶面三角面约 105 万，其中 `layer=0` 跨路抬升 8 条、下沉非隧道 28 条；悬空端 52 个中有 90 余处补了 8–40 m 引道，接不上的标 `dangling`。
- 隧道：227 条隧道边，194 条生成洞身（合计约 81.4 km），洞身三角面 147,478、路面三角面 44,424；可车行 188 条，不可车行 39 条（纵坡 29、孤立 10）。全城建房沿 `layer=-1…-4` 派生，`layer=0` 只登记。
- 构建：正式双包重生成，`outputBytes = 16,245,282`，`outputSha256 = 159c5df4ff4b573a7992d26a2cff2c39ae6af63e016fac91fa06e0a3021ff58d`；`report.tunnelPortals = { links: 153, portalSpans: 233, cutM2: 28737.172, genericCutM2: 28734.933 }`。
- 回归：`check.py --scope full` 下 Python 197/197；Node 702 项中 4 项 real-Three 地标断言失败，已在干净 HEAD（与本轮改动无关）逐项复现同样 4 项，其余通过、零跳过。
- 浏览器：正式入口首帧成功；车公庙双层桥面/护栏/桥墩、福保一号隧道洞口裁地形、二维地图 casing 与车公庙匝道分层均截图确认。证据在本地 `docs/qa/generic-road-structures/`。

## 验收

1. `python3 tools/qa/check.py --scope roads --scope data` 全绿（4 项 real-Three 地标断言为基线失败，需单独处理）。
2. 浏览器样段：车公庙立交、深南—新洲、皇岗—滨河、塘朗山/沿江—东滨隧道口，检查双层通行、护栏、洞口。
3. 缺口记录进 HANDOFF/TASKS，不宣称全城 L5。
