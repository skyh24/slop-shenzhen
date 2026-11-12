# 普通建筑与商业首层

## 已有功能

正式场景已有普通建筑足迹挤出、内院、塔楼/裙房、用途立面模板、屋顶设备、楼名牌，以及近景阳台、空调和雨棚。地标用独立程序模型替换核实对象，清单和特征见 [地标](05-LANDMARKS.md)。商业首层的通用装饰已有，真实店面、门洞和公共入口需逐对象核实。

## 方法与架构

| 入口（相对 `js/`） | 职责 |
| --- | --- |
| `sz-building-layout.js::buildingPlacement/buildingSeed` | 共用基底、高度换算和稳定种子 |
| `sz-buildings.js::buildCityBlocks/roofPlan` | 普通楼体、塔裙与基础屋顶；2.4km静态分块 |
| `sz-materials.js::createBuildingMaterial/FACADE_PROFILES` | 局部墙面整数窗格、用途外观与共享日夜状态 |
| `sz-building-details.js::planBuildingDetails/buildBuildingDetails` | 200m近景流式块、立面细节及屋顶设备避让 |
| `sz-building-signs.js::planBuildingSigns/planSignAtlas/buildBuildingSigns` | 墙面/屋顶选牌、共用图集与门牌示意 |
| `building-collision.js`、`sz-road-building-clearance.js` | 按高度切片的碰撞与道路净空约束 |

数据经 `tools/sz/buildings.py` 融合，楼高保留 `heightSource`。已有事实优先于外观模板；层数推算、遥感和样本估计不改写成实测。楼体放置、地标让位和碰撞必须引用同一对象与基底。

## 实现边界与验证

外观模板不证明真实用途，楼名/POI不证明入口，装饰也不自动参与碰撞。架空层、柱廊、连桥需按实体分段并实走。已修复的屋顶避让保持回归；当前未验区域见 [HANDOFF](HANDOFF.md)。明通首层先看 [源卡](../data/source/mingtong-frontage-evidence.md)，真实墙段和入口尚缺证据。

检查用 `buildings`；接触影响加 `roads/controls`。重点测试 `tests/sz-buildings.test.cjs`、`sz-building-details.test.cjs`、`sz-building-signs.test.cjs` 与 `building-collision.test.cjs`。浏览器比较远近切换、屋顶和真实输入通过门洞；执行范围见 [TASKS T7](TASKS.md#t7-建筑与入口)。
