# 架构与基础组件

## 运行方式

`index.html` 的 import map 锁定 three.js 0.187.0。`js/main.js` 装配 WebGPU 场景，TSL 负责材质；原生 ES Modules，无构建期打包。纽约底座保留控制、人物、车身、相机、光照、音频与后处理，深圳模块负责地理和场景内容。

```text
离线快照 → tools/sz/build.py → 城市双包与报告
index.html → sz-geodata（校验/解码）→ main 的 site 数据与共享表面
  → 地面/道路/桥面 → 建筑/地标/街景
  → 控制器/交通/人群 → 相机/光照/音频/地图 → 帧循环
```

`GEO` 是空间数据，`REAL_BUILDINGS` 是建筑记录，`site` 是入口传给消费者的组合上下文。部分模块仍直接导入单例，部分通过参数接收。`plan*` 通常算布局，`build*` 通常创建网格；并非所有规划函数都已从渲染拆出。组件拥有自己的动态更新与资源释放，入口统一调用。

## 组件索引

下列路径相对 `js/`；列主要方法供定位，不复制全量导出或易过期行号。存在文件不等于已挂场景，接入与验收见 HANDOFF。

按功能阅读：[道路](03-ROADS-GROUND.md)、[建筑](04-BUILDINGS.md)、[地标](05-LANDMARKS.md)、[街景](06-STREETSCAPE.md)、[载具](07-VEHICLES.md)、[无人机](08-AIR.md)、[界面](09-UI-GAMEPLAY.md)、[商圈](REGIONS-PLACES.md)、[灯光秀](LIGHT-SHOW.md)。各页保留功能、关键方法、实现边界和相关验证，本表用于全局定位。

| 组件 | 文件与主要入口 | 内容与方法 |
| --- | --- | --- |
| 启动装配 | `main.js`、`sz-startup.js::waitForFirstFrame` | 阶段计时、首帧等待/重试、场景/输入/存档/帧循环 |
| 数据读取 | `sz-geodata.js`、`sz-data-format.js::readCityPayload/validateCityPayload/decodeCityPayload` | 一次加载，JSON/SZC1 校验解码，错误阶段与读取耗时 |
| 城区配置 | `sz-city-config.js::createCityConfig`、`sz-spatial.js::createCitySpatial` | 覆盖、水陆、出生/传送、地点名、楼树水公园索引 |
| 文案与QA | `sz-strings.js::STR`、`sz-qa.js::createQaSession` | 中文文案；仅本机显式启用的快照、机位和采样 |
| 多边形 | `sz-polygon.js`、`building-collision.js` | 环面积/包含/采样、带孔轮廓、扫掠接触、loft/斜屋面按高度切片 |
| 几何/材质工具 | `sz-geometry.js::GeoBuilder`、`sz-mesh-utils.js::mergeParts/canvasTexture` | 墙面、平面、条带、合批和Canvas贴图 |
| 地形采样 | `sz-terrain.js::terrainHeight/terrainCellTriangles` | 规则格点三角插值；与双线性高度有区别 |
| 活动地面 | `sz-ground-surface.js::createGroundSurfaceSampler`、`sz-ground.js::buildSzGround` | 解包三角面、索引查询、地面网格同源 |
| 多层接触 | `sz-controller-surfaces.js::createSurfaceResolver` | 地形、铺装、桥面、屋顶的身份与高度解析 |
| 道路边界 | `sz-roads.js::visitGroundRoadFootprints/createRoadSurfaceLayout/buildSzRoads` | 断面、弯道与路口共同车行范围；沥青、人行避让、裙房退让复用 |
| 道路净空 | `sz-road-building-clearance.js::createRoadBuildingClearance` | 建筑与道路/高架交叠审核，供渲染与碰撞消费 |
| 标线 | `sz-road-markings.js::createLanePlan/createMarkingLayout`、`sz-road-paint.js::buildSzRoadPaint` | 布局与绘制分离，复核断面优先，桥面标线贴活动表面 |
| 路侧与信号 | `sz-road-frontage.js::buildSzRoadFrontage`、`sz-intersection-control.js::createIntersectionControl` | 路缘、人行道、信号实体；车流/自动驾驶共享两方向组模拟相位 |
| 高架/隧道 | `sz-elevated-roads.js::planElevatedRoads/buildSzElevatedRoads`、`sz-tunnels.js::planSzTunnels/buildSzTunnels` | 高架实体与drive表面；正式入口的隧道仅做reviewList，不生成可通行洞身 |
| 水面 | `sz-sea.js::buildSzSea`、`sz-water-material.js::createSzWaterMaterial` | 海面网格、波浪法线、反射；内河三维水面尚缺 |
| 建筑放置 | `sz-building-layout.js::buildingPlacement/buildingSeed` | 共用基底、相对高度和稳定种子 |
| 普通楼 | `sz-buildings.js::buildCityBlocks/roofPlan` | 足迹挤出、内院、塔裙、屋顶；2.4km静态分块合批 |
| 近景建筑 | `sz-building-details.js::planBuildingDetails/buildBuildingDetails` | 200m流式块、阳台/空调/雨棚；避让基础屋顶实际设备；装饰不自动参与碰撞 |
| 楼名 | `sz-building-signs.js::planBuildingSigns/planSignAtlas/buildBuildingSigns` | 选墙、图集、楼顶牌和推断小区门牌；标签不是入口证据 |
| 地标装配 | `sz-landmarks/index.js::buildSzLandmarks`、`layout.js::planSzLandmarks` | 按源ID注册、让位；返回碰撞、可站表面和跳过对象 |
| 地标部件 | `sz-landmarks/parts.js`、`render.js::renderLandmark`、`materials.js` | loft、斜屋面、跨段实体转渲染/碰撞，专模清单见05号 |
| 城市材质 | `sz-materials.js::createBuildingMaterial/FACADE_PROFILES`、`city-lighting-materials.js::cityUniforms` | 局部墙面窗格、用途外观模板、共享日夜uniform |
| 路面材质 | `sz-road-material.js` | 沥青与标线材质，当前效果由参数/调用方决定 |
| 玩家控制 | `controllers.js::ThirdPersonControllerManager` | 步行、汽车、单车、飞行、上下车状态、安全落点与同一角色绑定 |
| 车身与物理 | `cars.js`、`vehicles.js`、`vehicle-physics.js`、`vehicle-lights.js` | loft车身、公共部件、轮接触/动量与车灯 |
| 深圳载具 | `sz-vehicles.js::VEHICLE_SPECS/createShenzhenCarMesh/createEvtolMesh/createCargoDroneMesh` | 蓝白高顶出租、环境车型、单车、四旋翼、货机，程序示例车牌 |
| 环境车流 | `sz-traffic.js::createTrafficGraph/createSzTraffic` | 地面与桥面路图、车道路线、池化模拟、信号与碰撞 |
| 驾车规划 | `sz-drive-route.js::createDrivePlanner/createTurnFilter` | 有向路网、转向限制、车辆净空、桥面和信号停点 |
| 自动驾驶 | `sz-auto-drive.js::createAutoDrive/hasRoadFootprint` | 跟随、等待、手动接管、起点表面身份/车心标高校验 |
| 人物基础 | `pedestrians.js::PersonRig/PersonCrowd` | 骨架、步态、乘员坐姿与实例人群 |
| 步行网络 | `sz-pedestrian-tracks.js::buildWalkTracks/buildSidewalkTracks`、`sz-park-arrivals.js::findParkArrival` | 模拟路侧步行带、连接/排斥、地形采样；公园落点 |
| 环境人群 | `sz-pedestrians.js::createSzPedestrians/createSzDensityModel` | 地点密度、附近池化、同帧队列减速；未等同真实步行网络/严格动态碰撞 |
| 铺装 | `sz-streetscape.js::buildSzStreetscape` | 步行条带铺装，受道路和建筑占用约束 |
| 树 | `sz-trees.js::buildSzTrees`、`sz-tree-crown.js::createCrownLibrary` | 分块实例化、近远LOD；六种程序树、叶卡图集、风与透光 |
| 路灯 | `sz-street-lamps.js::planLampSites/buildSzStreetLamps` | 断面选型、双头/倒L灯杆、光晕分块 |
| 地铁站口 | `sz-metro-entrances.js::planMetroEntrances/buildSzMetroEntrances` | 来源归属、避让、雨棚/站名牌、线路色与LOD |
| 高铁场地 | `sz-station-sites.js::buildFutianStation/buildXiliConstruction` | 福田地面亭/天窗，西丽围挡/塔吊/基坑示意 |
| APEC | `sz-apec.js::buildApecTheme`、`sz-apec-city.js::buildApecCityElements` | 道旗挂现有灯杆；标识、花坛、大屏、机器人、围挡广告 |
| 灯光秀 | `sz-light-show.js::buildSzLightShow/planLandmarkBands` | 福田楼宇与专模灯带，随共享时段显示 |
| 配送无人机 | `sz-drone-routes.js::planDroneFlights/dronePoseAt/buildSzDroneRoutes` | 有来源端点、示意轨迹、实例化连续往返和停运状态 |
| 地图/UI | `sz-map.js::SZMapSystem`、`sz-map-layers.js`、`sz-ui.js` | 全图/小地图、搜索/传送、地铁/高铁/无人机图层、驾车选点、HUD与菜单 |
| 相机/输入 | `cameras.js::CameraSystem`、`sz-camera-presets.js`、`touch-controls.js`、`gamepad-controls.js` | 追尾/环绕/景点机位，触屏和手柄适配 |
| 光照/渲染 | `lighting.js::LightingSystem`、`post-processing.js`、`scene-culling.js` | 四时段、天空/阴影、后处理、空间剔除 |
| 音频 | `audio-system.js::CityAudioSystem`、`audio-events.js`、`audio-sources.js`、`audio-synthesis.js`、`audio-acoustics.js` | 总装、事件、环境源、程序合成和建筑遮挡近似 |

## 离线组件

路径相对 `tools/sz/`。`build.py` 统一装配，下表只列处理职责；`audit_*` 是离线研究工具，不代表对应内容已接入场景。

| 组件 | 文件 | 方法 |
| --- | --- | --- |
| 基础输入 | `geo.py`、`osm.py`、`copernicus.py`、`terrain.py` | 投影、PBF解析、栅格采样与来源校验 |
| 路网 | `roads.py`、`roadgraph.py`、`turn_restrictions.py` | 语义提取、有向拓扑、方向/宽度与转向约束 |
| 水陆/表面 | `land.py`、`road_surface.py`、`terrain_surface.py`、`terrain_exclusions.py`、`sea_surface.py` | 水陆裁切、派生走廊、城区地坪、局部排除与海面 |
| 结构/前场 | `bridges.py`、`yanjiang.py`、`road_frontage.py`、`beihuan.py` | 桥/远景线形、入口与断面复核 |
| 建筑/地标 | `buildings.py`、`building_parent_review.py`、`landmark_sites.py` | 来源融合、部件角色、楼高与场地绑定 |
| 街景/交通设施 | `metro.py`、`parks.py`、`streetscape.py`、`trees.py` | 线路出口归属、步道审计、街景与树木来源 |
| 编码/校验 | `fastpack.py`、`package_validation.py`、`validate-city.mjs` | SZC1、完整性/契约检查与真实性缺口报告 |
| 开发/QA | `serve.py`、`tools/qa/check.py`（根目录相对路径） | 禁缓存服务器与分范围自动检查 |

## 空间契约

- **Surface** 是有身份的活动接触面，同一XZ可有多层。**Block** 是道路围合街块；**Place** 是可跨街块的现实场所；**Region** 是有边界和用途的区域；**Corridor** 是道路/河流走廊；**Profile** 是外观默认规则。区域不等于行政区或加载块，统一区域体系仍是TASKS中的计划。
