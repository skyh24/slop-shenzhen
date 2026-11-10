# 18 道路与建筑净空治理方案

状态：**方案，未实施**。本文只描述做法、数据契约和验收，不改原始 OSM，不批量删楼，不把估计值写成实测。main 当前工作区不因本文产生代码改动。

## 1. 问题现象

浏览器里仍能看到建筑压在车道上、桥面/匝道穿楼、路到楼前突然断掉。用户提供的截图是车行至立交/匝道时，前方建筑体量与上层桥面/墙体同时占住道路视线。

## 2. 当前 main 的机制

- [js/sz-roads.js](../js/sz-roads.js) 的 `footprintIndex()` / `subtractFootprint()` 会按建筑 footprint **裁掉地面道路面**；
- 但建筑 mesh 本身不裁、不移、不删；
- [js/sz-elevated-roads.js](../js/sz-elevated-roads.js) 只检查桥墩与地形净空（`station.y - terrainY`），**没有检查桥面/匝道与建筑体积是否相交**；
- 因此会出现“路面被裁掉、楼还在、上层桥面穿楼”的组合。

## 3. 当前数据审计（main 2026-11-10 快照）

口径：38,109 栋建筑、11,238 条道路 link；道路按宽度 buffer，建筑 footprint 求交。这里的“强重叠”是几何候选，不等于全部视觉压路。

| 层 | 强重叠建筑 |
|---|---:|
| 地面道路 | 327 |
| 高架/匝道 | 28 |

地面 327 栋按建筑高度来源：

| 来源 | 数量 |
|---|---:|
| globfp | 286 |
| estimate | 16 |
| osm-levels | 14 |
| globfp-overlap | 6 |
| osm-height | 5 |

高架 28 栋按来源：

| 来源 | 数量 |
|---|---:|
| globfp | 19 |
| osm-levels | 5 |
| estimate | 4 |

典型候选（不是全部都要删）：

- 地面：`way/240804175`（石鼓路，重叠约 52%）、`way/240804217`（滨海大道，58%）、`way/529272445`（高新南十道，17,001 m² 大 footprint，质心落入 buffer）。
- 高架：`way/1499360239`（深南大道，94%）、`way/1499360240`（深南大道，7,084 m²，55%）、`overture/0f0c...`（福桂街，69%）。
- 立交：`滨河皇岗立交`、`福田立交`、`黄木岗隧道`、`深南广深立交桥` 附近均有候选。

审计局限：
- 大 footprint 建筑可能只是边缘被宽路 buffer 扫到；
- globfp/overture 的来源和高度本身可能是估计；
- 不能仅凭平面重叠判断“楼在路中”，必须结合层高、桥面高度、入口和实际渲染。

## 4. 原因分层

1. **只裁路面、不裁楼**：地面道路被建筑 footprint 裁掉，建筑保留，视觉上像路被楼截断。
2. **GF/Overture 误配**：小体量、未合并、错位的估算 footprint 落在道路缓冲内；这是地面强重叠的最大来源（286/327）。
3. **高架/匝道没有建筑净空**：上层桥面按 link 中心线生成，未检查桥面 envelope 是否穿过建筑；28 栋候选集中在这一层。
4. **宽路 buffer 误报**：大建筑和宽主干路/立交 buffer 相交，质心在内但实际只是贴边；需要按体积和渲染再筛。
5. **OSM 真实建筑**：`osm-levels`/`osm-height` 的 19 栋更可能是真实建筑贴路，不能按 GF 规则删，只能改路/改桥或保留并标注。

## 5. 处理原则

- **原始 OSM 不改**；所有裁剪、封闭、移除都写处理报告，保留源 ID、来源、面积、原因。
- **地面、高架、隧道分层处理**：不能用一个平面规则套所有层。
- **建筑优先级**：OSM/地标 > GF/Overture 估算；地标永不因压路删除。
- **不猜隧道**：中心线穿楼但没有隧道/通道来源时，封闭这段路并记录，不自动生成隧道。
- **显示、接触、碰撞同源**：路面/桥面裁到哪里，接触和碰撞就到哪里；不能只改画面。
- **可回退**：每个处理步骤输出 `before/after` 面积、对象 ID、规则版本。

## 6. 实施方案

### 阶段 0：全量净空审计（先做）

新增 `tools/sz/building_clearance.py`（或并入 `spatial_rules.py`）：

1. 读取当前 `js/sz-city.json.gz` 解码后的建筑 footprint、道路 link、宽度、层类型（ground/bridge/tunnel/layer）、桥面 profile；
2. 对每个对象求：
   - 平面重叠面积/比例；
   - 建筑质心是否在道路/桥面 buffer 内；
   - 建筑高度区间 vs 桥面/隧道顶标高；
   - 来源 `heightSource`、类别、是否地标；
   - 最近路名和 link ID；
3. 输出 `data/source/building-clearance-audit.json`：
   - `groundCandidates`、`elevatedCandidates`、`tunnelCandidates`；
   - `strong`/`edge`/`falsePositive` 分类；
   - 每条的 `sourceId`、`roadId`、`layer`、`overlapM2`、`ratio`、`heightM`、`recommendedAction`。
4. 先人工抽查 30 条（10 地面 GF、10 地面 OSM、10 高架），确认阈值。

**验收**：审计 JSON 可复现，数量与本文基线可比；每个候选有来源和推荐动作。

### 阶段 1：地面道路净空

1. 对 ground link：
   - 中心线穿建筑超过 1 cm 的段，从建筑 footprint 外扩 **0.2 m** 范围内剪掉；
   - 记录 `closedPassages`（路 ID、楼 ID、剪掉长度、原因）；
   - 不生成隧道、不删 OSM 楼。
2. 路面/标线/人行道按剪后几何重建：
   - 路面：`sz-roads` 的 `footprintIndex` 扩展为同时裁“中心线封闭段”；
   - 标线：`sz-road-paint` 只画裁后路面；
   - 人行道/路缘：沿用裁剪后的 contact。
3. 建筑侧：
   - `globfp`/`overture` 且 footprint ≤ 200 m²、质心在道路内、重叠 ≥50%、非地标：候选移除；
   - 其他 GF/Overture：保留，但把 `recommendedAction` 标为 `review`；
   - OSM/地标：永不删；只允许改路/改桥/保留。
4. 重新做路面与建筑 overlap 校验：
   - 渲染重叠 ≤ 1e-6 m²；
   - 中心线冲突 = 0；否则 build 失败。

### 阶段 2：高架/匝道净空

1. 对每条 bridge/ramp：
   - 生成桥面 envelope（宽度 + 0.5 m，含护栏）；
   - 与建筑体积求交，结合桥面 profile 的 `yCm` 和建筑 `height`；
2. 冲突处理优先级：
   - 若桥面可抬升且接坡坡度 ≤ 限制：抬桥面/延长引道；
   - 若不能抬：缩短/封闭该匝道，保留地面替代路径；
   - 若是 GF/Overture 小体量且非地标：候选移除；
   - 若是 OSM/地标：不改楼，优先改桥或封闭匝道，并记录原因。
3. 转盘/辅路：
   - 转盘中心岛、辅路与主桥分别求净空；
   - 匝道端部与地面道路用同一 `contact` 高度，避免突然起坡；
   - 坡度仍走“平缓弧线 + 引道”，不做瞬时折点。

### 阶段 3：隧道/下穿

1. 隧道洞口、洞身、顶板与建筑基础求交；
2. 洞身穿过建筑时：
   - 若有来源证明是下穿建筑：保留，做结构净空；
   - 无来源：封闭该段，不生成假隧道；
3. 洞内 road/contact 与地面分层，按 `currentY`/洞口进入，不把桥下车辆吸到桥面。

### 阶段 4：运行时与数据契约

- `sz-roads.js`：增加“裁后中心线/封闭段”输入；路面、标线、接触共用。
- `sz-elevated-roads.js`：增加建筑净空裁切和 `deckClearance` 报告；桥面/护栏同源裁切。
- `sz-road-paint.js`：只对裁后路面生成标线；断头处画端线。
- `sz-data-format.js`：校验 clearance 报告字段和 `sourceId`，不允许未标注的删除。
- `sz-traffic` / `controllers`：路线与接触使用同一裁后表面；封闭段不可通行。
- 所有新规则用固定种子、可复现，报告写规则版本。

### 阶段 5：验收与文档

- `node --test tests/*.test.cjs` 全过；
- `.venv/bin/python -m unittest discover -s tools/sz/tests` 全过；
- `data/source/building-clearance-audit.json`：
  - 地面/高架渲染重叠 ≤ 1e-6 m²；
  - 中心线冲突 0；
  - 移除建筑 100% 有源 ID、来源、面积、原因；
  - OSM/地标删除数 = 0。
- 浏览器 QA：
  - 深南大道、车公庙立交、福田立交、滨河皇岗、香蜜湖路；
  - 白天/午夜、车行/步行、桥上下、隧道口；
  - 截图存 `docs/qa/`，按 `docs/10-PERF-QA.md` 跑路线。
- 更新 `docs/TASKS.md`、`docs/HANDOFF.md`；本文状态从“方案”改为“已实施/部分实施”。

## 7. 建议改动文件

| 文件 | 改动 |
|---|---|
| `tools/sz/building_clearance.py` | 新增审计/裁剪规则 |
| `tools/sz/build.py` | 在 roadGraph/profile 后、payload 前调用 |
| `js/sz-roads.js` | 地面路面/接触按封闭段裁切 |
| `js/sz-elevated-roads.js` | 高架/匝道建筑净空 |
| `js/sz-road-paint.js` | 标线按裁后路面 |
| `js/sz-data-format.js` | clearance 报告校验 |
| `tests/sz-roads.test.cjs`、`tests/sz-elevated-roads.test.cjs` | 裁剪/净空回归 |
| `docs/18-ROAD-BUILDING-CLEARANCE-PLAN.md` | 本方案 |

## 8. 明确不做

- 不批量删除 OSM 建筑或地标；
- 不把 GF/Overture 估算写成实测；
- 不为压路建筑自动猜隧道/通道；
- 不靠“把路画窄”掩盖问题；
- 不在没有审计报告的情况下静默移除对象。

## 9. 当前结论（给下一次实施）

- 地面强重叠 327 栋，最大来源是 `globfp` 286 栋；
- 高架强重叠 28 栋，集中在深南大道、立交/隧道附近；
- 截图中的“楼在路中”最可能是**高架/匝道穿楼未裁**或**GF/Overture footprint 错位且未移除**；
- 建议先做阶段 0 审计，再按“OSM/地标保留、GF 小体量可移除、桥面优先改线/抬升、无法解决则封闭并记录”的顺序实施。
