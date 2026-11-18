# 开发文档

[当前覆盖与验收](HANDOFF.md)说明哪些场景已有实际操作记录。[优化清单](TASKS.md)按优先级列出下一步和完成条件。

| 要查什么 | 入口 |
| --- | --- |
| 场景怎样装配，实体怎样共享数据 | [架构与基本实体](01-ARCHITECTURE.md) |
| 坐标、身份、来源、几何约束 | [开发规范](CONVENTIONS.md) · [数据管线与重建](02-DATA-PIPELINE.md) |
| 道路、车道、桥隧、岸线与活动表面 | [道路与地面](03-ROADS-GROUND.md) |
| 楼体、立面、专模与公共入口 | [普通建筑](04-BUILDINGS.md) · [地标模型与资料](05-LANDMARKS.md) |
| 铺装、树灯、人群、站口与场所边界 | [街景与设施](06-STREETSCAPE.md) · [商圈与区域](REGIONS-PLACES.md) |
| 玩家移动、车流、空中巡游与模拟配送 | [载具与驾驶](07-VEHICLES.md) · [配送无人机](08-AIR.md) |
| 地图、输入、观察相机与节目 | [界面与漫游](09-UI-GAMEPLAY.md) · [灯光与无人机节目](LIGHT-SHOW.md) |
| 改动该跑哪些检查，正式验收要走哪些路线 | [开发检查](25-FAST-CHECKS.md) · [验收标准与性能预算](10-PERF-QA.md) |

地理资料、许可和对象裁决见[来源清单](../data/source/sources.json)与[署名](../data/source/ATTRIBUTION.md)。包内数量和隔离项查[构建报告](../data/source/build-report.json)。样段截图与轨迹放本地 `docs/qa/`，历史判断从 Git 查阅。
