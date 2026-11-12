# 26 深圳运行时模块盘点

盘点日期：2026-11-11。基线：Node 531 项通过、0 跳过；Python 145 项通过（合并 S4/V2、水面与乘员上下车之后）。
对象：`js/` 下 69 个顶层模块 + `js/sz-landmarks/` 下 18 个文件，共 87 个文件、35,424 行。
本文按**模块**组织，回答三件事：每个模块做什么、哪些实现重复、哪些该拆。按任务编号组织的结论见 [22 号优化审查](22-OPTIMIZATION-REVIEW.md)。

行数、导出、调用方均由命令生成（`grep -c ''`、`grep -n "^export"`、相对 import 反查），不是凭记忆写。地标模块的“相关测试”按模块名匹配，属近似值。

## 1. 口径

| 项 | 说明 |
| --- | --- |
| 层级 | 深圳自有 69 个（51 顶层 + 18 地标）；纽约保留引擎 18 个，只登记不改 |
| `three` | 是否在文件顶部 `import ... from 'three/webgpu'`；标 `-` 的可以在 Node 里直接测 |
| 被谁用 | 只统计 `js/` 内的相对 import；测试与工具脚本不计 |
| 文件路径 | 表格里的“文件”列相对 `js/`；地标模块写成 `sz-landmarks/xxx.js` |
| 结论 | 保留 / 复用（指向第 11 节）/ 拆分（指向第 12 节）/ 删除 / 未核实 |
| 维护 | 新增或删除模块时同一次提交内更新本表；行数变化超过 10% 时在“变更记录”写一行 |

## 2. 启动与数据（6）

| 文件 | 行 | three | 职责 | 主要导出 | 被谁用 |
| --- | ---: | :--: | --- | --- | --- |
| `main.js` | 996 | ✓ | 入口：加载阶段、建场景、接线、输入、帧循环、存档 | 无（副作用入口） | — |
| `sz-geodata.js` | 68 | - | 城市包单例：读包、解码、导出 `GEO` / `REAL_BUILDINGS` / `CITY_PAYLOAD` / `DATA_TIMINGS` | 4 个常量 | 7 处（见第 3 节重复项） |
| `sz-data-format.js` | 503 | - | 数据适配：JSON 与 SZC1 解码、契约校验、坏包报错 | `decodeCityPayload`、`validateCityPayload`、`readCityPayload`、`decodeFastCity`、`decodeSites`、`decodeRing`、`decodePoly`、`CityDataError` | `sz-geodata` |
| `sz-strings.js` | 222 | - | 玩家可见文字，代码只引用键名 | `STR` | 8 处（`main`、`sz-ui`、`sz-map`、`sz-vehicles` 等） |
| `sz-city-config.js` | 233 | - | 城区配置：范围、出生点、传送点、位置名、纽约两相位时刻表 | `createCityConfig`、`SIGNAL_TIMING`、`signalPhase`、`walkSignal`、`isTypingInField`、`headingFromBearing` 等 17 个 | 7 处 |
| `sz-qa.js` | 303 | ✓ | QA 调试入口：`?qa=1` 快照、跳阶段、传送、固定机位、帧与 GPU 采样 | `createQaSession` | `main` |

**关键接缝问题**：`GEO` / `REAL_BUILDINGS` / `CITY_PAYLOAD` 被 `main.js`、`sz-buildings.js`、`sz-camera-presets.js`、`sz-city-config.js`、`sz-map-layers.js`、`sz-map.js`、`sz-qa.js` 直接 import；另一半模块（`sz-roads`、`sz-elevated-roads`、`sz-traffic`）从参数收 `graph` / `terrain`。同一个数据有两种进法。
`sz-city-config.js:224-233` 的 `MANHATTAN_COASTLINE`、`BROADWAY_LINE`、`WATERFRONT_PIERS`、`EAST_RIVER_BRIDGES`、`OUTER_BRIDGES`、`CUT_Z`、`streetZ`、`avenueX`、`getBroadwayX`、`fromOldFrame` 已无调用方，只有测试断言它们抛错 —— **删除候选**。

## 3. 基础工具（9）

| 文件 | 行 | three | 职责 | 主要导出 | 被谁用 |
| --- | ---: | :--: | --- | --- | --- |
| `sz-polygon.js` | 147 | - | 纯几何：环面积/周长/质心/采样/包含（含边界）/最大环/地标中心 | 13 个 | 11 处 |
| `sz-geometry.js` | 183 | ✓ | `GeoBuilder` 与平面/墙/缎带三角面 | `GeoBuilder`、`addFlatPolygon`、`addWalls`、`addRibbon` | 5 处 |
| `sz-mesh-utils.js` | 79 | ✓ | 部件合并（位置/法线/索引/顶点色）与 canvas 贴图 | `mergeParts`、`canvasTexture` | 3 处 |
| `sz-terrain.js` | 27 | - | 地形高度查询与单元三角（东北—西南对角线，不做双线性） | `terrainHeight`、`terrainCellTriangles` | 11 处 |
| `sz-spatial.js` | 79 | - | 城市空间索引：楼、树、水、公园的近邻查询 | `createCitySpatial` | `sz-city-config` |
| `sz-building-layout.js` | 24 | - | 楼体放置与源 ID 稳定种子 | `buildingPlacement`、`buildingSeed` | 5 处 |
| `sz-ground-surface.js` | 97 | - | 派生地面三角面、采样器、显示与接触同源 | `unpackSurface`、`sampler`、`createGroundSurfaceSampler` | 3 处 |
| `sz-controller-surfaces.js` | 181 | - | 接触面解析：地形 / 桥面 / 屋顶，抬脚高度与并行缎带交接 | `triangleHeight`、`createSurfaceHeightAt`、`createSurfaceResolver` | 2 处 |
| `sz-intersection-control.js` | 127 | - | 路口控制：相位、停线、进入许可、路线停点 | `signalPhase`、`insideSignalBounds`、`createIntersectionControl`、`routeSignalStops` | 4 处 |

## 4. 地面与道路（9）

| 文件 | 行 | three | 职责 | 主要导出 | 被谁用 |
| --- | ---: | :--: | --- | --- | --- |
| `sz-roads.js` | 474 | ✓ | 地面道路：链路点、带横断面的行驶线、路面布局、高度采样 | `buildSzRoads`、`roadLinkPoints`、`roadTravelPoints`、`isGroundRoad`、`createRoadSurfaceLayout`、`createRoadPolygonLayout`、`createRoadHeightSampler`、`convexHull` | 7 处 |
| `sz-road-material.js` | 320 | ✓ | 沥青与标线材质（磨损、补丁、湿润） | `createSzRoadSurfaceMaterial`、`createSzRoadPaintMaterial` | 2 处 |
| `sz-road-markings.js` | 139 | - | 标线布局：车道计划、双黄线、边线、停止线 | `createLanePlan`、`createMarkingLayout` | `sz-road-paint` |
| `sz-road-paint.js` | 71 | ✓ | 把标线布局建成网格 | `buildSzRoadPaint` | `main` |
| `sz-road-frontage.js` | 255 | ✓ | 路缘、人行道台阶、路口信号外观 | `buildSzRoadFrontage` | `main` |
| `sz-elevated-roads.js` | 633 | ✓ | 车公庙高架：桥面/匝道/桥墩计划、建场景、车行链路与表面身份 | `planElevatedRoads`、`buildSzElevatedRoads`、`ELEVATED_DRIVE_MAX_GRADE` | `main` |
| `sz-tunnels.js` | 614 | ✓ | 隧道：按 OSM layer 估算埋深、洞身断面与复核清单；与高架共用立交选区 | `planSzTunnels`、`buildSzTunnels`、`TUNNEL_LAYER_DEPTH_M` 等 6 个 | `main` |
| `sz-water-material.js` | 370 | ✓ | 水面材质：风浪贴图法线、坡度方差粗糙度、菲涅尔反射、夜间岸线反光 | `getWaterWaveTexture`、`createSzWaterMaterial` 等 3 个 | `sz-sea` |
| `sz-streetscape.js` | 198 | ✓ | 步行带铺装条带与纹理 | `buildSzStreetscape` | `main` |
| `sz-ground.js` | 101 | ✓ | 地形地面网格 + 采样器 | `buildSzGround` | `main` |
| `sz-sea.js` | 26 | ✓ | 海面 | `buildSzSea` | `main` |

## 5. 建筑与地标（22）

| 文件 | 行 | three | 职责 | 主要导出 | 被谁用 |
| --- | ---: | :--: | --- | --- | --- |
| `sz-buildings.js` | 569 | ✓ | 普通楼：塔楼 + 裙房、屋顶、2.4 km 渲染分块合批 | `buildCityBlocks`、`roofPlan`、`BUILDING_RENDER_CHUNK_SIZE` | `main` |
| `sz-building-details.js` | 1,003 | ✓ | 近景细节：女儿墙、阳台、空调、雨棚、屋顶设备；200 m 流式分块与三角形预算 | `planBuildingDetails`、`buildBuildingDetails` | `main` |
| `sz-building-signs.js` | 940 | ✓ | 楼名、小区门牌、楼顶广告：选墙、图集、200 m 流式 | `buildBuildingSigns`、`planBuildingSigns`、`planSignAtlas`、`selectSignWall`、`normalizeName` 等 24 个 | `main` |
| `sz-light-show.js` | 260 | ✓ | 福田中心区灯带 + 平安钢柱灯带 | `planLightShow`、`planLandmarkBands`、`buildSzLightShow` | `main` |
| `sz-landmarks/index.js` | 30 | ✓ | 地标总装：计划 + 渲染 + 返回 colliders/surfaces/skipIds | `buildSzLandmarks` | `main` |
| `sz-landmarks/layout.js` | 69 | - | 地标注册表：源 ID、构建函数、场地接管 | `planSzLandmarks`、`siteTakeoverIds` | `index` |
| `sz-landmarks/render.js` | 151 | ✓ | 把地标部件建成网格 | `renderLandmark`、`addLandmarkPart` | `index` |
| `sz-landmarks/parts.js` | 99 | - | 地标部件描述（点、混合、基座、足迹、跨段、放样、屋顶板） | 8 个 | 13 处 |
| `sz-landmarks/materials.js` | 191 | ✓ | 地标玻璃/幕墙材质 | `createLandmarkMaterial` | `index` |
| `sz-landmarks/super-hq.js` | 827 | ✓ | 深圳湾超级总部基地（含双塔计划与设计楼高） | `build`、`siteRoles`、`designHeights`、`createSuperHqMaterial` 等 10 个 | `layout` |
| `sz-landmarks/iec-xiangmihu.js` | 502 | ✓ | 国际交流中心（APEC 主会场） | `build`、`gatePoint`、`flowerSeaAnchor`、`createIecMaterial` 等 11 个 | `layout`、`main` |
| `sz-landmarks/upperhills.js` | 459 | ✓ | 深业上城 | `build`、`createUpperhillsMaterial` | `layout` |
| `sz-landmarks/chunjian.js` | 539 | - | 春笋（中国华润大厦） | `build`、`shellProfile`、`standSpec` 等 6 个 | `layout` |
| `sz-landmarks/dji-sky-city.js` | 342 | - | 天空之城 | `build`、`sourceIds` | `layout` |
| `sz-landmarks/shenzhen-bay-bridge.js` | 283 | ✓ | 深圳湾大桥（远景） | `buildShenzhenBayBridge` | `main` |
| `sz-landmarks/shenzhen-bay-culture-square.js` | 278 | ✓ | 深圳湾文化广场 | `build`、`createCulturePavingMask` | `layout` |
| `sz-landmarks/convention-center.js` | 279 | - | 会展中心 | `build` | `layout` |
| `sz-landmarks/civic-center.js` | 302 | - | 市民中心 | `build`、`roofDetail`、`colonnadeSpec` | `layout` |
| `sz-landmarks/ping-an.js` | 288 | - | 平安金融中心 | `build` | `layout` |
| `sz-landmarks/nonferrous-tower.js` | 192 | ✓ | 中金大厦（有色金属塔） | `build`、`createNonferrousMaterial` | `layout`、`materials` |
| `sz-landmarks/chunsun.js` | 97 | - | 春笋旁的小体量补充 | `build` | `layout` |
| `sz-landmarks/tencent-binhai.js` | 30 | - | 腾讯滨海大厦（薄封装） | `build`、`sourceIds` | `layout` |

13 个专模共用 `parts.js` 的部件描述与 `render.js` 的渲染，`layout.js` 是唯一注册表 —— 这是仓库里**接缝放得最对的一处**：新增地标只改三个文件，不动 `main.js`。

## 6. 交通与人（7）

| 文件 | 行 | three | 职责 | 主要导出 | 被谁用 |
| --- | ---: | :--: | --- | --- | --- |
| `sz-traffic.js` | 927 | ✓ | 车流图（含高架边）、路线生成、车流模拟、信号让行、碰撞、统计 | `createSzTraffic`、`createTrafficGraph`、`poseOnRoute`、`laneOffsets`、`laneRoute`、`routeSegments`、`trafficModelBounds`、`writeTrafficCollider`、`usableWidth` | `main`、`sz-auto-drive`、`sz-drive-route` |
| `sz-vehicles.js` | 773 | ✓ | 深圳车型网格、涂装、车牌、出租车顶灯；基于纽约 `cars.js` 的 loft 车身 | `VEHICLE_SPECS`、`createShenzhenCarMesh`、`createShenzhenBusMesh`、`createTrafficVehicleGeometry`、`createSharedCycleMesh`、`createEvtolMesh`、`createCargoDroneMesh` 等 13 个 | `main`、`controllers`、`sz-traffic` |
| `sz-auto-drive.js` | 206 | - | 自动驾驶：路线跟随、移动许可、桥面表面身份、停线等待 | `createAutoDrive`、`hasRoadFootprint` | `main` |
| `sz-drive-route.js` | 242 | - | 地图规划：转向限制、净空、限速、信号停点、桥面路线 | `createDrivePlanner`、`createTurnFilter` | `main` |
| `sz-pedestrians.js` | 632 | ✓ | 环境人群：按地点密度、实例化、路线跟随 | `createSzPedestrians`、`createSzDensityModel`、`seededRandom` | `main` |
| `sz-pedestrian-tracks.js` | 820 | - | 步行带：人行道、过街、连通、铺装条带、碰撞网格 | `buildWalkTracks`、`buildSidewalkTracks`、`connectTracks`、`buildPavementRibbons`、`createColliderGrid`、`createCarriagewayBarrier`、`resamplePolyline`、`offsetPolyline`、`sampleTrack` 等 11 个 | `sz-pedestrians` |
| `sz-park-arrivals.js` | 38 | - | 公园落点查询 | `parkAt`、`findParkArrival` | `main`、`controllers` |

## 7. 街景与环境（8）

| 文件 | 行 | three | 职责 | 主要导出 | 被谁用 |
| --- | ---: | :--: | --- | --- | --- |
| `sz-trees.js` | 618 | ✓ | 树实例、近/远 LOD、1 km 分块、碰撞 | `buildSzTrees`、`planTreeChunks`、`treeLod`、`decodeTreePayload` | `main` |
| `sz-tree-crown.js` | 985 | ✓ | 叶卡树冠：1024 图集、六树种几何、风摆与透光材质 | `createCrownLibrary`、`buildCrownGeometry`、`createTreeCrownMaterial`、`CROWN_SPECIES` 等 10 个 | `sz-trees` |
| `sz-street-lamps.js` | 310 | ✓ | 路灯点位、1 km 分块、光晕 | `buildSzStreetLamps`、`planLampSites`、`groupLampSites` | `main` |
| `sz-metro-entrances.js` | 608 | ✓ | 地铁出入口：石基座 + 玻璃雨棚 + 站名牌 LOD、500 m 分块 | `buildSzMetroEntrances`、`planMetroEntrances`、`ENTRANCE_SIZE_M` 等 6 个 | `main` |
| `sz-station-sites.js` | 858 | ✓ | 福田站地面部分、西丽站在建工地（围挡/塔吊/基坑） | `buildFutianStation`、`buildXiliConstruction`、`FUTIAN_*`、`XILI_*` 10 个 | `main` |
| `sz-apec.js` | 738 | ✓ | APEC 氛围：道旗、会场标识、花坛、转播车、配色 | `planApecTheme`、`buildApecTheme`、`summarizeApecPlan`、`createApecGeometry` 等 32 个 | `main` |
| `sz-apec-city.js` | 613 | ✓ | APEC 城市元素：路侧大屏、巡逻机器人、西丽围挡广告 | `planApecCityElements`、`buildApecCityElements`、`summarizeApecCityPlan`、`SCREEN_SITE_DEFS` 等 18 个 | `main` |
| `sz-drone-routes.js` | 378 | ✓ | 无人机：示意航线、连续往返、5 个实例网格、APEC 停运 | `buildSzDroneRoutes`、`planDroneFlights`、`dronePoseAt`、`isApecAirSuspended` | `main` |

## 8. 界面与镜头（4）

| 文件 | 行 | three | 职责 | 主要导出 | 被谁用 |
| --- | ---: | :--: | --- | --- | --- |
| `sz-ui.js` | 279 | - | 传送菜单、地铁菜单、弹层、快捷键、位置读数、HUD 遥测 | 6 个 | `main` |
| `sz-map.js` | 941 | - | 全图/小地图、搜索、传送、地铁图层、驾驶起终点 | `SZMapSystem`、`NYCMapSystem` | `main` |
| `sz-map-layers.js` | 303 | - | 地图图层与绘制原语 | `MapView`、`mapLayers`、`footprintLayers`、`drawPlayerArrow` 等 10 个 | `sz-map` |
| `sz-camera-presets.js` | 68 | - | 景点机位参数 | `getScenicCamera` | `cameras` |

## 9. 材质（4）

| 文件 | 行 | three | 职责 | 主要导出 | 被谁用 |
| --- | ---: | :--: | --- | --- | --- |
| `sz-materials.js` | 287 | ✓ | 楼体材质、立面档位、水材质、场景 uniform | `createBuildingMaterial`、`createWaterMaterial`、`FACADE_PROFILES`、`sceneUniforms` | 12 处 |
| `city-lighting-materials.js` | 45 | ✓ | 日夜 uniform（`uInteriorGlow` 等）、接触阴影材质 | `cityUniforms`、`createContactShadowMaterial` | 4 处 |
| `sz-road-material.js` | 320 | ✓ | 沥青与标线材质（同第 4 节） | 2 个 | 2 处 |
| `sz-landmarks/materials.js` | 191 | ✓ | 地标玻璃/幕墙材质（同第 5 节） | 1 个 | `index` |

4 个材质模块共 843 行、边界清楚：**不合并**。参考仓库把 3,498 行材质塞进一个 `tsl-materials.js`，是反例。

## 10. 纽约保留引擎（18）

只登记，不改内部结构（AGENTS.md：保留纽约引擎，按矩阵逐个替换）。

| 文件 | 行 | 职责 | 被谁用 |
| --- | ---: | --- | --- |
| `controllers.js` | 1,384 | 第三人称控制器：人/车/自行车/飞行器、接触、输入 | `main` |
| `cars.js` | 2,110 | 车身 loft 引擎、部件、涂装 locale | `sz-vehicles` |
| `pedestrians.js` | 2,213 | 行人骨架、人群、动画 | `sz-pedestrians`、`controllers` |
| `lighting.js` | 319 | 日夜预设与天空/阳光 | `main` |
| `cameras.js` | 318 | 相机系统（追尾/自由/景点） | `main` |
| `audio-system.js` | 522 | 音频总装 | `main` |
| `audio-events.js` | 490 | 事件音（碰撞、鸣笛） | `audio-system` |
| `audio-sources.js` | 232 | 环境音源（车流、人群、步道） | `audio-system` |
| `audio-synthesis.js` | 600 | 程序化合成与车辆声部 | `audio-system`、`audio-events` |
| `audio-acoustics.js` | 102 | 建筑遮挡对声音的低成本近似 | `audio-system` |
| `post-processing.js` | 89 | 后处理链 | `main` |
| `scene-culling.js` | 362 | 静态几何空间剔除 | `main` |
| `vehicles.js` | 52 | 部件与圆角盒工具 | `cars`、`sz-vehicles` |
| `vehicle-physics.js` | 162 | 车辆接触与动量解算 | `sz-traffic`、`sz-auto-drive` |
| `vehicle-lights.js` | 37 | 车灯 | `controllers` |
| `touch-controls.js` | 168 | 触屏输入 | `main` |
| `gamepad-controls.js` | 172 | 手柄输入 | `main` |
| `building-collision.js` | 274 | 建筑/桥面碰撞多边形与接触 | 17 处 |

## 11. 复用矩阵

同一概念有多个实现的地方。合并目标是**一个模块、一处实现**；改一处必须同时改另一处的地方优先。

| 概念 | 现有实现 | 影响 | 合并目标 |
| --- | --- | --- | --- |
| `clamp` | `sz-auto-drive.js:9`、`sz-building-details.js:82`、`sz-building-signs.js:52`、`sz-pedestrians.js:66`、`audio-events.js:5`、`audio-synthesis.js:4`、`audio-system.js:6` | 7 份；边界处理写法已出现差异（是否先做有限值检查） | 新建 `sz-math.js` |
| `lerp` | `sz-tree-crown.js:25`（`cars.js:438`、`pedestrians.js:1096` 属纽约引擎，保留） | 深圳侧 1 份重复 | `sz-math.js` |
| `smoothstep` | `audio-events.js:6` + TSL 内建 | 两套曲线语义 | `sz-math.js` |
| 随机 | `sz-pedestrians.js:70 seededRandom`（导出）、`sz-traffic.js:80 seededRandom`（私有）、`sz-apec.js:194 hash01`、`sz-building-layout.js:20 buildingSeed` | 4 份同族算法；固定种子的可复现性依赖各自实现 | `sz-math.js` 统一 `seededRandom` / `hash01` / `buildingSeed` |
| 折线 | `sz-roads.js:63 roadLinkPoints`、`sz-apec.js:62 linkPoints`、`:70 polylineLength`、`:77 samplePolyline`、`sz-pedestrian-tracks.js:128 resamplePolyline`、`:148 offsetPolyline`、`sz-polygon.js:47 sampleRing` | `linkPoints` 与 `roadLinkPoints` 逐行相同；改链路结构要改两处 | `sz-polygon.js` 收折线；`sz-roads.js` 保留带横断面版本 |
| 点在面内 | `sz-apec.js:221 pointInArea`、`sz-polygon.js:107 ringContains` | 边界语义可能不同（含/不含边） | `sz-polygon.js` |
| 地标底面 | `sz-apec.js:227 landmarkFootprint`、`sz-polygon.js:78 largestRing` + `:100 landmarkCenter` | 可由后两者组合 | `sz-polygon.js` |
| 地面路判定 | `sz-roads.js:59 isGroundRoad`、`sz-apec.js:108 isGroundRoadLink` | 同判据两个名字 | `sz-roads.js` |
| 几何合并 | `sz-mesh-utils.js:8 mergeParts`、`sz-drone-routes.js:117 mergeParts` | 后者是 `6a586c7` 合并时引入的回退 | `sz-mesh-utils.js` |
| 分块键 | `sz-building-details.js:11`（200）、`sz-building-signs.js:7`（200）、`sz-metro-entrances.js:11`（500）、`sz-street-lamps.js:14`（1000）、`sz-trees.js:10`（1000）、`sz-buildings.js:10`（2400） | 6 份各自实现 `Math.floor(x / size)` 键与进入/离开半径 | 新建 `sz-chunk-stream.js`（第 12 节） |
| 围挡常量 | `sz-apec-city.js:59-60`、`sz-station-sites.js:12-13`（3 m / 0.25 m 各一份） | 改一处会静默不一致 | `sz-station-sites.js` 单一持有 |
| 信号 | `sz-city-config.js:16 signalPhase(time, isAvenue)`（纽约两相位时刻表）与 `sz-intersection-control.js:4 signalPhase(group, elapsed)`（真实控制器） | **同名不同义**；`audio-sources.js:1` 读前者，`sz-road-frontage.js:163` 读后者 —— 环境音依据的车流节奏与车流本身不是同一套 | `sz-intersection-control.js` 是真相；前者改名并在调用处注明 |

## 12. 拆分候选

| 对象 | 证据 | 拆分方案 | 收益 |
| --- | --- | --- | --- |
| `sz-building-details.js` 1,003 行 | 超 AGENTS.md 的 ~1000 行；`buildBuildingDetails`（`:723`）11 个选项键，分块索引、排序、三角形预算、每帧预算全在里面 | 抽分块流式到 `sz-chunk-stream.js`；分块规划抽 `planBuildingDetailsChunks` | 文件回到 1,000 行内；预算策略可单测 |
| `sz-metro-entrances.js` 608 行 | `buildSzMetroEntrances`（`:408`）在场景构建里做放置判定（探针高度、道路/步行带/水面/楼体冲突、去重、朝向来源、`skipped` 统计）；`planMetroEntrances`（`:113`）只出候选 | 判定整体搬进 `planMetroEntrances`，builder 只消费 `placed` | 放置策略可无 three 测试；builder 变薄 |
| `main.js` 996 行 | `initApp` 内 17 个嵌套函数（`savePlayerState:308`、`selectMode:498`、`teleportTo:610`、`renderFrame:875`）；`tests/sz-main-startup.test.cjs` 用 25 条断言 grep 源码顺序，`tests/sz-auto-drive.test.cjs:37` 切出源码片段执行 | 抽 `sz-drive-input.js`、`sz-player-state.js`、`sz-frame-loop.js` | 两个“读源码”测试变成调模块；入口回到纯接线 |
| 分块流式（6 处） | 见第 11 节“分块键”；块边长 5 种，进入/卸载半径与每帧预算各写一遍 | `createChunkStream({ size, enterRadius, exitRadius, budgetMs, maxChunksPerFrame, build, dispose })` → `{ update, statistics, dispose }` | 迟滞与预算只实现一次；`statistics` 键成为明确契约 |
| 路网紧凑元组（8 处） | `sz-roads.js:63`、`sz-apec.js:57`、`sz-building-signs.js:155`、`sz-traffic.js:90`、`sz-road-markings.js:19`、`sz-pedestrian-tracks.js`、`sz-elevated-roads.js`、`sz-drive-route.js:11` 各自解 `[start, end, nameIndex, width, lanes, direction, ...inner]` | `sz-road-graph.js`：`createRoadNetwork(graph)` → `{ node, link, links, nearby }`；数据包格式不动 | 元组偏移只出现一次；新增使用者不再抄解码 |
| 数据单例 | 7 个模块直接 import `GEO`；另 10+ 个从参数收 | 单例只留 `sz-geodata.js`，由 `main.js` 往下传 | 测试可用夹具构造，不必桩整个 geodata |
| 死导出 | `sz-city-config.js:224-233` 十个导出无调用方 | 删除并同步删测试断言 | 删除测试通过 |

## 13. 接口不宽不深的地方（按模块）

只列“接口宽度 > 实现深度”的：调用方必须知道很多，但模块本身只是转发。

| 模块 | 问题 | 建议 |
| --- | --- | --- |
| `sz-buildings.js` | `buildCityBlocks(scene, options)` 的选项键由入口拼装，`skipIds`/`renderChunkSize` 语义只在这里生效 | 改成 `buildCityBlocks(scene, { buildings, terrain, skipIds, chunkSize })` 并补 `planCityBlocks` |
| `sz-streetscape.js` / `sz-road-frontage.js` | 依赖以位置参数 + 选项混合传入（`buildSzStreetscape(scene, source, terrain, { groundHeight, roadHeight, colliders })`），与同层其它 builder 的 `{ graph, terrainSurface }` 形状不一致 | 统一成单一选项对象 |
| `sz-apec.js` 32 个导出 | 规划、几何、配色、常量混在一个文件，入口只需要 `planApecTheme` / `buildApecTheme` | 常量与几何分文件；导出收到 6 个以内 |
| `sz-apec-city.js` 18 个导出 | 同上，且 `XILI_HOARDING_*` 与 `sz-station-sites.js` 重复 | 先合并常量，再分文件 |
| `sz-building-signs.js` 24 个导出 | 选墙、图集、材质、流式全暴露；入口只调 1 个 | 只导出 `buildBuildingSigns` + 供测试用的 `plan*` |

## 14. 与其它文档的关系

- [01 架构](01-ARCHITECTURE.md)：分层原则；本文是逐文件事实。
- [22 优化审查](22-OPTIMIZATION-REVIEW.md)：任务编号视角（S1–S4、P、V），本文是模块视角；第 11、12 节与它第 2、5 节互为索引。
- [HANDOFF](HANDOFF.md)：当前状态与下一步；本文不替代交接。
- [TASKS](TASKS.md)：里程碑勾选；本文不勾选任何任务。
- 后续重构批次（`m9-helper-consolidation`、`m9-chunk-stream`、`m9-plan-seam`、`m9-road-graph`、`m9-main-systems`）以本文第 11、12 节为任务来源。

## 15. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-11 | 首次盘点：85 个文件、33,491 行；Node 489 / Python 104 基线。登记 12 组重复实现、6 项拆分候选、10 个死导出 |
| 2026-11-11 | 合并后复核：补登 `sz-tunnels.js`、`sz-water-material.js`，总数为 87 个文件、35,424 行；Node 531 / Python 145 为新基线 |
