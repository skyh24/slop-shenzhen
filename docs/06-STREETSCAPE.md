# 街景、公园与交通设施

## 已有功能

场景已有步行铺装、分块树木、路灯、环境行人、地铁出口、福田站地面设施、西丽站工地示意及APEC城市元素。公园数据和部分入口/步道审计已存在，完整真实步行网络尚未完成。

## 方法与架构

| 入口（相对 `js/`） | 职责 |
| --- | --- |
| `sz-streetscape.js::buildSzStreetscape` | 受道路/建筑占用约束的步行铺装 |
| `sz-trees.js::buildSzTrees`、`sz-tree-crown.js::createCrownLibrary` | 六种程序树、叶卡、风与透光、实例化和近远LOD |
| `sz-street-lamps.js::planLampSites/buildSzStreetLamps` | 按断面布置灯杆、双头/倒L外形与光晕 |
| `sz-pedestrian-tracks.js::buildWalkTracks/buildSidewalkTracks` | 模拟路侧步行带、连接与排斥 |
| `sz-pedestrians.js::createSzPedestrians/createSzDensityModel` | 地点密度、附近人群池与队列减速；人物骨架来自 `pedestrians.js` |
| `sz-park-arrivals.js::findParkArrival` | 公园到达点选择 |
| `sz-metro-entrances.js::planMetroEntrances/buildSzMetroEntrances` | 出口归属、避让、雨棚、站名和线路色 |
| `sz-station-sites.js::buildFutianStation/buildXiliConstruction` | 福田地面亭/天窗；西丽围挡/塔吊/基坑示意 |
| `sz-apec.js::buildApecTheme`、`sz-apec-city.js::buildApecCityElements` | 灯杆道旗、花坛、大屏、机器人和围挡广告 |

来源由 `tools/sz/metro.py`、`parks.py`、`streetscape.py`、`trees.py` 处理；地铁按深圳地铁网络过滤。商圈地面见 [商圈与区域](REGIONS-PLACES.md)，楼宇夜景见 [灯光秀](LIGHT-SHOW.md)。

深圳湾日出剧场的 17 株源树点交给 `sz-trees.js` 与城市树记录合并，保留精确 OSM 点位。同一树种资源用于街景与公园补植，碰撞由同一树干生成，分块退出释放实例。莲花山雕像旁的柏林保留专属冠形和平台位置。

深圳湾与人才公园的栏杆横档、座椅和庭院灯共用 `sz-site-fixtures.js`。两处共用单位盒几何、钢件和木件材质，各自的灯头参数独立。释放一个场地的批次后，其他使用者持有的资源仍可用。挡墙、岸线、光斑、观看净空与座椅靠背由场地参数或已有独立几何表达。

`PersonCrowd.updateWalker/dispose` 供城市人群和人才公园共用，LOD 缓存持有共享人物几何，各池释放自己的材质和实例。人才公园的跑步、驻足观看与归队沿用原路线和状态，人数沿用原行为配置。

## 实现边界与验证

模拟人群密度不是实时客流，队列减速不等于完整动态人车碰撞。站口模型不证明现实开放状态；西丽工地示意不等于已完成地形开洞。莲花山已有来源路线审计，不能据此宣称已接入并走通。APEC装饰仅使用文字和配色。

检查用 `street`，地图联动加 `ui`，接触加 `roads/controls`，源处理加 `data`。浏览器检查实例/LOD、路面贴合、人群完整周期和一条有来源的公共接驳路线。待做范围集中在 [TASKS T5–T8](TASKS.md#t5-公园) 与 [T12](TASKS.md#t12-低空apec)。
