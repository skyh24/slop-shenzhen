# 商圈与区域

## 已有内容

商圈已有通用建筑、地点名、铺装、人群密度和部分地标；这些由建筑、街景、地图等组件共同构成。购物公园/卓悦中心已有离线铺装审计，明通已有首层来源卡。统一区域边界、风貌配置和公共路径系统仍在设计阶段。

| 当前入口 | 内容与边界 |
| --- | --- |
| `data/source/urban-datum.json` | 商业地坪范围与工程处理依据；不证明全区可步行 |
| `data/source/shopping-park-audit.json` | 草案街块/场所和核查对象，尚非运行时区域库 |
| `tools/sz/audit_commercial_paving.py`、`audit_shopping_park.py` | 对当前包三角面、建筑和道路做离线覆盖审计 |
| `tools/sz/shopping-park-road-surface.mjs` | 购物公园道路表面核查辅助 |
| `js/sz-streetscape.js`、`sz-ground.js` | 已有步行铺装与活动地面绘制 |
| `js/sz-city-config.js`、`sz-spatial.js`、`sz-map.js` | 已有地点配置、空间查询和地图展示 |
| [明通来源卡](../data/source/mingtong-frontage-evidence.md) | POI与南楼关系；真实入口墙段/门心仍未知 |

## 区域方法（待实施）

街块沿地面道路外缘围合；桥梁投影不直接切断桥下街块。现实场所可跨多个街块，区域边界与渲染加载块分开。一个商圈需分别记录建筑、地面、绿地、入口、公共路径和开放权限，不能靠地点中心或统一材质代替。

拟议的区域/风貌配置文件尚未建立。字段、继承规则与R1–R5阶段只维护在 [TASKS T4](TASKS.md#t4-区域与商圈)，避免产生第二套实施计划。已有逐栋事实优先于模板，未知入口和权限保留未知。

## 验证与参考

离线审计核实际三角面及车行范围；二维建筑投影不等于扣除了柱廊/架空层后的公共面积。旧面积报告须用当前包复核。运行时改动按所属组件选择 `data/roads/street/ui`，接触变化加 `controls`；最终以一条有来源的商圈公共路径实走验收。

基础实现分别见 [建筑](04-BUILDINGS.md)、[道路](03-ROADS-GROUND.md)、[街景](06-STREETSCAPE.md)、[地图](09-UI-GAMEPLAY.md)。调研取舍见 [RESEARCH](RESEARCH.md)，后续地点扩展仍在TASKS T11/T14。
