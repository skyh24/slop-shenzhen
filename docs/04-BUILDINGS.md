# 普通建筑与商业首层

## 已有功能

正式场景已有普通建筑足迹挤出、内院、塔楼/裙房、用途立面模板、屋顶设备、楼名牌，以及近景阳台、空调和雨棚。地标用独立程序模型替换核实对象，清单和特征见 [地标](05-LANDMARKS.md)。商业首层的通用装饰已有，真实店面、门洞和公共入口需逐对象核实。

## 方法与架构

| 入口（相对 `js/`） | 职责 |
| --- | --- |
| `sz-building-layout.js::buildingPlacement/buildingSeed` | 共用基底、高度换算和稳定种子 |
| `sz-buildings.js::buildCityBlocks/roofPlan` | 普通楼体、塔裙与基础屋顶；2.4km静态分块 |
| `sz-facade-profiles.js::facadeIndex/facadeProfile` | 普通楼的立面、楼名层高及近景部件预设，和两个按已核对象绑定的外观样本 |
| `sz-materials.js::createBuildingMaterial` | 局部墙面整数窗格与共享日夜状态 |
| `sz-building-details.js::planBuildingDetails/buildBuildingDetails` | 200m近景流式块、立面细节及屋顶设备避让 |
| `sz-building-signs.js::planBuildingSigns/planSignAtlas/buildBuildingSigns` | 墙面/屋顶选牌、共用图集与门牌示意 |
| `building-collision.js`、`sz-road-building-clearance.js` | 按高度切片的碰撞与道路净空约束 |

数据经 `tools/sz/buildings.py` 融合，楼高保留 `heightSource`。已有事实优先于外观模板；层数推算、遥感和样本估计不改写成实测。楼体放置、地标让位和碰撞必须引用同一对象与基底。

## 立面与部件共用规则

- 城市包 v2 解码后保留 `facade` 的字符串名称和 `category`、`heightSource` 等来源字段。渲染批次按预设名称取得着色索引，索引只在运行时使用。旧包已有外观估计继续采用原名称，缺省或 `null` 采用中性预设，拼错的预设名报错。回归对照 Python 生成器的八种载荷值。
- `FACADE_PROFILES` 单独维护米制开间、默认层高、首层表现、窗占比、配色和阳台/空调/水箱开关。外观部件默认关闭。共享近景材质按四个族合并，每个流式块释放自己的几何，共用材质由近景系统关闭时统一释放。
- 新增普通楼仍走现有数据管线；同类型引用已有立面，外观变体在预设表扩展参数。建筑身份、开口、屋顶外形和开放权限仍从来源几何确定。深圳湾公馆的复式阳台和航天科技广场 A 座的北侧高大堂与雨棚各需明确对象绑定，共用预设表中的样本参数。其他地标继续使用各自的结构和公共地标部件。
- 基础屋顶输出实际设备底面和屋面高度，近景按同一足迹与高度读取已占范围。水箱、天线和航空灯仅由近景生成；双层屋顶仍各按自己的面规划，门洞与首层接触不由外观部件生成。

## 实现边界与验证

外观模板不证明真实用途，楼名/POI不证明入口，装饰也不自动参与碰撞。架空层、柱廊、连桥需按实体分段并实走。已修复的屋顶避让保持回归；当前未验区域见 [HANDOFF](HANDOFF.md)。明通首层先看 [源卡](../data/source/mingtong-frontage-evidence.md)，真实墙段和入口尚缺证据。

检查用 `buildings`；接触影响加 `roads/controls`。重点测试 `tests/sz-buildings.test.cjs`、`sz-building-details.test.cjs`、`sz-building-signs.test.cjs` 与 `building-collision.test.cjs`。浏览器比较远近切换、屋顶和真实输入通过门洞；执行范围见 [TASKS T7](TASKS.md#t7-建筑与入口)。
