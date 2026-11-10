# 22 代码优化审查：架构精简、性能、画面

日期：2026-11-10。审查基线：`main` 的 `c687ba0`，工作树干净。本文取代当天早些时候的 `SLIM-REVIEW-2026-11-10.md`，并补充了性能和画面两部分。

本次只做审查、写计划，没有改运行时代码，也没有在浏览器里测帧率。每条结论都标了证据层级：

- **代码核实**：读源码或用 `rg` 确认过这段代码确实这么写。
- **需测量**：代码路径上看有成本或缺口，但实际影响要按 [10-PERF-QA.md](10-PERF-QA.md) 在可见、聚焦的窗口里测过才能下结论。

参照对象：纽约原版 `ref/slop-newyork`，模块地图见 [16-NY-REFERENCE.md](16-NY-REFERENCE.md)；武汉 `ref/slop-wuhan`，模块地图见 [17-WUHAN-REFERENCE.md](17-WUHAN-REFERENCE.md)。`ref/` 在 `.gitignore` 里，Cursor 的搜索工具默认跳过它，要用 `rg` 直接搜。

功能缺陷仍按 [REVIEW-FOLLOWUP-2026-11-10.md](REVIEW-FOLLOWUP-2026-11-10.md) 第 4 节的顺序处理，第一项是裙房占道。本文的任务都不改玩法，可以由另一组人并行推进，冲突约束见第 5 节。

## 1. 结论

1. **架构**：正式入口 `js/main.js` 实际加载 80 个文件、30,172 行。`js/` 里另有 27 个纽约文件（23,805 行）和 8 个 MVP 文件从正式入口加载不到。深圳模块之间有成组复制的工具函数。超过约 1000 行上限的文件有三个：`main.js`（1283 行）、`sz-station-sites.js`（1008 行）和 `sz-building-details.js`（1003 行）。
2. **性能**：最值得先做的是武汉已经用过的一行改动，把实例矩阵换成 storage 缓冲。其次是楼名牌每块一个网格、全城地铁出入口玻璃合成一个实例网格这类批次问题。启动时城市数据被完整校验了两遍。
3. **画面**：深圳没有接上纽约引擎已有的几样东西：路面湿润和磨损、窗灯随黄昏变化、水面法线波浪、真实叶片的树。沥青现在是一个常量颜色，海面只改颜色和粗糙度，所以反射（SSR）几乎没有东西可反。内河水面在画面里没有画出来。
4. **做得好的部分不要重做**：纽约式场景剔除和阴影替身、楼块 1 km 合批共用一个材质、道路和标线分块、树木分块加 LOD、车流和人群实例化、半分辨率 SSR、着色器预热池，都已经和参考仓库同级。

## 2. 架构精简

### A1 纽约残留代码（代码核实）

`index.html` 没有预加载这些文件，`main.js` 的 import 链也走不到：

| 规模 | 文件 |
| --- | --- |
| 3,000 行以上 | `city-grid.js` 3544、`tsl-materials.js` 3454、`boroughs.js` 3367 |
| 1,000–2,500 行 | `traffic.js` 2468、`nyc-map.js` 1266、`trees.js` 1238、`road-network.js` 1183、`street-details.js` 1137、`landmarks.js` 1070 |
| 更小 | `buildings.js`、`city-config.js`、`pedestrian-system.js`、`bus.js`、`helicopter.js`、`fire-escapes.js`、`road-paint.js`、`pedestrian-routes.js`、`street-props.js`、`building-details.js`、`subway-entrances.js`、`building-footprints.js`、`tree-placements.js`、`building-geodata.js`、`tree-geodata.js`、`nyc-geodata.js`、`subway-geodata.js`、`sz-buildings-data.js` |

另有两份纽约数据包 `js/building-geodata.bin.gz`（441 KB）和 `js/tree-geodata.bin.gz`（123 KB）没有使用。

问题不只是体积。`js/` 里同时有 `traffic.js` 和 `sz-traffic.js`、`trees.js` 和 `sz-trees.js`、`road-paint.js` 和 `sz-road-paint.js`，读代码的人很难分清哪份在运行；早先几份文档也因此把运行模块写错了。纽约原样副本在只读的 `ref/slop-newyork/` 里，删掉 `js/` 下这份不会丢失参考。武汉仓库也有同样的问题：顶层 `js/` 是旧上海运行时，现行入口在 `js/runtime/`，两份 `pedestrians.js`、`actor-models.js` 几乎一样。所以删除之后要加一个可达性测试，防止以后再积累。

仍在使用、必须保留的纽约来源文件：
- 音频五个文件：`audio-*.js`
- 碰撞与物理：`building-collision.js`、`vehicle-physics.js`、`vehicles.js`、`vehicle-lights.js`
- 车辆、人物与控制：`cars.js`、`pedestrians.js`、`controllers.js`、`cameras.js`、`gamepad-controls.js`、`touch-controls.js`
- 光照与渲染：`city-lighting-materials.js`、`lighting.js`、`post-processing.js`、`scene-culling.js`

有 17 个测试按路径读这些死文件：

| 处理 | 测试 | 读的死文件 |
| --- | --- | --- |
| 整份删除 | `building-details`、`building-footprints`、`building-geodata`、`fire-escapes`、`nyc-map`、`pedestrian-routes`、`pedestrian-signals`、`tree-geodata`、`tree-placements`、`trees`、`road-paint`、`smoke-texture`、`water-material`、`facade-projection` | 只测纽约模块 |
| 只删相关用例 | `building-collision.test.cjs` 中的 road queries 用例 | `road-network.js` |
| 只删相关用例 | `car-wheels.test.cjs` 中的 `renderCar` 用例 | `traffic.js` |
| 只删相关用例 | `vehicle-physics.test.cjs` 中的 `trafficHarness` 及依赖它的用例 | `traffic.js` |

另外，`controllers.test.cjs` 和 `pedestrians.test.cjs` 里各有一处指向死模块的过时 mock：`'./landmarks.js': {}`。

`car-wheels` 和 `vehicle-physics` 被删的用例，测的是纽约车流的车轮样式、玩家碰撞冲量和动量守恒。删之前要查 `sz-traffic.js` 有没有对应行为：有就把用例迁到深圳实现上，没有就在第 7 节记一条缺口。

### A2 临时 MVP 及其残留分支（代码核实）

- `js/sz-mvp/`（8 个文件、543 行）和 `mvp.html` 是历史预览。AGENTS.md 写了“正式版接管后删除”，又把 `mvp.html` 写成“历史参考”，所以删除前要用户确认。
- 删除时要一起处理：
  - `tests/sz-air-evidence.test.cjs` 读 `js/sz-mvp/air.js`，要迁到 `sz-drone-routes.js`，或改为直接校验 `data/source/air-routes.json`。
  - `tools/sz/build.py` 174 行在清理旧 MVP 数据文件，可以去掉。
  - `tools/sz/roads.py` 9 行和 `tools/sz/buildings.py` 40 行的注释指向 MVP 的编号表。立面编号的正式对照在 `js/sz-materials.js` 27 行；道路等级先在正式代码里找到对应表，再改注释。
  - 提到 `mvp.html` 的文档要同步。
- `js/sz-materials.js` 里还留着只为 MVP 写的代码，和 MVP 是否删除无关，可以先清：
  - `createGroundMaterial`（285 行）和 `createRoadMaterial`（309 行）没有正式模块使用。
  - `createBuildingMaterial` 的 `showLandmarkLights` 分支（259–269 行）注释写明“临时预览页沿用”。

### A3 深圳模块之间的重复工具函数（代码核实）

| 函数 | 份数 | 位置 |
| --- | --- | --- |
| `mergeParts` | 2，逐行相同 | `sz-station-sites.js`，`sz-metro-entrances.js` |
| `ringArea` | 4 | `sz-buildings.js`，`sz-light-show.js`，`sz-apec-city.js`，`sz-station-sites.js` |
| `ringPerimeter`、`ringCentroid`、`sampleRing`、`distanceToRing`、`largestRing`、`outerRings` | 各 2 | `sz-apec-city.js` 和 `sz-station-sites.js`，整组重复 |
| `canvasTexture` | 3 | `sz-apec-city.js`，`sz-metro-entrances.js`，`sz-station-sites.js` |
| `finitePoint` | 3 | `sz-street-lamps.js`，`sz-apec-city.js`，`sz-metro-entrances.js` |
| `landmarkCenter` | 2 | `sz-apec.js`，`sz-apec-city.js` |
| `polygonContains` | 3 | `building-collision.js`，`sz-spatial.js`，`sz-trees.js`；另有 `sz-pedestrians.js` 的 `pointInPolygon` |

`polygonContains` 有两种语义，不能互换：
- `building-collision.js` 1 行起用奇偶规则，点正好落在边上时结果不确定。
- `sz-spatial.js` 6 行的 `ringContains` 把落在边上的点算作在内。

合并时两种都保留，用不同的函数名区分，逐个调用点确认原来用的是哪一种。

空间分桶也写了很多份，分布在 `sz-trees`、`sz-traffic`、`sz-pedestrian-tracks`、`sz-pedestrians`、`sz-controller-surfaces`、`sz-apec`、`controllers.js`，格子键有字符串和数值两种。武汉用一个共享的 `SpatialIndex`（`ref/slop-wuhan/js/spatial-placement.js` 12 行）做街具避让。深圳这一项先不合并：各处的格子大小和查询方式有各自的理由，没有测出瓶颈就改，风险大于收益。

### A4 `main.js` 的连线（代码核实）

纽约 `main.js` 796 行，武汉 `js/runtime/main.js` 795 行，深圳 1283 行。多出来的主要是下面几块：

| 位置 | 现状 | 方向 |
| --- | --- | --- |
| 196–203 行 | 入口里用循环把超级总部、西丽工地范围内的普通楼加进 `skipIds` | 并到 `sz-landmarks/layout.js`，和地标接管放在一起 |
| 场景构建段 | `groundHeight`、`roadHeight`、`colliders`、`pathAt`、`isWater` 分别传给多个构建函数；IEC 门廊和花海锚点对象写了两遍 | 建一个场地上下文对象，锚点只构造一次 |
| 264–268、835–856、940–964、1198–1221 行 | 44 处 `qa`：十个模块挂到 `window`，六个 `__sz*` 调试函数，`__szDebug`，帧和 GPU 采样 | 移到 `js/sz-qa.js` |
| 569、1149–1154 行 | 夜间系数从 `lightingSystem` 抄进 `sceneUniforms.night`，再逐个模块当参数传；灯光秀显隐也写在入口里 | 见 A5 |

`sz-qa.js` 要在 `main.js` 顶部静态 import，只在 `qa` 成立时调用安装函数。仓库规则禁止在函数体内动态 import。

武汉入口有 `?skip=landmarks,props,traffic,elevated,paint`（`js/runtime/main.js` 84 行），可以跳过某些构建阶段，用来二分启动和帧时问题。深圳的 `sz-qa.js` 可以加同样的开关，只在 `qa` 下生效。

### A5 两套日夜 uniform，深圳模块不读引擎那一套（代码核实）

- 纽约的 `cityUniforms` 在 `city-lighting-materials.js`，`lighting.js` 297–303 行在切换时段时写入，包括 `uInteriorGlow`（黄昏 1.25）和 `uRoadWetness`。
- 深圳的 `sceneUniforms.night` 在 `sz-materials.js`，由 `main.js` 569 行转抄。
- `rg cityUniforms js/sz-*.js` 没有结果，也就是说深圳的所有材质都不读 `cityUniforms`。纽约立面有 18 处用到 `uInteriorGlow`。结果是黄昏时段的窗灯完全由 `night` 决定，比纽约暗。这一条和画面部分的 V2 是同一处改动。

### A6 超长文件

| 文件 | 行数 | 处理 |
| --- | --- | --- |
| `js/main.js` | 1283 | 按 A4 处理 |
| `js/sz-station-sites.js` | 1008 | 抽走 A3 的环形工具和 `mergeParts` 后预计降到约 800 行 |
| `js/sz-building-details.js` | 1003 | 刚写好的新模块。先看它和 `sz-buildings.js` 的屋顶设备有没有重复，再决定怎么拆 |
| `js/sz-map.js` | 941 | 接近上限，本轮不动 |
| `controllers.js` 1355、`cars.js` 2110、`pedestrians.js` 2213 | — | 纽约引擎，[01-ARCHITECTURE.md](01-ARCHITECTURE.md) 要求少改或不改，不拆 |

## 3. 性能

先测再改。REVIEW-FOLLOWUP 第 2 节已经列了三项：驾车路线吸附、地图底图、树木 LOD 更新。下表不重复那三项。

| 编号 | 位置 | 现状 | 参考做法 | 证据 | 预估 |
| --- | --- | --- | --- | --- | --- |
| P1 | 全部 `InstancedMesh`（树、路灯、车流、地铁出入口、灯光秀、APEC） | 实例矩阵用默认缓冲。按武汉的注释，实例数不超过 1000 的小实例网格，矩阵放在 uniform 缓冲里，每个 pass 的每次绘制都会重传；算上阴影级联约 2.5 MB/帧 | 武汉 `js/runtime/main.js` 168–176 行：剔除之后遍历场景，把 `instanceMatrix` 换成 `StorageInstancedBufferAttribute`，只在 `needsUpdate` 时上传。纽约没有这一步 | 代码核实；收益需测量 | 高，改动小 |
| P2 | `sz-building-signs.js` 596–608、677、705 行 | 每块名牌一个 `Mesh`；每个不同的名字一个 `MeshBasicMaterial` 和一张 canvas 贴图 | 地铁出入口已经用站名图集（`sz-metro-entrances.js`）。名牌可以按 200 m 块合成一张图集、一个网格 | 代码核实；CBD 区的实际块数需测量 | 中到高 |
| P3 | `sz-metro-entrances.js` 591 行 | 全城出入口的玻璃是一个 `InstancedMesh`，包围球覆盖全城，视锥剔除失效；结构部分已经按空间分块 | 和结构部分用同一套分块 | 代码核实 | 中 |
| P4 | `sz-data-format.js` 237、348 行 | `readCityPayload` 和 `decodeCityPayload` 各调一次 `validateCityPayload`，城市包完整校验两遍 | 只在读取时校验一次 | 代码核实 | 低到中，改动很小 |
| P5 | 启动数据格式 | 7 MB gzip JSON，主线程 `JSON.parse` | 武汉 WUH1：变长整数加 gzip（`js/runtime/geodata-codec.js`），纽约 NYB1 | 需测量 | 已在 [19-WEBSITE-OPTIMIZATION-PLAN.md](19-WEBSITE-OPTIMIZATION-PLAN.md) B 项，这里不重复立项 |
| P6 | `main.js` 1159–1161 行 | 每帧对名牌组和细节组调用 `updateMatrixWorld(true)` | 纽约只更新动态根（交通、玩家）。改成块增删时才更新 | 代码核实；耗时需测量 | 低到中 |
| P7 | `sz-street-lamps.js` 201 行 | 夜间光晕 `Points` 设了 `frustumCulled = false`，全城光晕都参与绘制 | 按灯杆分块，打开视锥剔除 | 代码核实 | 低到中，只影响夜间 |
| P8 | `sz-ground.js` 33 行 | 地形块默认投射阴影 | `scene-culling.js` 237–311 行已把半径超过 350 m 的投影网格换成 500 m 分块阴影替身，所以不是每帧全量投影。莲花山等山体的自投影是想要的效果 | 需测量阴影 pass 耗时 | 待定，不先改 |
| P9 | 着色器数量 | 地标各自的材质、APEC 和站点模块各建 8–10 个材质，楼名牌每个名字一个材质 | 预热池已有（`main.js` 的 `compileAsync`，池大小 16，以及 `sharesPipelineWith`） | 需测量：记录 `[init]` 的 compile 耗时和 pipeline 数 | 待定 |
| P10 | `sz-drone-routes.js` 78 行 `buildDroneModel` | 每架无人机 13 个网格，站点每个 2 个；4 架加站点约 60 次绘制。[08-AIR.md](08-AIR.md) 的目标是共用一个实例网格 | 合并成一个几何，按架用 `InstancedMesh` | 代码核实 | 低，数量小但容易做 |

测量要求：
- 用 `tools/qa/perf-sample.mjs`，在可见、聚焦的桌面窗口里跑。自动化浏览器的 WebGPU 帧率被固定在 30 Hz，不能当证据。
- 至少测三个机位：出生点、福田 CBD 街面、夜间深南大道。
- 每个机位记录 draw calls、三角数、帧时 p50 和 p95、GPU 时间。
- 每项优化前后各测一次，写进第 7 节。

## 4. 画面

按“观感收益 ÷ 改动量”排序。所有移植都只用参考仓库的着色器做法，不搬纽约的街道样式（例如井盖、绿色自行车道）。

| 编号 | 深圳现状（代码核实） | 参考做法 | 移植建议 | 观感 | 成本 |
| --- | --- | --- | --- | --- | --- |
| V1 路面 | `sz-roads.js` 388 行：沥青是常量色 `0x363a3c`、粗糙度 0.96，没有磨损、补丁、湿润和水坑；`uRoadWetness` 没人读 | 纽约 `ref/slop-newyork/js/tsl-materials.js`：`createRoadSurfaceMaterial` 1913 行，`roadPuddleField` 1775 行；武汉同名函数 1673 行 | 移植磨损、湿润和凹凸三层，读 `cityUniforms.uRoadWetness`。时段切换时路面会变，SSR 也有东西可反 | 高 | 中 |
| V2 立面窗灯和玻璃 | `sz-materials.js` 246–257 行：窗灯只乘 `sceneUniforms.night`；277–282 行：玻璃金属度最高 0.5 | 纽约 `uInteriorGlow` 18 处；`createCurtainWallMaterial` 695 行；`evaluateApartmentInterior` 230 行和 `apartmentInteriorBehind` 401 行做室内景深；`canyonSkyAONode` 190 行做街谷遮蔽 | 第一步只把窗灯强度接到 `uInteriorGlow`，并调高幕墙玻璃的金属度和反射。室内景深成本高，只给玻璃率高的写字楼，单独评估 | 高 | 第一步低；室内景深中 |
| V3 水面 | `sz-materials.js` 294–307 行：海面用两组正弦波只改颜色和粗糙度，没有 `normalNode`，金属度 0.22。`geo.water`（内河、水库）只进了 `sz-spatial.js` 54 行的空间索引，没有画成水面 | 纽约 `createWaterMaterial` 2894 行（四层波浪贴图、菲涅尔、夜间岸线反光）；武汉 2468 行 | 海面换成带法线波浪的材质。内河先在浏览器里确认确实不可见，再由 `build.py` 输出水面多边形、运行时画出，和海面共用材质 | 高 | 中 |
| V4 树 | `sz-trees.js` 364–365 行：树冠是 icosahedron 叶球，纯色 | 纽约 `ref/slop-newyork/js/trees.js`：`growTree` 473 行、`buildTreeGeometries` 755 行；`createTreeMaterial` 1409 行，带叶卡图集、风摆、透光 | 只换近景一档，远景保留现在的低模冠。先做一种深圳常见树种样板，按 [06-STREETSCAPE.md](06-STREETSCAPE.md) 的树种规则测预算 | 高 | 高，近景三角数会涨 |
| V5 地面 | `sz-ground.js` 6 行：地面只有三种顶点色，山体、草地、铺装都没有纹理 | 武汉 `createMountainMaterial` 3352 行（坡度混岩石）、`createLotGroundMaterial` 3313 行；纽约 `createSidewalkMaterial` 2182 行 | 按坡度给山体混岩石；人行道和铺装移植湿润层 | 中 | 低 |
| V6 标线 | `sz-road-paint.js` 已有 `fwidth` 抗锯齿虚线，但没有磨损，也不随湿润变化 | 纽约 `createRoadPaintMaterial` 2113 行 | 和 V1 一起做，保留现有布局 | 中 | 低 |
| V7 底商 | 首层只有色块和玻璃带 | 纽约 `createStorefront` 530 行；武汉 `js/building-frontages.js` 沿源墙边贴通用立面，不造店名 | 只给有商业用途的楼做通用橱窗，不编造店名。和 [12-URBAN-FABRIC-PLAN.md](12-URBAN-FABRIC-PLAN.md) 的底商要求一起排期 | 中 | 中 |

已经达到或超过参考的部分，保留：
- 真实地形三角网，显示和接触共用。纽约基本是平地。
- 地标的程序化部件模型，显示和碰撞同源。
- 塔楼加裙房、近景阳台、空调外机和雨棚。
- 中文楼名和小区门牌。
- 路口信号和标线布局。
- 车公庙高架。
- 灯光秀。
- 后处理管线：MRT、半分辨率 SSR、泛光。

## 5. 执行计划

总规则：
- 每个任务一个分支，提交信息用英文祈使句。
- 不重建 `js/sz-city.json.gz`，除非任务本身就是数据改动（V3 内河）。
- 不动 `ref/`。
- 每个任务都要跑 Node 全套测试和 Python 测试。
- 改了启动、材质或画面的任务，还要做浏览器冷启动，控制台不能有报错，并截同机位前后对比图。图放在 `docs/qa/optimization/`，只留本地。
- 结束时恢复普通游玩页面。

开工前：
1. 跑 `git status`，保护他人未提交的改动。
2. 用第 6 节的脚本重新统计可达文件；数字和本文不同时，以重新统计的结果为准。

### 架构线（纯整理，不改画面和玩法）

| 任务 | 分支 | 内容 | 依赖 | 通过条件 |
| --- | --- | --- | --- | --- |
| S1 | `m9-prune-ny-runtime` | 先加 `tests/runtime-reachability.test.cjs`：从 `main.js` 遍历 import，断言 `js/` 下每个 `.js`（`sz-mvp/` 暂时除外）都能到达。然后按 A1 处理 17 个测试，删除 27 个文件和两份 `.bin.gz`，清掉两处过时 mock，并更新 [16-NY-REFERENCE.md](16-NY-REFERENCE.md) 开头和 [01-ARCHITECTURE.md](01-ARCHITECTURE.md) | 无；不碰裙房修复涉及的文件，可以并行 | 测试全绿；浏览器冷启动无报错；`git diff --stat` 只有删除和测试、文档改动 |
| S1b | `m9-remove-mvp` | 按 A2 删除 MVP 并迁移测试 | S1 完成，且用户确认 | 测试全绿；`build.py` 输出哈希和删除前一致 |
| S1c | 并入 S1 | 删除 `sz-materials.js` 里只给 MVP 用的 `createGroundMaterial`、`createRoadMaterial` 和 `showLandmarkLights` 分支 | S1 | 测试全绿；画面无变化 |
| S2 | `m9-shared-geometry-utils` | 建一个不依赖 three.js 的纯函数模块（建议 `js/sz-polygon.js`）和一个网格工具模块（建议 `js/sz-mesh-utils.js`）。`polygonContains` 两种语义分别命名；新模块加进 `index.html` 的 `modulepreload` | S1；`sz-buildings.js` 的部分等裙房修复合入 | 新模块有单元测试，覆盖凹多边形、带洞、点在边上和退化环；`sz-station-sites.js` 不超过 1000 行；地铁出入口、福田站、西丽围挡、APEC 大屏同机位对比无差异 |
| S3 | `m9-main-wiring` | 按 A4 新建 `sz-qa.js`（带 `?skip=` 开关），场地接管并入 `sz-landmarks/layout.js`，引入场地上下文对象 | S2；和任何正在改 `main.js` 的任务串行 | `main.js` 不超过 1000 行；`[init]` 各阶段仍在；普通地址下 `window` 上没有 `__sz*`；`?qa=1` 下原有调试函数和模块对象都在 |
| S4 | `m9-night-uniform` | 日夜状态只写一处，模块直接读 uniform，入口不再转抄、不再逐个传夜间系数 | S3；和 V2 同一处改动，由同一人做或者先后做 | 四个时段逐一切换，路灯、灯光秀、APEC 大屏和城市元素的夜间表现和改前一致 |

### 性能线（先测量）

| 任务 | 分支 | 内容 | 通过条件 |
| --- | --- | --- | --- |
| P0 | `m9-perf-baseline` | 按第 3 节的测量要求建立基线，写进第 7 节 | 三个机位、冷热各 5 次都有数值 |
| P1 | `m9-storage-instances` | 按武汉做法转换实例矩阵；要动态更新的实例（车流、人群）确认 `needsUpdate` 仍然生效 | 车流、树木和路灯画面不变；GPU 时间和帧时与 P0 对比后写明结论 |
| P2–P4、P6、P7、P10 | 每项一个分支 | 按第 3 节表格逐项做 | 每项都有前后测量；没有收益就回滚并记录 |

### 画面线

| 任务 | 分支 | 内容 | 依赖与冲突 | 通过条件 |
| --- | --- | --- | --- | --- |
| V1+V6 | `m9-road-surface` | 路面和标线材质 | 只改 `sz-roads.js`、`sz-road-paint.js` 和材质文件，和裙房修复不冲突 | 四个时段同机位对比图；路面材质没有出现在 P0 的瓶颈里 |
| V2 | `m9-facade-glow` | 窗灯接 `uInteriorGlow`，调幕墙金属度 | `sz-materials.js` 刚在 `c687ba0` 重写过，先找那位作者确认；和 S4 协调 | 黄昏和午夜同机位对比；着色器编译耗时不明显上升 |
| V3 | `m9-water` | 海面法线波浪；内河先确认是否可见，需要的话补数据和运行时 | 内河要改 `build.py`，由负责数据的人合并共享包 | 深圳湾和一条内河的日夜截图；水面碰撞不变 |
| V4 | `m9-tree-sample` | 一种树的近景样板 | 在 P0 之后做，需要预算余量 | 三角数和帧时在 [10-PERF-QA.md](10-PERF-QA.md) 预算内；远景 LOD 不闪烁 |
| V5、V7 | 后排 | 地面材质、通用底商 | V7 和 12 号规划一起排期 | 同机位对比图 |

建议顺序：
1. S1 和 P0 先做，可以并行。
2. 然后 P1、V1、S2。
3. 之后 S3、S4 与 V2 一组。
4. 最后 V3、V4，以及其余几项。

## 6. 复核命令

可达性统计（在仓库根目录运行）：

```sh
python3 - <<'PY'
import os, re
imp = re.compile(r"""(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]""", re.S)
seen, stack = set(), ['js/main.js']
while stack:
    f = stack.pop()
    if f in seen or not os.path.exists(f): continue
    seen.add(f)
    for m in imp.finditer(open(f).read()):
        stack.append(os.path.normpath(os.path.join(os.path.dirname(f), m.group(1) or m.group(2))))
allf = {os.path.join(d, x) for d, _, fs in os.walk('js') for x in fs if x.endswith('.js')}
for f in sorted(allf - seen): print(f)
PY
```

审查时这段脚本输出 35 个文件：A1 的 27 个，加 `js/sz-mvp/` 下的 8 个。

其他命令：

```sh
node --test tests/*.test.cjs
.venv/bin/python -m unittest discover -s tools/sz/tests
rg -n "cityUniforms" js/sz-*.js                       # A5 和 V2 的现状，审查时没有结果
rg -n "StorageInstancedBufferAttribute" js ref/slop-wuhan/js/runtime/main.js
```

浏览器：先运行 `python3 tools/sz/serve.py --port 8080`，再打开 <http://127.0.0.1:8080/> 和 <http://127.0.0.1:8080/?qa=1>。

## 7. 交付记录

执行者在这里追加：任务编号、分支、提交、测量前后数值、删除和迁移的测试、新发现的缺口、截图位置。不要改写上面的审查结论；结论被推翻时，在这里写明原因。

### S1 删除纽约残留运行时（2026-11-10）

- 分支：`dsh-3eda6f6c-f182`（原计划 `m9-prune-ny-runtime`；本工作树独立分支）。
- 新增 `tests/runtime-reachability.test.cjs`：从 `js/main.js` 遍历相对 import，`js/` 下出现不可达的 `.js` 就失败；`js/sz-mvp/` 等用户确认删除前暂不纳入。另断言所有相对 import 都指向存在的文件。加测试时对当前代码失败，删除后通过。
- 删除 `js/` 下 27 个不可达纽约文件（23,805 行）和 `js/building-geodata.bin.gz`、`js/tree-geodata.bin.gz`。可达模块仍是 80 个文件、30,172 行，和改前一致；`js/` 顶层从 89 个 `.js` 降到 62 个。
- 测试：整份删除 16 个纽约测试文件——审查表列的 14 个，加上审查表漏掉的 `traffic.test.cjs`、`traffic-performance.test.cjs`（两者在顶层读 `traffic.js` 和 `pedestrian-system.js`，不删会在 js 删除后加载失败）；`building-collision` 删 1 条公路查询用例、`car-wheels` 删 1 条 `renderCar` 用例、`vehicle-physics` 删 8 条 `trafficHarness` 用例、`pedestrians` 删 1 条 `renderPed` 用例；`controllers.test.cjs`、`pedestrians.test.cjs` 清掉 `'./landmarks.js': {}` 过时 mock。
- 迁移：`car-wheels` 的“每辆车的前后轮槽都写入同一车轮样式”用例迁到深圳实现，新增 `tests/sz-traffic.test.cjs` 的 `traffic writes each car wheel style to both front and rear slots`。
- Node 测试 493 → 385 项通过、0 跳过（差值是删除的纽约用例）；Python 101 项通过。`git diff --stat` 只有删除、测试和文档改动，没有运行时代码逻辑改动。
- 浏览器：`python3 tools/sz/serve.py --port 8097`，固定机位 `?qa=1&cam=-1800,200,-400,100,120,1150`，四个时段改前改后各截一张。改前 draw calls P95 617/618/640/640、三角数 P95 1.90/1.90/1.98/1.98 M；改后 624/624/640/640、1.92/1.92/1.98/1.98 M，同量级（差值来自环境车流位置）。像素平均差 0.7–1.8/255，画面一致。`[init]` 各阶段仍在；`compile` 每次 6.7–23.4 s 的波动是着色器缓存差异，不是本轮改动。
- 控制台：改后和改前（未改动的 `main` 检出，端口 8098）是同一组消息，没有新增。两边都有 3D TSL 的 `this.bNode.getNodeType is not a function` 报错和 `Vertex attribute "uv" not found` 警告（既有问题），以及浏览器扩展的 `MaxListenersExceededWarning`、`ObjectMultiplex` 警告；后者不属于应用。本轮没有新增应用错误，但这些既有报错没有消除，冷启动“无报错”一项只能按“无新增”记录。
- 新缺口：`vehicle-physics` 被删的玩家碰撞冲量/动量守恒用例在深圳实现里没有对应行为——`sz-traffic.js` 只用 `vehicleContact` 做碰撞检出和停车，不做冲量回弹和动量守恒；未为此改运行时代码。
- S1c 未做：`js/sz-mvp/{materials,ground,buildings}.js` 仍 import `createGroundMaterial`、`createRoadMaterial` 和 `createBuildingMaterial({ showLandmarkLights: true })`，删掉会让 `mvp.html` 因缺导出白屏；用户确认推迟到 S1b（删除 MVP）时一起做。
- 截图：`docs/qa/dsh-3eda6f6c-f182/`（只留本地，不进 Git）。

### S1b + S1c 删除临时 MVP 及其残留材质入口（2026-11-10）

- 用户确认删除 `mvp.html` 后，按 A2 删除 MVP：`mvp.html`、`css/sz-mvp.css`、`js/sz-mvp/`（8 个文件、543 行）。`js/` 顶层 `.js` 仍 62 个，全部可达；`tests/runtime-reachability.test.cjs` 去掉了 `sz-mvp/` 例外，现在整棵 `js/` 都必须可达。
- `tests/sz-air-evidence.test.cjs`：删掉只测 MVP `air.js` 的“旧预览保持静默”用例，保留直接校验 `data/source/air-routes.json` 和 `data/source/air-evidence.json` 的用例（A2 给的迁移方向之一）。
- 管线：`tools/sz/build.py` 去掉写包后清理 `js/sz-mvp/data/sz-mvp.json.gz` 的旧逻辑；`tools/sz/roads.py` 文档串和 `CLASSES` 注释不再指向已删的 `js/sz-mvp/roads.js`，改说明编号写进共享包 `enums.roadClass`；`tools/sz/buildings.py` 的立面编号注释改指 `js/sz-materials.js` 的 `FACADE_PROFILES`。
- S1c：删除 `js/sz-materials.js` 的 `createGroundMaterial`、`createRoadMaterial` 和 `createBuildingMaterial` 的 `showLandmarkLights` 分支（约 130 行）；`createWaterMaterial` 保留（`sz-sea.js` 在用）。`tests/sz-facade-material.test.cjs` 相应删掉 2 处 `showLandmarkLights` 用例/断言，节点数预算测试保留。
- 文档：`AGENTS.md`、`docs/01-ARCHITECTURE.md`、`docs/09-UI-GAMEPLAY.md`、`docs/11-MVP.md`、`docs/README.md` 同步“MVP 预览已删除、纽约代码只在 ref/”；`docs/HANDOFF.md`、`docs/TASKS.md` 按规则未改，仍写着 `mvp.html`。
- 测试：Node 385 → 383 项通过、0 跳过（删掉灯光秀预览 1 条、空气预览 1 条；另有一处灯光秀断言并入原有用例后删除）；Python 101 项通过。
- 画面：`sz-materials.js` 只删了没人调用的入口，正式入口材质图不变；固定机位四时段截图 `docs/qa/dsh-3eda6f6c-f182/after-mvp-*.png` 与 S1 的 `after-*.png` 对比应无差异。控制台仍只有既有 TSL 报错，无新增。
- 未验证：`build.py` 输出哈希未能复跑——工作树没有 `data/raw/`（不进 Git），主检出目录正在别的分支上，不能在那里重建覆盖 `js/sz-city.json.gz`。本轮对 `build.py` 只删掉一段对已不存在文件的 `unlink(missing_ok=True)`，不影响 payload 字节；如需证据，应在有 `data/raw/` 的干净检出里跑一次 `build.py` 比对 SHA-256。

### P0 M9 性能基线（2026-11-10）

- 代码：`main` @ `e85c26f`（合入 m9-startup-reliability 后）；测量期间 `js/` 未改动。
- 方法：`ego-browser` 固定机位，3 个机位 × 冷/热各 5 次，每次稳定采样 60 s；记录 rAF 原始帧间隔，draw calls、三角形、GPU 读数按 1 Hz 采样。原始 JSON 和本地采样脚本放 `docs/qa/m9-perf-baseline/`（只留本地，不进 Git）。
- 环境：Chrome 156.0.8078.48 / macOS 27.2.0 / Apple Metal-3（非 fallback）；屏幕 2560×1440；浏览器窗口 1121×1190；浏览器缩放 110%、DPR 1.1、渲染 pixelRatio 1.0；CDP 设备指标覆盖 2816×1584，使 CSS 视口和 canvas 都是 2560×1440。
- 机位：出生点＝清空玩家存档后的默认追尾机位（市民中心、福中三路）；福田 CBD 街面＝`?qa=1&cam=-900,10,1069,-426,140,1069`；夜间深南大道＝`?qa=1&cam=-400,9.4,438,-120,12,438` + 午夜 23:00。
- 冷/热：冷启动用 CDP 禁用 HTTP 缓存（每次 `fromCache=0`，重传约 9.0 MB）；热启动复用缓存。不清空整个浏览器资料/其他站点数据；每次清玩家存档，交通和人群由默认出生点确定性生成。30/30 段有效，没有 33.3 ms 的 30 Hz 节流。

表 1 帧时与绘制（5 次运行：p50 取中位，括号内为该组最差 p95；max 为 5 次里最差的单帧间隔）

| 机位 | 缓存 | 帧时 p50 (ms) | p95 (ms) | 单次 max (ms) | draw calls（p50/max） | 三角形（p50/max） | GPU 读数 p50（最差 p95） | ready 中位 s（范围） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 出生点 | 冷 | 16.70 | 17.30 (17.50) | 67.0 | 1484/1484 | 3.77/3.78 M | 62.9 (136.8) | 5.79（5.05–6.95） |
| 出生点 | 热 | 16.70 | 17.30 (17.30) | 83.3 | 1484/1484 | 3.77/3.78 M | 71.6 (117.3) | 5.39（5.13–5.52） |
| 福田 CBD 街面 | 冷 | 16.70 | 17.30 (17.50) | 67.1 | 536/536 | 1.89/1.89 M | 66.0 (114.2) | 5.46（5.41–5.83） |
| 福田 CBD 街面 | 热 | 16.70 | 17.10 (17.30) | 50.0 | 536/536 | 1.89/1.89 M | 67.0 (120.1) | 4.98（4.80–5.44） |
| 夜间深南大道 | 冷 | 16.70 | 17.20 (17.50) | 50.1 | 471/471 | 1.98/2.06 M | 54.3 (109.9) | 5.32（5.02–5.67） |
| 夜间深南大道 | 热 | 16.70 | 17.40 (17.50) | 65.7 | 471/471 | 1.97/2.05 M | 58.0 (127.1) | 4.93（4.85–5.07） |

表 2 `[init]` 阶段中位耗时（ms）

| 机位 | 缓存 | ready | data 下载 | data 解压 | roads | compile | traffic | blocks | culling | warmup |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 出生点 | 冷 | 5786 | 23 | 122 | 1123 | 791 | 730 | 336 | 264 | 258 |
| 出生点 | 热 | 5392 | 24 | 124 | 1151 | 923 | 851 | 371 | 281 | 268 |
| 福田 CBD 街面 | 冷 | 5456 | 26 | 103 | 1158 | 847 | 946 | 352 | 270 | 202 |
| 福田 CBD 街面 | 热 | 4979 | 25 | 106 | 1140 | 894 | 778 | 425 | 271 | 190 |
| 夜间深南大道 | 冷 | 5321 | 20 | 125 | 1130 | 787 | 717 | 346 | 266 | 187 |
| 夜间深南大道 | 热 | 4932 | 21 | 130 | 1176 | 858 | 764 | 354 | 274 | 183 |

补充探测（同机位、12 s，记录在 `supplement.json`）：出生点 CPU 渲染 11.86 ms/帧、模拟 0.86 ms、场景 UI 0.10 ms；CBD 5.45/0.77/0.09；夜间 5.51/0.80/0.10。楼名牌：出生点 26 块/21 张纹理，CBD 43/30，夜间 41/33；楼栋细节网格：70/88/94 个。

说明：

- 帧率：三个机位冷热共 30 段，rAF p50 全部 16.7 ms（60 FPS），p95 中位 17.1–17.4 ms；单帧最差 50–83 ms 是偶发 hitch，不是稳定段主体。
- GPU 读数不能当帧 GPU 时间：`qa.profile.gpuRenderMs` 在 60 FPS、帧间隔 16.7 ms、队列等待 6–18 ms 的同一段里读到 50–85 ms（最差 p95 100–137 ms），按 10 号文档不采纳为通过依据。单独 WebGPU 计算测试确认时间戳量级正确，怀疑是每帧约 22 次 render call 在约 2048 条查询池里回绕混帧；只作同配置相对比较。可用证据是队列等待与 CPU 渲染：出生点约 17 ms、CBD/夜间约 6 ms。
- 冷启动：三个机位各有一次（从热缓存切到禁用缓存的首次导航）出现 DOMContentLoaded 约 11 s、ready 15.5–15.9 s 的一次性开销；先做一次不计入的冷加载后，5 次干净冷启动即表中数值。判断为 Chromium 缓存状态切换开销，不是应用冷启动。
- 焦点：第一次运行 `document.hasFocus()` 有抖动（帧率仍 60 FPS），之后 29 段稳定；判废只看 `document.hidden` 和 33.3 ms 节流。
- 未覆盖：Q0 实际走查、飞行 ≥50 FPS、20 min 稳定性、显存总量（`renderer.info.memory.total` 约 0.45–0.48 GB，只是 renderer 资源计数）。M9 仍不算通过。

最重的三处（按本次数据）：

1. **出生点机位**：draw calls 1484，贴着每帧 1500 的预算（98.9%），是 CBD 的 2.8 倍；三角形 3.77 M，约另外两个机位的两倍；CPU 渲染 11.86 ms/帧（占 16.7 ms 预算的 71%），队列等待约 17 ms（CBD/夜间约 6 ms）。它是唯一一个 CPU 提交也接近预算的机位。
2. **启动 roads 阶段**：中位 1.12–1.16 s，是 `[init]` 最长的单阶段，占冷启动 ready 的约 20%。
3. **启动 compile 阶段**：中位 0.79–0.85 s；traffic 阶段 0.72–0.95 s 紧随其后，两者合计约 1.6–1.8 s。

对照第 3 节，最值得先做的是：

- **先降 draw calls，而不是先拼 GPU 带宽**：出生点 1484/1500、CPU 渲染 11.9 ms/帧，说明瓶颈已从纯 GPU 转到每帧提交和阴影级联。先量化 P3（地铁出入口玻璃全城一个 InstancedMesh、视锥剔除失效）和 P2（楼名牌按块合图集）能省多少 draw calls（本次只记录到名牌 26–43 块，出入口网格未单独计数），再决定先做哪项。
- **P6（名牌/细节组每帧 `updateMatrixWorld(true)`）**：改动小，和上面的 draw-call 排查一起做；出生点 CPU 预算只剩约 4.8 ms。
- **P1（实例矩阵 storage 缓冲）**仍然值得做，但本次测量不显示它是出生点 CPU 瓶颈的主因；按第 3 节要求单独做前后各 5 次测量，不要和 P2/P3 混在一次提交里。
- **P7（夜间光晕按灯杆分块、打开视锥剔除）**只影响夜间机位，夜间队列等待和 CPU 都不高，优先级放到 P2/P3/P6 之后；P9 先看 pipeline 数；P5 的数据格式不是启动瓶颈（data 阶段合计约 0.18 s），P4 校验约 15–60 ms，都排在后面。

### S2 共享几何工具模块（2026-11-10）

- 分支：`dsh-527cd33f-dcc4`（worktree 独立分支，基线 `4c54d2e`）。没有改 `docs/HANDOFF.md`、`docs/TASKS.md`，没有重建 `js/sz-city.json.gz`。
- 新增两个模块：`js/sz-polygon.js`（147 行，不依赖 three.js）收 `ringArea`、`ringPerimeter`、`ringCentroid`、`sampleRing`、`distanceToRing`、`largestRing`、`outerRings`、`finitePoint`、`landmarkCenter` 和包含判定；`js/sz-mesh-utils.js`（79 行）收 `mergeParts`、`canvasTexture`。`index.html` 在 `sz-spatial.js` 前加两条 `modulepreload`。
- 包含语义按 A3 保留两种，逐个调用点确认：
  - `ringContains` / `polygonContains`：奇偶规则，点正好落在边上时结果不确定，与 `building-collision.js`、`sz-trees.js`、`sz-buildings.js`、`sz-pedestrians.js` 原实现一致。`building-collision.js` 仍 `export { polygonContains }`，`main.js`、`audio-acoustics.js`、`sz-park-arrivals.js`、`sz-building-details.js` 的导入路径和语义不变。
  - `ringContainsInclusive` / `polygonContainsInclusive`：外环边界算内、内院边界算外，与 `sz-spatial.js` 原实现一致；`sz-spatial.js` 的覆盖区/陆地判定和 `sz-city-config.js` 的 `districtAt` 改用它。
- A3 迁移范围：`mergeParts` 2 → 1（`sz-drone-routes.js` 的同名函数签名不同，未动）；`canvasTexture` 3 → 1（`repeatX` 与 APEC 红回退色改为选项参数，围挡平铺和无 canvas 兜底色不变）；`finitePoint` 3 → 1（`sz-street-lamps.js` 那份原本是死代码，删除后不再导入）；`landmarkCenter` 2 → 1（`sz-apec.js` 保留同名 re-export）；`ringArea` 4 → 1；`ringPerimeter`、`ringCentroid`、`sampleRing`、`distanceToRing`、`largestRing`、`outerRings` 各 2 → 1；`polygonContains` 4 处 → 1 份奇偶实现 + 1 份边界包含实现。空间分桶按任务要求不合并。
- 环形面积统一为鞋带公式（`sz-station-sites.js`/`sz-apec-city.js` 原实现）；`sz-buildings.js`、`sz-light-show.js` 原来的梯形公式与它数学等价，实数据最大绝对差 3.4e-8 m²。按 `sz-buildings.js` 的裙房判定逐楼复核：`area < 1500` 阈值翻转 0 栋、外扩步数翻转 0 栋、外扩量差 ≤4.9e-11 m、顶点位移 ≤4.9e-9 mm；只有 `sz-light-show.js` 计划里 2 栋塔的 `areaM2` 四舍五入值 ±1 m²，该字段不参与几何和显示。
- 行数：`sz-station-sites.js` 1008 → 858（验收要求 ≤1000）；`sz-apec-city.js` 727 → 613；`sz-metro-entrances.js` 680 → 607；`sz-buildings.js` 590 → 567；`sz-pedestrians.js` 647 → 632；`sz-trees.js` 564 → 552；其余小幅下降，见 `git diff --stat`。
- 测试：Node 422 → 436 项通过、0 跳过。新增 `tests/sz-polygon.test.cjs` 10 项（凹多边形、带洞、点落在边上、退化环、采样/面积/中心/最近距离）和 `tests/sz-mesh-utils.test.cjs` 4 项（真实 0.187.0，覆盖索引/非索引合并、顶点色、Uint16/Uint32 索引、canvas 兜底、repeatX 平铺）。既有读取这些模块的用例补显式 import stub：新增 `tests/helpers/polygon.cjs` 和 `tests/helpers/mesh-utils.cjs`；`sz-spatial.js`、`sz-city-config.js` 的 data URI 用例把 `sz-polygon.js` 一起内联。Python 101 项通过。
- 浏览器：`python3 tools/sz/serve.py --port 8099`；改前用 HEAD 的另一份 checkout 跑 8098，同一 ego-browser 会话、916×1246 视口、HUD 隐藏、midday（大屏另加一对 midnight 并打开 APEC 主题）。5 对同机位截图放 `docs/qa/dsh-527cd33f-dcc4/`（只留本地）。
  - 机位：地铁出入口 `?qa=1&cam=-102.94,13.36,343.72,-113.94,12.56,334.72`；福田站 `-377.62,9.46,280.35,-387.62,8.74,290.35`；西丽围挡 `-11850,33.5,-2322,-11850,31,-2341`；APEC 大屏 `46,13.5,478,42.1,12.7,470.4`。
  - 像素平均绝对差（0–255）：地铁 0.45、福田站 1.00、西丽围挡 0.11、APEC 大屏 0.38、夜间大屏 0.03；差异来自环境车流/人群位置和抗锯齿，主体几何目视一致。
  - 几何 digest（逐网格世界矩阵 + 顶点/法线/UV/顶点色/索引 + 实例矩阵，FNV-1a）：地铁出入口 `2754469080`（130 网格/36,064 顶点/65,336 三角形）、福田站 `2314283066`（6/504/1,296）、西丽站 `3717316675`（6/7,760/3,958）改前改后完全相同；APEC 三块大屏和四块围挡广告面板的静态子树也分别相同。巡逻机器人几何本身 digest 相同，整组差异只来自巡逻位置随时间更新。
  - draw calls P95 改前→改后：地铁 496→490、福田站 382→375、西丽 215→220、大屏 318→309、夜间大屏 330→309；三角数同一量级，差值来自环境车流位置和视锥剔除，不是本轮引入的批次变化。
  - 控制台：CDP 在文档创建前挂 `error`/`unhandledrejection`/`console.error`，改前改后都只有既有的 3D TSL `this.bNode.getNodeType is not a function` 报错，没有新增模块解析错误或运行时异常。
- 结束时页面已恢复普通 URL `http://127.0.0.1:8099/`、追尾相机和可见界面，截图 `restored-normal-play.png`。
- 导出变化：`sz-spatial.js` 不再导出 `ringContains`/`polygonContains`（仓库内没有消费者；它的语义由 `sz-polygon.js` 的 `*Inclusive` 变体承担，避免旧名字和新模块的奇偶实现混淆）；`sz-apec.js` 仍按原样导出 `landmarkCenter`，`building-collision.js` 仍导出 `polygonContains`。
- 未做：A3 之外的空间分桶合并（任务明确不做）；`main.js` 超长、`sz-building-details.js` 接近上限都不在本任务范围。`sz-street-lamps.js` 的 `finitePoint` 原本是死代码（无调用点），删除后没有替代导入，活调用点只有 `sz-apec-city.js` 和 `sz-metro-entrances.js` 两处。A3 表只扫了 `js/*.js`，`js/sz-landmarks/super-hq.js` 的 `ringArea`/`ringCentroid`/`inRing`/`boundaryDistance` 和 `sz-pedestrians.js`、`sz-building-details.js` 里名叫 `polygonArea` 的同源工具仍留在原模块，按任务范围本轮未动。
### S3 收窄入口连线（2026-11-10）

- 分支：`dsh-5df3d2ce-c89c`（工作树独立分支，基线 `4c54d2e`；按用户指示已合入 main，合入时 main 已包含 S2 的 `e205548`）。
- 新增 `js/sz-qa.js`（302 行）：`createQaSession({ search, hostname, defaultChunkSize })` 只在 `127.0.0.1` / `localhost` 且 `?qa=1` 时 `enabled`，原来散在 `main.js` 的 QA 代码全部搬进来：
  - `?qa=1&cam=x,y,z,tx,ty,tz` 固定机位，仍然只在 qa 下覆盖相机；
  - `?skip=landmarks,trees,…` 阶段开关，17 个阶段名（landmarks、blocks、lightshow、signs、details、paint、elevated、streetscape、lamps、trees、apec、apecCity、metro、stations、drones、traffic、pedestrians），只在 qa 下生效，未列出的阶段照常构建；未知阶段名在 `stage()` 抛错、安装时 `console.warn`；
  - 10 个 `window.__sz*` 模块对象、8 个调试入口（`__szTeleport`、`__szNearTraffic`、`__szSurfaceAt`、`__szTeleportRoad`、`__szTeleportNear`、`__szNearColliders`、`__szDebug`、`__szQA`）、`[init]` 阶段快照和帧/GPU/队列采样（原 `summarizeSamples`、`profileSnapshot`、采样逻辑原样搬移）。
  - 入口里只留 `if (qa.enabled) qa.install({…})`；普通地址下 `window` 只有既有的 `__szBoot`，没有新增调试对象。
- `js/main.js` 1309 → 988 行：场地上下文对象 `site`（buildings/terrain/sites/roadGraph/terrainSurface/groundHeight/roadHeight/isWater/colliders/heightAt/pathAt）替换各构建函数的重复参数；IEC 门廊/花海锚点只构造一次；`renderFrame` 里的采样内联代码换成 `beginFrame/markSimulation/markRender/endFrame` 四行；`trackTimestamp: qa.enabled`。
- 场地接管：`js/sz-landmarks/layout.js` 新增导出 `siteTakeoverIds(buildings, sites)`，把 super-hq / xili-station 场地轮廓内的普通楼并入 `planSzLandmarks` 返回的 `skipIds`；入口里的 11 行循环和 `polygonContains` import 删除。真实快照上接管 75 个 id（super-hq 74、xili 1），与改前集合完全一致（`planSzLandmarks` 的旧断言不变）。
- 纯界面接线搬进 `js/sz-ui.js`（110 → 279 行）：`wirePopovers()`、`wireShortcuts({…})`、`createLocationReadout()`、`createHudTelemetry()`；入口只留调用。这是本轮“main.js 不超过 1000 行”验收的必要条件（执行前与用户确认过范围）。`index.html` 给 `js/sz-qa.js` 补了一条 modulepreload（`tests/boot.test.cjs` 要求模块图里每个相对 import 都预载）。
- 测试：新增 `tests/sz-qa.test.cjs` 8 项（入口行数、普通地址不挂 `__sz*`、loopback + `?qa=1` 判定、cam/chunks 解析、skip 只在 qa 下生效、startup/固定机位、`[init]` 标签、场地接管位置）；`tests/sz-landmarks.test.cjs` 的静态桩加载器补 `'../building-collision.js': collision`；`tests/sz-main-startup.test.cjs` 的 QA 断言由 `qa.startup[` 改为 `qa.markStartup(`。改前本工作树 422 项通过（任务提示里的 493 项对应 S1 删除纽约用例之前的旧状态），本分支改后 430 项通过、0 跳过；合入 S2（+14 项）后的 main 上 Node 444 项通过、0 跳过；Python 101 项通过。工作树没有 `.venv`，本轮用指向主检出 `.venv` 的符号链接跑测试（`.gitignore` 已忽略，不进 Git）。
- 浏览器（`python3 tools/sz/serve.py`；本工作树 8093 用本地不缓存版本，main 检出 8094 作改前对照；CDP 设备指标 2560×1440，控制台 hook）：
  - 普通地址 `window` 上只有 `__szBoot`；`?qa=1` 下 10 个模块对象和 8 个调试入口与改前一致，`__szQA()` 可读。
  - `[init]` 阶段集合与改前完全相同（data.download/decompress/parse/validate/decode + renderer/lighting/ground/roads/landmarks/blocks/traffic/controllers/culling/ui/postFX/compile/warmup/firstFrame/gpu）。
  - 固定机位同机位截图（CBD `?qa=1&cam=-900,10,1069,-426,140,1069`，夜间深南 `-400,9.4,438,-120,12,438`）：像素平均差 0.02–0.15/255、变化像素 0.9–2.9%（车流/人群位置差异）；draw calls 536/469、三角数 1.89 M/1.91 M，与改前同量级。
  - `?qa=1&skip=landmarks,trees,traffic,pedestrians`：地标计划空、树块 0 个、车流 0 个，draw calls 536 → 452，`[init]` 各阶段仍在。
  - 控制台：改前后同一组既有消息（4 条 TSL `bNode.getNodeType` 报错、`Vertex attribute "uv"` 警告），无新增应用错误。
  - 界面：普通地址下用页面内合成 keydown 核对快捷键（自动化窗口当前不在操作系统前台，真实按键到不了页面；P0 会话里同类按键曾生效，判断为环境差异），Digit2 → 出租车、V → 动作相机、H → 收起/展开 HUD、N → 静音/恢复、B 不报错；鼠标打开传送到/相机弹层，`data-anchor` 定位写入 right/top/bottom/maxHeight；按住 W 时 HUD 速度到 34 km/h，位置读数“福中三路深圳市民中心”正常；结束时恢复人模式 + 追尾相机 + HUD 显示。记录在 `docs/qa/dsh-5df3d2ce-c89c/ui-verify.json`。
  - 启动计时：qa 模式下 compile 阶段在多次加载间波动 4.8–85 s（改前改后都出现），判断是自动化窗口的着色器编译/缓存噪声，本轮不以启动耗时下结论；`[init]` 其余阶段量级正常。
- 新发现（本轮未处理）：`js/main.js` 仍保留 `wireMetroMenu(…)` 之后的一段内联地铁菜单构建（约 49 行，按钮版），和 `js/sz-ui.js` 的复选框版往同一个 `#metro-lines` 追加内容；浏览器里 `#metro-lines` 共 29 行（12 个复选框 + 17 个按钮）。本轮只做搬移，没有删这段重复实现，建议单独立项处理。
- 截图：`docs/qa/dsh-5df3d2ce-c89c/`（只留本地，不进 Git）。

### P1 实例矩阵换 storage 缓冲（2026-11-10，已测量并回滚）

- 做法：在 `setupSceneCulling` 之后遍历场景，把每个 `InstancedMesh.instanceMatrix` 换成 `new THREE.StorageInstancedBufferAttribute(array, 16)`（复用同一个 Float32Array，不复制 usage），必须排在首帧/着色器预编译之前。
- 覆盖与正确性（`?qa=1`，`__szDebug.scene` 统计）：改后 4383 个实例网格 / 475,961 个实例全部是 storage 属性（改前 0 个）。`needsUpdate` 仍然生效：30 个环境车 actor 在 1.2 s 内全部移动，`traffic:sedan` 的 GPU 实例矩阵读回内容随之变化；选一块可见链上的静态实例块，改 CPU 矩阵但不置 `needsUpdate` 时 GPU 不变，置 `needsUpdate` 后 GPU 与 CPU 一致（改前改后同样成立）。同机位截图像素平均差 0.35/255、变化像素 3.9–4.7%（车流/人群/道旗动画），draw calls/三角数完全相同（夜间 346 / 1,547,787），控制台无新增错误。
- 前后测量（同机位、2560×1440、每机位 3 次、每次稳定 30 s；机位同 P0：出生点 / 福田 CBD 街面 / 夜间深南大道）：

| 机位 | 版本 | 帧时 p50/p95 (ms) | CPU 渲染 p50 (ms) | 模拟 p50 (ms) | GPU 读数 p50 (ms) | 队列等待 p50 (ms) | draw calls | 三角形 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 出生点 | S3 | 16.7/33.4 | 12.23 | 0.78 | 59.4 | 75.1 | 1484 | 3.78 M |
| 出生点 | +P1 | 16.9/33.9 | 13.52 | 0.87 | 61.1 | 86.9 | 1484 | 3.78 M |
| 福田 CBD 街面 | S3 | 16.7/33.4 | 6.85 | 0.85 | 66.1 | 92.5 | 536 | 1.89 M |
| 福田 CBD 街面 | +P1 | 17.0/50.0 | 10.63 | 2.17 | 89.4 | 301.2 | 536 | 1.89 M |
| 夜间深南大道 | S3 | 16.7/33.4 | 7.39 | 0.92 | 73.7 | 70.1 | 471 | 1.95 M |
| 夜间深南大道 | +P1 | 17.4/34.3 | 11.95 | 5.49 | 53.4 | 337.2 | 471 | 1.93 M |

- 结论与回滚：**没有可复现收益，已回滚**（`js/main.js` 988 行，不再含 `StorageInstancedBufferAttribute`）。理由：
  1. 每机位第 1 次运行两边基本相等（出生点 CPU 12.04 vs 11.91–12.83 ms、队列 75.3 vs 65.8–79.1 ms；CBD CPU 6.36 vs 6.15–7.12 ms），随后同一阶段内的运行逐渐恶化（队列等待最高 985 ms、CBD 第 2 次帧 p95 50 ms），这是连续运行的环境漂移，不是一次启动遍历能造成的差异。
  2. 另做了一轮交错 A/B（同一时间段交替换两种 `main.js`），被 30 Hz 窗口节流污染（S3 两个机位 p50 33.3 ms）且出现一次 240 s 加载超时，数据不采纳。
  3. 代码核实：r187 已经把 `instanceMatrix` 作为逐实例顶点属性绑定并只在 `needsUpdate`（version）时上传；`__szDebug.scene` 里 4383 个实例网格的共享 reference 路径全部成立（没有走 uniform buffer 的网格），武汉注释里“小实例走 uniform 缓冲、每 pass 重传约 2.5 MB/帧”的前提在本仓库不成立。真正每帧变化的大实例是 3994 个 APEC 道旗（约 0.25 MB/帧），换 storage 后它仍然每帧 `needsUpdate` 上传；省下的只有车流/车轮的 `DynamicDrawUsage` 每 pass 重传（约 18 KB/帧），低于测量噪声。
- 备注：P1 补丁保留在 `docs/qa/dsh-5df3d2ce-c89c/p1/variants/main.p1.js`（只留本地），前后原始记录在同目录 `p1/before-p1/`、`p1/after-p1/`。
