# 项目现状复核与关键函数解析（2026-11-10）

## 1. 变更状态

- 工作树：仅 4 个**非本任务**的规划文档改动（`docs/01-ARCHITECTURE.md`、`06-STREETSCAPE.md`、`12-URBAN-FABRIC-PLAN.md`、`README.md`），未提交、未被覆盖；其余文件干净。
- 最近提交（HEAD `331f109` 起往前）依次是：`NEXT-SESSION-PROMPT`、冷启动回归、地铁分块 500→1000 m、M9 30 Hz 根因、性能采样脚本、桥面加宽、桥面端部重叠、跨层连接坡道、QA 交通/接触面探针、验收状态更新、四次/UI 结构核对、灯光秀、无人机航线、APEC 城市元素、高架匝道、超总/IEC 模型与站点、地标场地数据等。
- 本轮改动：**只加代码注释与本文档**，不改运行时行为（已用 `node --check` 校验 9 个模块，测试见文末）。

## 2. 项目结构复核（运行时）

```
index.html (import map) → js/main.js
  数据：js/sz-geodata.js ← js/sz-city.json.gz（build.py 产出，禁止手改）
  世界：sz-ground / sz-roads / sz-road-frontage / sz-buildings / sz-landmarks / sz-bridges
  街景：sz-streetscape / sz-street-lamps / sz-trees / sz-metro-entrances / sz-station-sites
  主题：sz-apec / sz-apec-city / sz-light-show / sz-drone-routes
  交通/控制：sz-traffic / controllers.js / sz-controller-surfaces.js
  界面：sz-map(+layers) / cameras(+presets) / sz-strings / css/style.css
```

数据流：`build.py` 产出共享包 → `sz-data-format.js` 解码为 `GEO/REAL_BUILDINGS` → 各模块建几何与碰撞体 → 控制器用同一份 `surfaces/colliders` 做接触与碰撞。所有估计值必须标 `estimate`，生成文件不得手改。

## 3. 关键函数解析（本轮已在源码上方加中文解析注释）

| 模块 | 函数 | 作用与关键约束 |
| --- | --- | --- |
| `js/sz-drone-routes.js` | `isApecAirSuspended` / `planDroneFlights` / `buildSzDroneRoutes` | 端点用 `air` 段公开来源；航迹/100 m 高度是示意；APEC 管控窗口内停在起降点 |
| `js/sz-light-show.js` | `planLightShow` / `createShowMaterial` / `buildSzLightShow` | 137 座福田 ≥150 m 普通高层灯带；6 材质桶→6 InstancedMesh；白天隐藏 |
| `js/sz-apec-city.js` | `planApecScreens/Robots/XiliHoardings` / `buildApecCityElements` | 3 大屏+2 机器人+4 围挡广告；锚点来自 IEC 模型；无碰撞体 |
| `js/sz-elevated-roads.js` | `planLink` / `planConnectorRamps` / `makeConnectorRamp` / `planElevatedRoads` / `buildSzElevatedRoads` | 车公庙 37 条 bridge/layer 链路；层高 4.8 m/层 estimate；连接坡道 2 条；37 个可站立面 |
| `js/sz-metro-entrances.js` | `planMetroEntrances` / `buildSzMetroEntrances` | 377/382 关联、286 放置；300 m 关联上限；站名牌 LOD；分块可调 |
| `js/sz-station-sites.js` | `buildFutianStation` / `buildXiliConstruction` | 福田地面亭/天窗；西丽围挡/塔吊/基坑；只做地面/在建形态 |
| `js/sz-buildings.js` | `buildCityBlocks` / `podiumPlan` / `roofPlan` | 塔楼+裙房（275 栋）、女儿墙/屋顶设备；显示与碰撞共用轮廓 |
| `js/sz-landmarks/super-hq.js` | `siteFrame` / `twinTowerPlan` / `build` / `createSuperHqMaterial` | C 塔双塔 400/336 m、119.15 m 连廊、招银 387 m；平面拟合 estimate |
| `js/sz-landmarks/iec-xiangmihu.js` | `build` / `createIecMaterial` | IEC 97 部件；顶点不出场地、不进湖；导出门廊/花海锚点 |

## 4. 运行与验收状态

- 测试：Node **434 pass / 0 fail / 0 skip**（Three 0.187.0）；Python **97 OK**。
- 冷启动：12 个地标全部加载、console errors = 0；superHq 机位 drawCalls 408、三角 827,608（预算内）。
- 九条硬性要求：1/3/4/5/7/8 达 L4；2 达 L4 + Q8 步行 L5（驾驶卡桥面中心线）；6 达结构层 L4（视觉/触屏对照待做）；9 未通过 M9（本机自动化环境 WebGPU swapchain 固定 30 Hz，需真实桌面窗口复测）。
- 详细证据：[ACCEPTANCE-STATUS.md](ACCEPTANCE-STATUS.md)、`docs/qa/`（本地）。

## 5. 风险与建议

1. **M9**：用 `tools/qa/perf-sample.mjs` 在可见聚焦桌面窗口重测（冷/热各 5 次、≥60 s/段、20 分钟稳定）；本机环境 30 Hz 上限不可作为验收证据。
2. **Q8 驾驶**：桥面 37 条链路可驾驶但车辆在 z≈1074 卡住；建议用派生道路中心线重建缎带或加车辆中心线引导。
3. **估计值纪律**：高架层高/连接坡道/灯光秀颜色/APEC 大屏位置均为示意，不得写成实测。
4. **用户文档**：`docs/01`、`06`、`12`、`README` 的未提交改动不是本任务产出，提交前需与用户确认。
