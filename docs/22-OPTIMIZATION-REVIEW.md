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
