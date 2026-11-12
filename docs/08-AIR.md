# 无人机路线与低空展示

## 已有功能

配送无人机已在正式入口装配并逐帧更新，包含站点、航线示意、实例化货机、连续往返与按来源窗口停运展示。玩家飞行器由 [载具控制](07-VEHICLES.md) 管理，不是配送班次。

当前源记录有两条线、四个端点：人才公园潮汐广场—海岸城商圈；中心公园C2—莲花山公园。后者端点配对仍低置信。来源摘要见 [无人机取证](research/drone-routes.md)，完整链接/核实日期在 [air-routes.json](../data/source/air-routes.json) 与 [air-evidence.json](../data/source/air-evidence.json)。

## 方法与架构

`data/source/air-routes.json → build.py → GEO.air → main.js → sz-drone-routes.js`。

| 方法 | 职责 |
| --- | --- |
| `planDroneFlights` | 关联端点，生成每线两架的示意飞行配置，保留来源和估计标记 |
| `dronePoseAt` | 按累计时间计算往返位置与朝向 |
| `isApecAirSuspended` | 按源文件日期窗口判断停运展示 |
| `buildSzDroneRoutes` | 站点/线路/货机实例化，提供更新与释放 |
| `sz-vehicles.js::createCargoDroneMesh` | 程序化货机模型入口 |

当前轨迹为 `schematic`，高度为估计100米，速度为展示参数；不是测得的真实航迹、班次或实时运营信息。停运日界仍需核深圳时区。

## 实现边界与验证

尚缺精确柜位、部分端点配对、真实路径/高度和当前运营核验。当前往返运动不等于完整起降、避障或配送流程。无人机编队灯光表演只有历史资料，尚无对应常设表演实现；已有楼宇灯带见 [灯光秀](LIGHT-SHOW.md)。

检查用 `street`，定向测试为 `tests/sz-drone-routes.test.cjs`。浏览器检查完整往返、端点朝向、停运显示及地图一致性；执行提示词仅在 [TASKS T12](TASKS.md#t12-低空apec)，后续表演候选在T14。
