# 载具、驾驶与车流

## 已有功能

正式入口支持步行、汽车、单车和玩家飞行器四模式。模式切换绑定同一人物，保留横向位置与朝向，只显示当前使用的玩家载具。深圳载具包括蓝白高顶出租车、环境车型/公交、共享单车、四旋翼和货运无人机，均为无品牌程序模型。

已有路网自动驾驶、信号等待、手动接管和环境车流。出租车接单、乘客上落点与结算闭环尚未实现。货运航线是独立系统，见 [无人机](08-AIR.md)。

## 方法与架构

| 入口（相对 `js/`） | 职责 |
| --- | --- |
| `controllers.js::ThirdPersonControllerManager` | 模式/乘员状态、输入、加减速、上下车和安全落点 |
| `sz-vehicles.js::VEHICLE_SPECS/createShenzhenCarMesh/createShenzhenBusMesh/createSharedCycleMesh/createEvtolMesh` | 深圳车型参数与网格 |
| `cars.js`、`vehicles.js`、`vehicle-physics.js`、`vehicle-lights.js` | 车身loft、公共部件、轮接触/动量与车灯 |
| `sz-traffic.js::createTrafficGraph/createSzTraffic` | 地面/桥面路图、车道路线与池化车流 |
| `sz-drive-route.js::createDrivePlanner/createTurnFilter` | 有向路径、转向限制、净空和信号停点 |
| `sz-auto-drive.js::createAutoDrive/hasRoadFootprint` | 跟随、等待、接管；启动时检查表面身份与车心标高 |
| `sz-intersection-control.js::createIntersectionControl` | 车流与自动驾驶共享两方向组的模拟信号 |

## 当前交互参数

- 单车4秒到60km/h；汽车4秒到80km/h，Shift加力上限120km/h，空格刹车。
- 飞行平飞4秒到前进600/后退400km/h；升降2秒到20m/s。初始飞行高度200m，高地另留净空。这些是游戏参数。
- 返回地面先检查原位，受阻再找合格道路，失败保留飞行模式；活动表面使用 [道路组件](03-ROADS-GROUND.md) 的分层身份。
- 交通信号采用正式路口的模拟 8 秒周期，灯面和车流共用状态。`sz-city-config.js` 的旧时序仍供可选音频路径读取。
- 环境车、自动规划和换道读取共用道路断面，保留地面与桥面接触身份及已有安全净宽。

## 车道级环境车流

环境车流按已核实断面分层，不再让一条路上的车共用一条中心线：

- 车道来源只认已复核断面或 OSM 车道标签（`laneSource === 'osm-lanes'` 且非估计）。`sz-road-section.js::laneOffsets` 返回升序车道中心偏移（首项靠中心线、末项靠路缘），无可靠数据时返回 `null`，车流回退单中心线。
- 投放按同路段 80 米内最空的车道等分选位；与在途车 25 米内重合时顺延到下一帧。路线样本携带 `laneOffset`，跟车按横向误差分道，纵向共用同一跟车模型。
- 被动换道只在被挡 2 秒后触发：目标车道后方 8 米、前方 22 米无车，且距路段终点不少于 45 米；五次曲线 2 秒完成，跨路段时 0.8 秒收回偏移。换道失败记 `laneChangeAborts`，路段本身没有车道数据只记 `laneChangeIneligible`，不算失败。
- 路线终点不再是停车点：剩余 140 米时从当前位置续接（最多向前扫 320 米并截断到离开复核结构的位置），续接失败累计 0.5 秒判死；判死或停满 8 秒的车只在远离玩家且不在视野内时回收。
- `statistics` 暴露 `stoppedOver8s`（不含等灯和已判死的车）、`maxQueue`（按路段累计里程、同车道连续 12 米内计队）、`laneChanges`、`routeExtensions`、`spawnThrottled` 等指标，用于固定路段验收。

浏览器复现：`python3 tools/sz/serve.py --port 8080` 后打开 `/?qa=1`，控制台 `__szQA().traffic` 读取上述指标与逐车状态，`__szTraffic` 可直接检查车辆路线样本，`__szTeleport(x, z)` 把玩家送到指定坐标（站到车道上会正常逼停车流，验收前先把玩家移开 35 米以上）。

## 实现边界与验证

现有安全切换和错层启动检查不代表完整长程驾驶通过。低帧高速、人车动态碰撞、路口让行和上下桥仍按 [TASKS T2](TASKS.md#t2-地面和q8)、[T8](TASKS.md#t8-人车) 验收；接单玩法仅保留在T14。

检查用 `controls`，道路影响加 `roads`，人群加 `street`。重点测试 `tests/sz-vehicles.test.cjs`、`vehicle-physics.test.cjs`、`sz-traffic.test.cjs` 及控制/路线测试；浏览器分别操作四模式、失败恢复和完整Q8。流程见 [开发检查](25-FAST-CHECKS.md)。
