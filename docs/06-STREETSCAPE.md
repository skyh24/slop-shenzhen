# 街景、公园与交通设施

## 已有功能

场景已有步行铺装、分块树木、路灯、环境行人、地铁出口、福田站地面设施、西丽站工地示意及APEC城市元素。公园数据和部分入口/步道审计已存在，完整真实步行网络尚未完成。

## 方法与架构

| 入口（相对 `js/`） | 职责 |
| --- | --- |
| `sz-streetscape.js::buildSzStreetscape` | 受道路/建筑占用约束的步行铺装 |
| `sz-trees.js::buildSzTrees`、`sz-tree-crown.js::createCrownLibrary` | 六种程序树、叶卡、风与透光、实例化和近远LOD |
| `sz-street-batch.js::chunkKey/createStreetBatch` | 街具分块键、相机距离、迟滞与档位切换；树、路灯、地铁口共用一套进出规则 |
| `sz-street-lamps.js::planLampSites/buildSzStreetLamps` | 按断面布置灯杆、双头/倒L外形与光晕 |
| `sz-pedestrian-tracks.js::buildWalkTracks/buildSidewalkTracks` | 模拟路侧步行带、连接与排斥 |
| `sz-pedestrians.js::createSzPedestrians/createSzDensityModel` | 地点密度、附近人群池与队列减速；人物骨架来自 `pedestrians.js` |
| `sz-park-arrivals.js::findParkArrival` | 公园到达点选择 |
| `sz-metro-entrances.js::planMetroEntrances/buildSzMetroEntrances` | 出口归属、避让、雨棚、站名和线路色 |
| `sz-station-sites.js::buildFutianStation/buildXiliConstruction` | 福田地面亭/天窗；西丽围挡/塔吊/基坑示意 |
| `sz-apec.js::buildApecTheme`、`sz-apec-city.js::buildApecCityElements` | 灯杆道旗、花坛、大屏、机器人和围挡广告 |

来源由 `tools/sz/metro.py`、`parks.py`、`streetscape.py`、`trees.py` 处理；地铁按深圳地铁网络过滤。商圈地面见 [商圈与区域](REGIONS-PLACES.md)，楼宇夜景见 [灯光秀](LIGHT-SHOW.md)。

## 放置与运行规则

- 有来源的树点优先。补植、灯杆、站口按地面、车行范围、步道、建筑和设施净空选位，碰撞体随可见树干或灯杆落位。地铁出口保留线路和站点归属。
- 树、灯、站口共用分块距离与显隐机制，各自设置档位。滨水栏杆、座椅和庭院灯共享几何及材质，由持有它们的场地释放。
- 城市行人与公园人群共享人物资源，各场地定义步行、跑步、驻足与归队路线。人数是模拟值。路边候选须检查设施占用和过街端点。
- 公园、滨水与车站的公共路线应从可用入口连续走到目标，核树灯后的通行净宽、路缘和桥下分层。APEC 城市元素使用文字与配色。

代表样段见[当前覆盖](HANDOFF.md)，公园与轨道接驳见[优化清单](TASKS.md)。
