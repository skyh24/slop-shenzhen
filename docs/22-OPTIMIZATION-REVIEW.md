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

### P0 优化：静态地表与建筑分块（2026-11-10）

- 分支 `m9-perf-optimizations`；提交 `ae51d78`（地面/道路/标线合并）、`2c0e2ab`（建筑渲染块 1→2.4 km）、`8904684`（测试阈值随合并舍入调整）。运行时代码：`js/sz-ground.js`、`js/sz-roads.js`、`js/sz-road-paint.js`、`js/sz-buildings.js`、`js/sz-streetscape.js`，未改材质和玩法。
- 做法：地面/道路/标线按 2.4 km 超块合并几何、把分块原点烘焙进顶点；建筑渲染块从 1 km 放大到 2.4 km；步行道样板（`sz-streetscape`）继续逐块建 mesh，保留亚毫米局部坐标。draw-call 归因见 `docs/qa/m9-perf-optimizations/attribution*.json`（地面 372→28、道路 331→28、标线 246→23、建筑块 105→约 22）。
- 测量：与 P0 基线同机位、清玩家存档、显式金色/午夜时段，60 s 采样；before 在 8080（基线代码），after 在 8101（本分支）。帧间隔受窗口焦点影响的行单独标注。
- 结果（p50）：

| 机位 | draw calls 前→后 | 三角形 前→后 | CPU 渲染 ms 前→后 | 帧间隔 p50 前→后 |
| --- | --- | --- | --- | --- |
| 出生点 | 1484 → 540（−63.6%） | 3.77 → 4.04 M（+7.2%） | 10.36 → 5.45（−47.4%） | 16.7 → 16.7 ms |
| 福田 CBD 街面 | 536 → 316（−41.0%） | 1.89 → 2.07 M（+9.4%） | 5.76 → 3.84（−33.3%） | 16.7 → 16.7 ms |
| 夜间深南大道 | 471 → 305（−35.2%） | 1.98 → 2.32 M（+16.9%） | 5.70 → 4.01（−29.7%） | 16.7 → 本轮 32.5（窗口失焦被节流，作废） |

- 结论：出生点从贴近 1500 draw call 预算降到 540，CPU 渲染从 10.36 ms 降到 5.45 ms，留出约 5 ms/帧余量；三角形仍在 600 万预算内（出生点 4.04 M）。代价是视锥剔除粒度变粗、细长边界处三角形略增；画面同机位截图未见缺失或接缝。
- 测试：Node 422 项全过；唯一改动是 `tests/sz-chunjian.test.cjs` 的地面射线/采样器共面阈值从 1 µm 放宽到 1 mm，与 10 号文档 QA-G02 的默认共面阈值一致（合并把原点烘焙进 float32，10 km 处约 1 mm 舍入；接触仍用未合并的 `groundHeight` 采样器）。
- 未做：GPU 时间戳仍不可用作帧时间（第 7 节 P0 基线已记录）；真实 20 min 稳定性、夜间 60 s 有效帧间隔需要窗口持续聚焦后补测。剩余 draw call 大户：地标 61、建筑细节 45、街景 frontage 32、树/路灯各约 30。
- 第二轮尝试（未保留）：地标同材质合批不可行——12 个地标共 76 个 mesh、76 个独立材质（每个 style 一份），没有可共享材质；建筑细节块 200→400 只降 12 次绘制，且会改变 650 m 细节加载边界，已回退；阴影替身格 500→2000 不改变替身绘制数；街景 frontage 合批会破坏 `sz-road-frontage` 的分要素高程断言。静态分块这一档的收益已经拿完，继续在 chunk 上抠只值 ≤20 次绘制；P1（实例矩阵）已由上一轮测量并回滚（见上），下一档转 P2/P3（名牌图集、地铁口分块）。

### V4 近景树冠全面换成叶卡树（2026-11-10）

- 分支/提交：分支 `dsh-cbb3b304-5782`（原计划 `m9-tree-sample`），提交见 `git log`，信息 `Replace near tree crowns with leaf-card geometry`。
- 范围：只换 250 m LOD 子格的 **near** 一档，六种树全部换掉，不再保留 icosahedron 叶球近冠；远冠仍是原来的 `IcosahedronGeometry(1, 1)`（80 三角形/棵），不改几何、比例、颜色和投影行为。原审查只要求先做一种树样板；用户看到近景仍是圆球后明确要求“全面替换这些圆形粗糙的树木”，因此本轮扩展到全部树种。
- 树种和形态（都是外观估计，不是实测物候）：
  - 榕树 `ficus`：宽冠、低分枝、深绿宽椭圆叶；
  - 香樟 `camphor`：椭圆冠、直立枝、小叶；
  - 凤凰木 `phoenix`：伞形平冠、细碎羽状叶；
  - 宫粉紫荆 `bauhinia`：小圆冠；
  - 木棉 `kapok`：高直主干、稀疏直立冠；
  - 大王椰/狐尾椰 `royal-palm`：沿用树干圆柱，近冠改成 16 张放射状羽叶卡片，不走分枝骨架。
  每个树种用固定种子（`20261110 + 种子盐`），相同载荷每次加载长同一棵树。
- 做法：`js/sz-tree-crown.js` 提供按树种的叶卡树冠库，移植 `ref/slop-newyork/js/trees.js` 的 `growTree`/`buildTreeGeometries` 和 `tsl-materials.js` 的 `createTreeMaterial` 思路：
  - 1024×1024 四格图集（榕树 / 阔叶 / 棕榈 / 凤凰木），mip 链按覆盖率重标 alpha；
  - 树冠几何归一化：冠底 y=0、冠顶 y≈1、水平半宽 0.5，实例按 (冠幅, 冠高, 冠幅) 缩放；树皮枝管和叶卡共用一个 draw，靠 `aTree.x` 区分；棕榈只有叶卡；
  - 风摆、枝条摇动和单叶扑动在 TSL `positionNode` 里算，整树摆幅按树高写进实例属性 `aTreeSway`；
  - 透光用 `FoliageLightingModel`（`PhysicalLightingModel.direct` 里加 translucency），做法同纽约参考；
  - 每个 LOD 子格按树种各建一个实例网格，几何属性共享库内缓冲，只有实例属性、矩阵按子格各一份；所有叶卡网格共享材质，预编译只编一个代表管线。
- 树干碰撞不变：碰撞多边形、半径和 `maxY` 构造未改；新增单测要求近冠换叶卡后树干矩阵、碰撞数据仍和改前一致。
- 顺带修正：`sz-trees.js` 里既有的 `NEAR_LOBE_TRIANGLES = 320` 是错的，`IcosahedronGeometry(1, 2)` 实际 20 面 × 3² = 180 三角形，5 个叶球是 900 而不是 1,600。此前 `visible.triangles` 统计因此偏高；本轮改为 180，并按真实几何重算。
- 性能（自动化浏览器，固定机位，CSS 视口 1280×800、DPR 1.21、浏览器缩放 110%，同机位同配置；数值为稳定段 `profile` 的 mean/p95）：
  | 机位 | 改前 draw calls | 改后 draw calls | 改前三角形 | 改后三角形 |
  | --- | --- | --- | --- | --- |
  | 深南大道 `-940,16,466 → -800,12,460` | 539.97 / 548 | 580.28 / 587 | 1.594 M / 1.705 M | 1.725 M / 1.823 M |
  | 深圳湾公园 `-6796,7.5,2422 → -6740,8,2504` | 273.05 / 278 | 310.94 / 317 | 1.311 M / 1.390 M | 1.524 M / 1.613 M |
  | 莲花山 `-129,78,-1150 → -133,79.2,-1113` | 640.97 / 647 | 704.91 / 711 | 3.170 M / 3.266 M | 3.402 M / 3.508 M |
  | 榕树近景 `-893,17,475 → -877,18,459` | — | 537.24 / 544 | — | 1.610 M / 1.711 M |
  - 最大 draw calls 711 < 1500，最大三角形 3.51 M < 600 万，也在 P0 出生点 3.77 M 以下，没有超预算。draw calls 比改前多 39–64 次，来自“每个近景子格按树种各一个实例网格”，仍在预算内。
  - 单棵近景冠三角形：榕树 1,334、香樟 1,552、宫粉紫荆 1,296、凤凰木 1,568、木棉 686、棕榈 32；比原叶球近冠的 900 高约 43%（按树种出现比例加权），但仍然远低于每帧 600 万的预算，所以没有压缩叶卡数。
  - `[init]` 的 `traffic` 阶段（树在 `blocks` 之后、`traffic` 之前构建，耗时落在这里）改前 982–1,721 ms，改后 900–1,268 ms，没有增加；六份几何加 1024 图集在这一阶段构建。`compile` 阶段本轮 2.8–4.2 s，但自动化浏览器里同机位重载会因 GPU 进程状态波动到几十秒，**不能作为前后比较依据**。
  - 自动化浏览器帧率仍被锁在 30 Hz 档位，本轮只记录 draw calls、三角形和 `[init]`，没有用它下 FPS 结论。
- LOD：近/远阈值和 180/198 m 迟滞带原样保留，远景几何和投影行为未改；新增单测在 179/190/197.9/198.1 m 来回检查，近冠在迟滞带内保持不切、只有越过 198 m 才切远冠。远景仍是低模冠，近景子格边界附近会出现“叶卡树旁边有低模树”的轮廓差异，这是只换 near 一档的已知限制。
- 测试：Node 全套 422 → 426 项通过、0 跳过（新增 `tests/sz-tree-crown.test.cjs` 2 项：六树种几何确定性/归一化/预算，图集与共享材质；`tests/sz-trees.test.cjs` 加 2 项：每个树种都有独立近冠网格、近/远迟滞不闪，并把近冠断言扩到叶卡实例属性和按树种统计）。Python 101 项通过。任务书写的 493 项是 S1 删除纽约用例之前的旧基线，本工作树基线实测 422 项。
- 浏览器：`python3 tools/sz/serve.py --port 8158`；改前用 `git archive HEAD` 导出的干净副本同端口服务，保证同一 origin/缓存；改前改后各截同机位图，存 `docs/qa/dsh-cbb3b304-5782/`（`baseline-*.png`、`after-*.png`，含 `after-ficus-close.png`，目录只留本地）。控制台只有既有消息（TSL `this.bNode.getNodeType` 报错、`Vertex attribute "uv" not found` 警告、浏览器扩展的 `MaxListenersExceededWarning`/`ObjectMultiplex`），本轮没有新增应用报错。
- 已知限制：六种树的形态参数、叶色和透光强度都是外观估计；棕榈羽叶只有 16 张卡片，近距离看比真实羽状叶简化；远景全树种仍是低模冠；夜间、雨天和真实桌面窗口的帧率未测。

### P10 无人机连续往返与实例化（2026-11-11）

- 分支 `dsh-e2c175e5-44a3`，提交 `14fb405`（连续往返）、`cb916fd`（实例化）；内容已由 `50f6cf0` 落在 `main`，合并复核时两个文件与 `main` 逐字节一致。
- 往返：新增 `dronePoseAt(route, flight, elapsed)`，按 2 倍航线长度取三角波，端点处同时翻转路径比例、运动方向和朝向；初始 `phase`/`direction` 生效，`turnAtEnds: false` 保留单程停在目标端。停运窗口内仍收在起降点且旋翼不转。
- 合批：每架无人机从 12 个网格（机身、条纹、4 臂、4 旋翼、2 灯）降到 5 个实例网格——机身（机身+条纹+4 臂按顶点色合并）、旋翼、红/绿航行灯、站点（平台+桩合并）；`statistics.meshes` 改为可绘制对象数（5 + 航线数），新增 `instancedMeshes`、`instances`。
- 代价：旋翼和航行灯没有并进机身材质，因为旋翼是半透明、航行灯是不受光，混进去会改变画面；实例矩阵每帧改写，`frustumCulled` 关闭（数量很小）。
- 测试：Node 新增跨两个端点不跳变、两端都到达、返回朝向、停运实例矩阵不变、旋翼持续自转等用例；全套 476 → 489 项通过、0 跳过。本项没有做 draw call 前后测量，只有对象数量对比。

### 车公庙高架车行链路（2026-11-11，对应 REVIEW 第 4 节第 4 步）

- 分支 `dsh-75ff7e49-3276`（rebase 后 `c8c0e73`，合并提交 `6a586c7`）。文件：`sz-elevated-roads.js`、`sz-traffic.js`、`sz-auto-drive.js`、`sz-drive-route.js`、`sz-controller-surfaces.js`、`main.js`、`sz-qa.js`。
- 计划：每条链路派生 `maxGrade`；只有非隧道、`layer>0`、纵坡 ≤12% 的链路进入 `drive.links`（当前快照 33 条、约 5.74 km 桥面）。`buildSzElevatedRoads` 用与渲染同一批顶面三角面建 `drive.heightAt(x, z, surfaceId)`，并在共享节点处按高差 ≤0.35 m、走向顺滑度生成 `driveSuccessors`。
- 车流：`createTrafficGraph({ elevated })` 把桥面作为带 `surfaceId` 的双向边接入；`heightFor(x, z, edge)` 有表面身份时只查桥面三角面，否则走地面沥青，桥下车辆不会被吸到桥上。桥面中途不生成车辆，约一半环境车从带高架后继的落地引道出发；路线预算对高架段加长，避免车停在桥面。
- 规划/自动：`hasRoadFootprint`、`permitMove`、`poseOnRoute` 接受表面身份，并按附近 ±8 m 内的段身份逐点回退；`validateSamples` 对桥面位姿跳过“地面支撑/建筑净空”检查（运行时碰撞仍由控制器执行），窄路面额外限速；`createDrivePlanner` 返回走过的 `surfaces`。
- 控制器：`climbableFromGround` 只允许在桥头、且高差在 `maxStepUp` 内从地面踏上桥面；多条并行缎带重叠时按 `driveSuccessors` 交接，不再按几何最近吸附。
- 测试：Node 新增高架链路筛选、纵坡上限、后继顺序、桥下地面保持地面、真实快照 403→6595→11114 链路与渲染桥面高度一致等用例；全套 476 → 489 项通过、0 跳过。Python 104 项通过。
- 未做：draw call / 帧时前后测量；玩家手动驾驶上桥、自动驾驶路线和环境车流的完整实际走通验收。

### V3 海面法线波浪与夜间岸线反光（2026-11-11）

- 分支：`dsh-b56ae6f1-c908`（worktree 独立分支，基线 `36a2a45`）。范围是 V3 的前半部分：只做海面，不改数据；没有重建 `js/sz-city.json.gz` / `js/sz-city.szc.gz`，没有改 `js/sz-materials.js`（避免和 V2/S4 的同文件冲突），`ref/` 只读。
- 新增 `js/sz-water-material.js`（370 行，只新建这一个运行时代码文件）：
  - `getWaterWaveTexture()`：进程内缓存 256×256 RGBA HalfFloat `DataTexture`，固定种子 mulberry32 `0x2f6b9d1` + 复高斯谱 + 逆 FFT + 9 级手工 mip（256→1），RepeatWrapping / LinearMipmapLinear / anisotropy 8。RGBA 分别是每块单位 RMS 的坡度 dh/du、dh/dv、坡度平方和高度，mip 在 float 里手工求均值，采样返回像素足迹内的平均坡度与平均坡度平方，两者之差就是解析不了的细浪坡度方差（LEAN mapping）。
  - `createSzWaterMaterial({ coastal })`：按变体缓存。4 层不同尺度/旋转/漂移的波浪贴图（61 / 23.3 / 8.7 / 3.3 m）加风斑噪声驱动能量 → `normalNode`；`roughnessNode = clamp(variance^0.25 + pond·0.05, 0.08, 0.65)`；`metalnessNode` 用水的菲涅尔（F0≈0.02）承载 SSR 反射；白天体色是珠江口绿灰（海面深水 `0x1f312b`、含沙浅滩 `0x49563f`、浪峰透光 `0x71835a`，内河更暗更绿 `0x15241a`/`0x33432a`），不是纽约的深蓝绿；夜间解析岸线反光：反射射线朝城市一侧（深圳湾城市在北，世界 z 向南为正，所以 −R.z > 0）时，在 1.6 km 外、140 m 高的楼群带里画 3.6 m 开间 × 3.3 m 层高亮窗、底层店铺光和 30 m 间距的岸线灯，用未解析坡度方差做盒滤波拉成竖条，最后乘菲涅尔和 `cityUniforms.uInteriorGlow` 的夜间权重；白天用 `If` 门控直接跳过。只读 `cityUniforms`，不写；不 import `sz-materials.js`。
  - 与参考的偏差：没有搬纽约的曼哈顿解析天际线（那需要 ISLAND_BOUNDS/岸线/跨河地块数据），深圳湾是开阔湾面，改用武汉的固定距离城市带骨架，再按深圳湾尺度调距离、高度、地块宽度；岸线灯带不跟随真实湾岸线、后海湾凹口和香港方向，是外观近似。
- 接线：`js/sz-sea.js` 改用 `createSzWaterMaterial({ coastal: true })`，几何、`heightM`、`userData.source`、dispose 都没改；`index.html` 在 `sz-sea.js` 后补一条 `modulepreload`（boot 测试要求模块图里的相对 import 全部预载）。`sz-materials.js` 的旧 `createWaterMaterial` 按范围保留未删，目前没有调用者。
- 测试：新增 `tests/sz-water-material.test.cjs` 4 项（入口接线与预载、贴图尺寸/类型/9 级 mip/跨加载确定性、两种变体的五条节点通道与缓存、TSL import 完整性静态守卫）；`tests/sz-ground.test.cjs` 的 `sz-sea.js` 桩补 `./sz-water-material.js`。全量 `python3 tools/qa/check.py --scope full`：Node 484 项通过、0 跳过（本轮基线 480 + 新增 4），Python 110 项通过。过程中有一次全量 Node 在浏览器并发负载下出现 1 项失败（`tests/sz-building-details.test.cjs` 的 "streams 200 m detail chunks in and out around the player"，期望更新顺序 `[2,1]` 实得 `[1,2]`），单独重跑和随后全量都通过，判定为既有时间敏感用例的偶发抖动，不是本轮引入。
  - 静态守卫的由来：首版 `hash2D` 用了 `sin` 但顶部 `three/tsl` import 漏了它。Node 侧只建节点、不执行 Fn 体，所以 Node 测试全绿；浏览器真正构建着色器时才抛 `ReferenceError: sin is not defined`，海面变纯黑。修复后补了“文件里调用的 TSL helper 必须在顶部 import”的守卫（用 three/tsl 导出清单比对），并验证过把 `sin` 去掉后守卫会失败。
- 浏览器（`python3 tools/sz/serve.py --port 8095`；改前用 `git archive HEAD` 的干净导出跑 8096；同一 ego-browser 会话、1600×900、DPR 1、HUD 隐藏、`?qa=1&cam=` 固定机位、四时段。中途自动化 Chrome 的 GPU 编译态异常（单页 60 s 只推进 13–75/873 个着色器 job，改前基线同样慢），按已知环境问题处理：重启 ego Chrome、保留 profile 的 shader 缓存后恢复正常，单次 load 回到约 6–7 s；前后截图与 compile 都用恢复后的同口径，失败那次不计入结果）：
  - 机位：深圳湾公园水岸 `?qa=1&cam=-7462,9.6,2681,-8900,4,4600`；深圳湾大桥远景 `?qa=1&cam=-10804.1,35.85,4963.3,-10530,30,7270`。
  - 改前：海面是平坦灰绿面，只有旧材质两组正弦波留下的粗平行条带，没有太阳耀斑、没有岸线倒影，midnight 水面全黑。
  - 改后：细碎连续波浪、掠射角有太阳耀斑、水体呈绿灰—橄榄色；twilight/midnight 保留细波纹；夜间朝后海天际线方向出现拉长的岸线灯光反射。8 对同机位对比图和 4 张夜间证据图在 `docs/qa/dsh-b56ae6f1-c908/`（只留本地，不进 Git）。
  - 像素差（1600×900，before vs after）：白天两机位 RMSE 0.14–0.22、变化像素 45–49%（基本就是海面整体换材质）；twilight 0.035–0.050；midnight 0.011–0.013。夜间证据机位 midnight RMSE 0.115、变化像素 27.2%，倒影带来了实质变化。
  - 性能：海面网格 2,385 三角形、`heightM=0`、`verticalDatum=EGM2008` 改前改后相同；after 8 张的 drawCalls mean 128–173、三角形 mean 0.78–1.30 M，都在 [10 号](10-PERF-QA.md) 的 1500 draw call / 600 万三角形预算内。自动化浏览器这次在新 Chrome 窗口里被锁在约 30 Hz（after 记录的 fps ≈28），按 [25 号](25-FAST-CHECKS.md) 和 10 号规则不把自动化浏览器的帧率当性能结论；本轮只用 draw calls/三角形和 compile 说明开销没有明显变化。
  - 控制台：after 两轮共 12–13 次加载只剩既有 `THREE.TSL: TypeError: this.bNode.getNodeType is not a function`，没有新的 TSL/WGSL/boot 错误；修复前的 `sin is not defined` 已消失。
  - compile（`__szQA().startupMs.compile`，机位 1、midday、3 次全新整页加载）：改前 1045 / 1072 / 1232 ms，中位 1072 ms；改后 1048 / 884 / 1049 ms，中位 1048 ms（−24 ms，−2.2%，仍在改前波动范围内）。`[init]` 全阶段合计中位 5727 → 5444 ms；导航到 ready 约 6.0–6.3 s（波动区间见两份 JSON，未挑值）。
- 碰撞和海岸线：本轮只改材质和入口，`js/sz-sea.js` 的几何、`geo.land`/`geo.water`、`js/sz-spatial.js`、地形挖洞规则都没有改；`tests/sz-ground.test.cjs` 仍断言深圳湾大桥北塔处水面 y=0、香港侧无海面、公园保持干燥，改前改后都通过；海面三角形数和 verticalDatum 同上。没有做玩家人工走查水面碰撞（这次不涉及碰撞面；需要时另按 10 号路线走）。
- 已知限制：
  - 夜间反光是固定解析带，不跟随真实深圳湾岸线走向、后海湾凹口和香港方向的灯光；整体强度是按开阔湾面压过的近似，不是实测。
  - 低仰角看海面时菲涅尔反射占主导，画面偏天空的蓝绿；绿灰体色在中高视角和大桥远景更明显。若要求任何角度都更“绿灰”，需要再压 metalness 或按视角混体色，属后续调色。
  - 内河/水库的 `coastal=false` 变体已实现（更暗更绿、波纹更细、夜间四面 360 m 楼群带）但本轮没有接线，按任务范围留给内河数据任务。
  - 波浪幅度、颜色和夜间楼群参数都是外观估计，不是实测；twilight 水面偏暗橄榄，见截图。
- 截图和原始记录：`docs/qa/dsh-b56ae6f1-c908/`（只留本地）：`before-*`/`after-*` 8 对、`night-city-*` 4 张、`compile-before.json`、`compile-after.json`、`compare-after.json`、`after-observations.json`。

#### V3 附带调查：内河/水库在画面里确实不可见（只报告，不修；给 3-3 批 I）

结论（代码 + OSM + 浏览器截图三证）：

1. **数据里有面，但只有面**：`geo.water` 622 个多边形、780 个环（158 个洞）、13,695 个顶点、净面积 7.671 km²。`tools/sz/land.py:48` 已经拿到 `id`/`name`，但 `tools/sz/build.py:177` 写包时只写 `enc_poly(w['poly'])`，id/name/tags 全部丢掉；payload 里的 water 只有 delta 分米编码的纯几何。
2. **生成器把水挖成洞，没有生成水面**：`tools/sz/terrain_surface.py:40` 把 water 从陆地可生成地表里完全减掉，生成器自己标了 `waterSurface: not-generated`、`waterLevelsGenerated: false`；`tools/sz/sea_surface.py:71` 只取海侧再减陆地，内河/湖在水体内部不会进 seaSurface。
3. **运行时只把 geo.water 当空间索引**：`js/sz-spatial.js:39/44/76` 建 water 索引、算 isOnLand/isWater/groundHeight；2D 地图会画水（`js/sz-map-layers.js:245`、`js/sz-map.js:491-493`），3D 侧只有 `js/main.js:169-170` 的 ground + sea，没有 water 网格。
4. **画面里看到的是“洞透天穹”**：洞内没有地面、海面或残留路面（道路也由同一份 terrainSurface 裁出），`scene.background=null` + 360° SkyMesh（`js/lighting.js:138-146`）让视线打到天空/雾，所以河道和湖盆呈现浅灰白色空腔。用共享包实测：622/622 个 water 多边形面内代表点的地面采样都是 `null`；5 个 QA 点均不在 seaSurface 内。浏览器 midday 截图：大沙河下游/上游、新洲河中游/下游、香蜜湖的河/湖位置都是浅灰白空带或空盆，洞口是硬切边；海面同机位对照图正常。截图见 `docs/qa/dsh-b56ae6f1-c908/inland-*.png`。
5. **身份匹配**（pyosmium 只读 PBF + 质心/包围盒匹配）：

   | 目标 | geo.water index | OSM | 类型 / payload 面积 |
   | --- | --- | --- | --- |
   | 大沙河下游 | 2 | way/25603390（沙河河畔） | natural=water，181,420 m² |
   | 大沙河上游 | 0 | way/9764162 | natural=water，60,624 m² |
   | 新洲河 | 342–347 | way/2207998xx | water=river，合计 50,612 m² |
   | 香蜜湖 | 1 | way/25482483 | water=lake，221,148 m² |
   | 西丽水库 | 包内不存在 | rel/3290940（西丽湖） | 南岸在 phase1 北界外约 602 m |

   额外缺口：新洲河中心线在范围内 5,919 m，只有 43.9%（2,598 m）有水面多边形，缺 3.3 km；大沙河 100% 有面。

6. **3-3 批 I 的补齐清单**（完整版和证据行号见本地 `docs/qa/dsh-b56ae6f1-c908/inland-water-gap.md`；数据增量估计 +10~20 KB gzip）：
   - 共享包 data 层，**必须**：`water.version`；`water.source{osmSnapshotId, verticalDatum, heightMethod, heightSource}`；每条 `entries[].rings`（沿用 enc_poly）、`kind`、`levelM`、`minDisplayAreaM2`、`osmId`、`tags{natural/water/waterway/landuse}`、`heightSource/heightMethod`。`levelM` 不能写死 0：用 DEM 在面内采样中值（现有 DEM 实测大沙河约 1.6 m、新洲河 5.6–7.1 m、香蜜湖 12.5 m），标注为估计值。
   - **可选**：`lodSimplifyM`、`lodDistanceM`、`areaM2`、`centroid`、`name`、`sourceUrl`、`flowDeg`、`flowSpeedMps`（视觉估计）、`maxWaveAmplitudeM`、`navigable`；岸壁裙边不写字段，运行时用 terrainSurface 采样环顶点反算。
   - 管线：`land.py:42-49` 透传 tags 子集，`build.py:177` 改为写条目对象（或平行数组 + enums，参考 buildings 的 name 索引），新增 kind 映射与水位计算。几何 rings 现有即可，不需要新采数据；外部数据仍只用现有 OSM PBF + Copernicus DEM。
   - 运行时：新增 `js/sz-water.js`，用本轮的 `sz-water-material.js` 非 coastal 变体、按 `levelM` 平铺、1–2 km 分块合并、用 terrainSurface sampler 在环顶点取岸高做 1–2 m 裙边；`main.js:169-170` 之后挂 `buildSzWater(scene, GEO.water)`；`js/sz-data-format.js` 新增 `validateWater`（参考 `validateSeaSurface`）。`sz-spatial.js` 的 isWater/groundHeight 语义保持不变，水面高度只用于渲染/相机。
   - 验收：terrainSurface 继续挖洞（现有 `tests/sz-ground.test.cjs` 的 narrow water cut 断言保留）；5 组机位（大沙河上/下游、新洲河中/下游、香蜜湖）日夜截图；海/河共用同一材质实现；重建两个共享包时必须遵守 [HANDOFF](HANDOFF.md) 第 8 节的单分支规则。
   - 不在本任务：西丽水库要画需北扩 phase1 或明确“本期不含”；新洲河 3.3 km 无面缺口需要先定宽度来源并标估计，另立数据任务。

### S4 日夜状态只写一处（2026-11-11）

- 分支 `dsh-4fd71333-f268`（原计划 `m9-night-uniform`），提交 `9ea9d74`（`Share one night uniform across lighting and city modules`）。V2 在同一分支单独提交 `ea73ead`，见下一条。
- 做法：日夜系数只保留 `js/sz-materials.js` 的 `sceneUniforms.night` 一份。`js/lighting.js` 把它当 `this.uNightFactor`（同一个 uniform 对象），`applyPreset` 是唯一写入点，天空和城市材质自动同步；入口 `js/main.js` 删掉 `sceneUniforms.night.value = lightingSystem.uNightFactor.value` 的转抄，也不再给模块传夜间系数。`sz-street-lamps`、`sz-apec`、`sz-apec-city` 在 `update()` 里直接读 `sceneUniforms.night.value`（保留原来的 clamp 语义）；`sz-light-show` 的 `update()` 自己按 `> 0.25` 改 `group.visible`，入口只调用 `lightShow.update()`。
- A5 复核：`rg -n "cityUniforms" js/sz-*.js` 现在命中 `js/sz-materials.js`（另有 `sz-road-material.js` 早已在读时段参数），深圳模块不再各自持有一套夜间状态。
- 测试：新增 `tests/sz-night-uniform.test.cjs` 3 项契约（单写点、入口不再转抄/传参、四个模块直接读 uniform 且无 `nightFactor` 参数）；`sz-street-lamps`/`sz-apec`/`sz-apec-city` 的运行期用例改成写 `sceneUniforms.night.value`，并新增路灯透明度 0→0.72/0.9、APEC 主题自发光随 uniform 增强、灯光秀 `group.visible` 阈值三项行为断言；`lighting-shadow.test.cjs` 补 `./sz-materials.js` 桩。Node 全套 485 项通过、0 跳过；Python 105 项通过。
- 浏览器（`python3 tools/sz/serve.py --port 8097`；改前用 `git archive HEAD` 导出的干净副本在 8098，同一 ego-browser、同一页、同口径）：
  - 机位：福田 CBD `?qa=1&cam=-900,10,1069,-426,140,1069`、深南大道 `?qa=1&cam=-400,9.4,438,-120,12,438`；四个时段各截改前改后共 16 张，另有 APEC 大屏午夜补充 2 张，截图和原始记录在 `docs/qa/m9-night/`（只留本地）。
  - S4 验收：独立探针在每次切档后等渲染循环至少再跑 4 帧，读 15 个字段 × 4 时段（灯光秀 `group.visible`、路灯 Points/加性叠加不透明度与可见分块、APEC 大屏、围挡、主题标牌 emissive），改前改后逐值相同（容差 1e-6，0 处差异）：golden/midday 灯光秀隐藏、路灯 0；twilight 灯光秀显示、路灯 0.252/0.2016、大屏 0.566、围挡 0.1496、标牌和 108.038；midnight 路灯 0.774/0.6192、大屏 1.117、围挡 0.3352、标牌和 109.691。`apecTheme`/`apecCity` 全程可见。
  - 像素：APEC 大屏午夜 meanAbsDiff 0.0007、变化像素 0.47%、平均亮度 0.2023→0.2025，属于车流/人群位置差异。
  - `[init] compile`：改前 7 个样本中位 1177 ms，改后 1064 ms（−9.6%）；单样本约 ±20% 离散、区间大幅重叠，按噪声处理（这条同时覆盖 V2 的着色器增长）。其余阶段量级不变。
- 结论：模块夜间表现和改前一致；16 张同机位图的像素差异只来自 V2 的窗灯/玻璃（见下条），S4 本身不改变夜景。

### V2 立面窗灯接 uInteriorGlow 与幕墙玻璃（2026-11-11）

- 提交 `ea73ead`（`Drive facade window glow from city interior glow and raise curtain-wall glass`），文件 `js/sz-materials.js`，测试 `tests/sz-facade-material.test.cjs`，另给加载 `sz-materials` 的 `tests/sz-ground.test.cjs`、`tests/sz-bay-bridge.test.cjs` 补了 `city-lighting-materials` 桩。
- 窗灯：`createBuildingMaterial` 的窗灯和首层灯改读 `cityUniforms.uInteriorGlow`（`js/lighting.js` 的时段参数：golden 0.48 / midday 0.24 / twilight 1.25 / midnight 1.55），不再只乘 `sceneUniforms.night`：
  ```js
  glowGate = smoothstep(0.5, 1.2, uInteriorGlow)
  glowStrength = glowGate * min(uInteriorGlow * 0.9 - 0.28, 0.95)
  ```
  逐档强度 0 / 0 / 0.845 / 0.95；对最亮套间窗的平均亮度，黄昏是旧 `night` 公式的 3.02 倍、午夜 1.10 倍，首层灯光黄昏 3.28 倍；golden、midday 仍严格为 0。逐套间确定性、办公室冷白/住宅暖黄不变。
- 幕墙玻璃（参考 `createCurtainWallMaterial` 695 行）：满玻璃率幕墙金属度 `glazing * mix(0.5, 0.72, curtain)`（curtain=1 时 0.72），玻璃粗糙度 0.12→0.055，并在窗台附近叠加只给幕墙的积灰（≤0.12）；`colorNode` 增加一层菲涅尔天空反射 `mix(glassTint*paneTone, mix(uSkyHorizonColor, uSkyTopColor, fresnel), fresnel*0.62*glazing)`。非幕墙开窗玻璃仍是旧的 0.5×glazing 金属度和 `mix(0.42,0.12,glazing)` 粗糙度（有单测断言住宅≈0.336）。
- 节点预算：colorNode 506→524（上限 600），合并图 551→585（上限 700），没有为反射再复制材质或增加着色器分支。
- 测试：`tests/sz-facade-material.test.cjs` 改为加载真实 `city-lighting-materials.js`，CPU 求值器补 `clamp/pow/normalize/cameraPosition` 和颜色 uniform 摊平；新增“黄昏明显亮于旧 night 公式、午夜不超过黄昏 1.5 倍”“满幕墙金属度≥0.6、粗糙度≤0.12、实体墙≤0.1、住宅开窗保持旧值”用例；Node 全套 485 项通过、0 跳过。
- 浏览器同机位对比（同上 2 机位 × 4 时段 + APEC 午夜）：
  - 黄昏窗灯明显变亮：CBD 整帧平均亮度 0.3266→0.3540（+8.4%），11.71% 像素亮度增加 >8/255、11.77% 像素有变化，是 8 对里变化最大的一对；切掉前景路面的顶部 70% 立面带 0.3447→0.3633、7.89% 像素变亮。深南大道机位整帧 0.2381→0.2389（1.36% 像素变亮），因为画面主要是路面和天空、只有远处少量立面，作为“无副作用”对照。
  - 午夜窗灯只小幅变亮：CBD 整帧 0.1106→0.1139（1.12% 像素变亮）；深南 0.0975→0.0978。白天 golden/midday 的变化来自幕墙天空反射（CBD meanAbsDiff 0.0019/0.0023，深南 0.0046/0.0049），整帧平均亮度基本不变。
  - 同一批截图里 APEC 大屏午夜 meanAbsDiff 0.0007、路灯和灯光秀由 S4 探针逐值证明一致；页面和控制台没有新增应用报错（只有浏览器扩展自身告警）。
- `[init] compile`：同 S4 的 7 样本中位 1177→1064 ms（−9.6%），单样本约 ±20% 离散，判断为噪声；V2 新增的 34 个节点没有造成可测的编译上升。
- 室内景深评估（本轮不做）：
  - `evaluateApartmentInterior` / `apartmentInteriorBehind`（参考 230 / 401 行）每个玻璃像素要算世界空间视线 ray-box 三轴 slab 交点（3 次 tFar 加两次 min）、按楼层房间模块（2–3 开间、相位和 3 个房间哈希）、左右窗帘与灯具条带，再按 `fwidth` 做远景聚类和 LOD 收敛。
  - 这里的共享楼体材质覆盖全城普通楼，玻璃像素是出现频率最高的表面；每像素多约 60–120 条依赖 ALU 和若干临时寄存器，直接压在最忙的片元路径上。导数 `fwidth` 还必须在分支外求，覆盖率门控只能省一部分算力。
  - 节点图和寄存器压力会推高 Dawn/Naga 冷编译时间与 pipeline 数量（当前 colorNode 已 524 节点），编译风险和帧时间风险叠加。
  - 只值得给高玻璃率的 glass_tower / landmark / office（fid 0/1/7）做；但 `fid` 是 attribute，无法统一分支，按楼型分流就得再复制一套材质，等于多一个 pipeline、多一次编译。
  - 因此必须单独测量：CBD 机位（深南大道/福田站）冷启动编译毫秒数 + 连续帧 GPU 时间，与现状同机位对比，再决定是否为高玻璃率楼单独建材质。本轮保持不做，既守住编译预算（colorNode 524 / 合计 585），也不影响窗灯与幕墙反射的观感收益。
- 已知口径/限制：
  - 窗灯现在只由 `uInteriorGlow` 驱动；如果以后给 `night` 加渐变动画，窗灯不会跟着渐变（时段仍是瞬时切换）。
  - golden 的 0.48 距 gate 起点 0.5 只差 0.02，以后调整时段参数若把 golden 抬过 0.5，会在白天点亮窗灯。
  - 午夜窗灯比改前亮 1.10 倍；若实机觉得过亮，只需调 `glowStrength` 的 0.95 上限。
  - 深南大道机位的黄昏窗灯增益被路面/天空稀释，验收以 CBD 机位为准。
