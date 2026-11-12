# 道路、地形与水面

## 已有功能

正式入口已装配地形、海面、地面道路、标线、路侧和高架。道路断面、弯道与路口使用共同车行范围，供沥青绘制、人行避让和建筑退让消费。高架同时提供显示实体与驾驶表面；深圳湾大桥、沿江高速已有远景。

普通城区采用派生工程地坪，山体与指定结构区保留独立处理。当前标高、异常和实际通行证据见 [HANDOFF](HANDOFF.md)，不能将工程地坪称为实测裸地。

## 方法与架构

| 入口（相对 `js/`） | 职责 |
| --- | --- |
| `sz-terrain.js::terrainHeight/terrainCellTriangles` | 格点三角插值，提供地形高度 |
| `sz-ground-surface.js::createGroundSurfaceSampler`、`sz-ground.js::buildSzGround` | 同一三角面数据用于查询与绘制 |
| `sz-controller-surfaces.js::createSurfaceResolver` | 区分地面、桥面、屋顶等活动表面的身份与高度 |
| `sz-roads.js::visitGroundRoadFootprints/createRoadSurfaceLayout/buildSzRoads` | 断面、弯道、路口范围与网格 |
| `sz-road-markings.js::createLanePlan/createMarkingLayout`、`sz-road-paint.js::buildSzRoadPaint` | 标线布局与绘制，贴对应活动表面 |
| `sz-road-frontage.js::buildSzRoadFrontage`、`sz-road-building-clearance.js::createRoadBuildingClearance` | 路缘/人行道与道路建筑净空 |
| `sz-elevated-roads.js::planElevatedRoads/buildSzElevatedRoads` | 桥梁规划、实体和车行链接 |
| `sz-sea.js::buildSzSea`、`sz-water-material.js::createSzWaterMaterial` | 海面、波浪法线与反射 |

离线由 `tools/sz/roads.py`、`roadgraph.py`、`road_surface.py`、`terrain_surface.py`、`bridges.py` 等经 `build.py` 生成。来源与重建规则见 [数据管线](02-DATA-PIPELINE.md)。驾驶和信号消费者见 [载具](07-VEHICLES.md)。

## 实现边界与验证

内河目前有数据和地图，三维水面仍缺。`sz-tunnels.js` 有规划/构建函数，但正式入口只消费审核清单，不能宣称隧道可通行。地坪接缝、山脚、入口和上下桥仍需逐段实走；同一XZ的桥上与桥下必须分层。

修改检查用 `roads`，接触/驾驶加 `controls`，生成器加 `data`；共享表面契约按 [开发检查](25-FAST-CHECKS.md) 用 `full`。浏览器走 [验收路线](10-PERF-QA.md) Q1–Q3/Q8，分别验手动、自动和环境车。后续仅在 [TASKS T2/T3](TASKS.md#t2-地面和q8) 派工。
