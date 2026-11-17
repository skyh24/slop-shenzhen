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

- 步行极速30km/h、后退20km/h；单车3秒到60km/h、后退30km/h；汽车常规3秒到80km/h，Shift极速120km/h、后退60km/h，空格刹车。模式顺序为步行、骑行、开车、飞行。
- 飞行平飞3秒到前进600/后退300km/h；升降2秒到20m/s。初始飞行高度200m，高地另留净空。这些是游戏参数。
- 速度框在四种模式都显示离地高度；步行、骑行、汽车、飞行都可用 F 或点速度栏定速，新按前进/后退键取消（按住不放不取消）。汽车自动驾驶定速按路线限速，可跑 120 km/h。
- 空中巡游常速 300 km/h、加速 600 km/h（退出后回到常速），飞行中换速按里程保持位置连续；常规弯原速通过，急弯最低保留一半速度。汽车与巡航的弯道曲率限速下限 5.5 m/s（19.8 km/h），直角弯不停车。
- 返回地面先检查原位，受阻再找合格道路，失败保留飞行模式；活动表面使用 [道路组件](03-ROADS-GROUND.md) 的分层身份。
- 交通信号采用正式路口的模拟 8 秒周期，灯面和车流共用状态。`sz-city-config.js` 的旧时序仍供可选音频路径读取。
- 环境车、自动规划和换道读取共用道路断面，保留地面与桥面接触身份及已有安全净宽。
- 环境车按撞击点判断玩家威胁：玩家将撞车头时 0.3 秒后急刹并亮刹车灯，被追尾时加速逃开但不超过前车与匝道限速；玩家车横在前方时减速停车。静态近邻网格按数组长度增量补索引，后补的路缘、设施碰撞体同样挡车。

## 实现边界与验证

现有安全切换和错层启动检查不代表完整长程驾驶通过。低帧高速、人车动态碰撞、路口让行和上下桥仍按 [TASKS T2](TASKS.md#t2-地面和q8)、[T8](TASKS.md#t8-人车) 验收；接单玩法仅保留在T14。

检查用 `controls`，道路影响加 `roads`，人群加 `street`。重点测试 `tests/sz-vehicles.test.cjs`、`vehicle-physics.test.cjs`、`sz-traffic.test.cjs` 及控制/路线测试；浏览器分别操作四模式、失败恢复和完整Q8。流程见 [开发检查](25-FAST-CHECKS.md)。
