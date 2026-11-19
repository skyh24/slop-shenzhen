# 普通建筑与商业首层

## 已有功能

正式场景已有普通建筑足迹挤出、内院、塔楼/裙房、用途立面模板、屋顶设备、楼名牌，以及近景阳台、空调和雨棚。地标用独立程序模型替换核实对象，清单和特征见 [地标](05-LANDMARKS.md)。商业首层的通用装饰已有，真实店面、门洞和公共入口需逐对象核实。

## 方法与架构

| 入口（相对 `js/`） | 职责 |
| --- | --- |
| `sz-building-layout.js::buildingPlacement/buildingSeed` | 共用基底、高度换算和稳定种子 |
| `sz-building-plan.js::retailBuildingIdsFromRegions/createBuildingDetailPlan` | 商圈归属、排除身份与近景输入包；同一批建筑对象和商圈区域只解释一次 |
| `sz-buildings.js::buildCityBlocks/roofPlan` | 普通楼体、塔裙与基础屋顶；2.4km静态分块，返回 `detailPlan` |
| `sz-facade-profiles.js::facadeIndex/facadeProfile/fitFacadeFloors` | 普通楼的立面、楼名层高及近景部件预设，和两个按已核对象绑定的外观样本 |
| `sz-materials.js::createBuildingMaterial` | 局部墙面整数窗格与共享日夜状态 |
| `sz-building-details.js::planBuildingDetails/buildBuildingDetails` | 200m近景流式块、立面细节及屋顶设备避让；入口只接收 `detailPlan` |
| `sz-building-signs.js::planBuildingSigns/planSignAtlas/buildBuildingSigns` | 墙面/屋顶选牌、共用图集与门牌示意 |
| `building-collision.js`、`sz-road-building-clearance.js` | 按高度切片的碰撞与道路净空约束 |

数据经 `tools/sz/buildings.py` 融合，楼高保留 `heightSource`。层数推算、遥感和样本估计不改写成实测。楼体放置、地标让位和碰撞必须引用同一对象与基底。

`buildCityBlocks` 输出的 `detailPlan` 汇集基底、源楼、地标让位、屋面设备和临街用途。近景与夜景沿用同一组排除对象。局部建筑集须显式传入所用地形、路网和商圈信息。

核实共边或重复体量后，按实际重叠高度确定唯一外墙，保留露出部分、屋面与源身份。关系登记在 `js/sz-building-envelope-relations.js`，含[铜鼓路](research/dachong-building-flicker.md)与[新洲路等样区](research/xinzhou-building-flicker-audit.md)的对象证据。

## 立面与部件共用规则

- 无名称、用途、层数的普通单体，只有估高或低可信／未知可信度的 GloBFP 预测时，外包框对角线不超过 32 米，足迹面积不超过 80 平方米，或能纳入 7 米宽的条带且面积不超过 160 平方米，就以最多 3.2 米的素面体块表示。保留原足迹与地面基准，显示、屋面接触、净空和碰撞共用简化高度；场景体量标为 `estimate`，包内原值和来源保留，运行时另记 `sourceHeight` 与 `sourceHeightSource`。基础楼体把这些对象排除在门面、近景和夜景细节之外。地标、架空部件、内院、已标高度或层数、明确用途、商业门面及中高可信预测保持原有高度。深南香蜜立交既有两个已核足迹走同一渲染路径。
- 市民广场两侧各三座光塔按 `way/781536987` 至 `way/781536992` 绑定，采用无窗格的玻璃色和夜间发光。项目 OSM 快照六座均标记 `building:material=glass`、`roof:material=glass`、`height=20`，场景沿用该快照高度。[深圳市城管局](https://cgj.sz.gov.cn/xsmh/gysz/csgy/content/post_10774700.html)所列高度为 25 米，两处口径仍待核对。

- 城市包 v2 解码后保留 `facade` 的字符串名称和 `category`、`heightSource` 等来源字段。渲染批次按预设名称取得着色索引，索引只在运行时使用。旧包已有外观估计继续采用原名称，缺省或 `null` 采用中性预设，拼错的预设名报错。
- `FACADE_PROFILES` 单独维护米制开间、默认层高、首层表现、窗占比、配色和阳台/空调/水箱开关。外观部件默认关闭。共享近景材质按四个族合并，每个流式块释放自己的几何，共用材质由近景系统关闭时统一释放。
- 立面、阳台门片、阳台和空调共用 `fitFacadeFloors` 的竖向网格。合理源层数优先（含首层，平均层高 2.2–8 米），缺失或矛盾时按用途预设估计整数层数；首层单独留高，其余层均分剩余楼高。每层只画一排窗，架空部分沿同一网格裁切，不重新起算。层数拟合只影响外观，保留楼高、来源、足迹和碰撞。
- 新增普通楼仍走现有数据管线；同类型引用已有立面，外观变体在预设表扩展参数。建筑身份、开口、屋顶外形和开放权限仍从来源几何确定。深圳湾公馆的复式阳台和航天科技广场 A 座的北侧高大堂与雨棚各需明确对象绑定，共用预设表中的样本参数。其他地标继续使用各自的结构和公共地标部件。
- 基础屋顶输出实际设备底面和屋面高度，近景按同一足迹与高度读取已占范围。水箱、天线和航空灯仅由近景生成；双层屋顶仍各按自己的面规划，门洞与首层接触不由外观部件生成。

## 实现边界与验证

外观模板不证明真实用途，楼名/POI不证明入口，装饰也不自动参与碰撞。架空层、柱廊、连桥需按实体分段并实走。已修复的屋顶避让保持回归；当前未验区域见 [HANDOFF](HANDOFF.md)。明通首层先看 [源卡](../data/source/mingtong-frontage-evidence.md)，真实墙段和入口尚缺证据。

普通楼体、近景、楼名与碰撞可分别点测 `sz-buildings`、`sz-building-details`、`sz-building-signs` 或 `building-collision`。日常交付见[开发检查](25-FAST-CHECKS.md)，入口和远近切换的正式验收范围见 [T7](TASKS.md#t7-建筑与入口)。
