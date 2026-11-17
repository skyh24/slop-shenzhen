# 普通建筑近景与商业首层：能力盘点与视觉缺口

状态：只读调研（未改运行代码、未开浏览器、未跑长测）。
证据等级按 docs/10-PERF-QA.md:21：L1 来源/数据 → L2 生成 → L3 正式场景 → L4 浏览器可见 → L5 显示/接触一致且实际操作。
本文件所有“通过/达标”措辞均指代码或数据层，**不代表 L4 视觉验收**。

## 0. 结论

- 普通楼 0–200m 已有：着色首层（大堂/店面/单元入口/工业门洞四种）、零售分铺着色、独立店面贴面四边形、单开间假门、一栋一个雨棚、空调、阳台、入口楼名牌、屋顶设备、夜间首层亮灯。全部由运行时生成，**只有一层皮，没有门洞、没有凹进、没有室内**。
- 仓库里其实已有“真首层”：js/sz-districts/facades.js 的 restyleBlock 会挖 2.35–2.55m 深的凹口、装内景、柜台、灯带、店招并登记 shop（mouth/interior/approach）。但它只服务三个已核商圈白名单共 32 栋（js/sz-districts/index.js:14-38），普通楼不复用。
- 因此最大缺口不是“没有能力”，而是**能力被锁在商圈专用 kit 里，普通楼只拿到着色近似**；其次是店招只有楼名、雨棚尺寸统一、夜间首层是一条连续亮带。

## 1. 0–200m 近景现有内容（部件 / 控制点 / 默认）

| 部件 | 生成位置 | 关键参数 | 默认 |
| --- | --- | --- | --- |
| 首层色带（大堂/店面/单元/工业） | js/sz-materials.js:124 groundMask、:176-187 四种 groundStyle、:181-187 中央假门 u∈[墙长/2±1.1] v 0.05–2.3 | FACADE_PROFILES.groundHeight/groundStyle（js/sz-facade-profiles.js:8-74） | 开，按用途自动，无开关 |
| 零售分铺着色（贴墙） | js/sz-materials.js:190-201：retailHeight=min(3.65,groundHeight,楼高-0.08)，每 6.3m 一铺，左橱窗右门 + fascia 带 | meta.z<0 由 js/sz-buildings.js:478 retailEdge 与 :385 indexRetailFronts 写入 | 开（区域内普通楼） |
| 独立店面贴面（四边形 + 专用材质） | js/sz-retail-frontage.js:17 edge()/:73 开间=length/7.2/:102-109 单四边形/:134-186 材质 | retailFloors∈{1,2}、1.7m 前场净空（:55-61）、门宽 1.16/1.76（:85-86） | 开，js/sz-scene-site.js:117-125 恒传 retail |
| 门记录 | js/sz-retail-frontage.js:94-96 doors.push({...open:false}) | 3 进深×3 偏移铺装/净空校验（:89-93） | 只登记，不通行 |
| 雨棚（通用） | js/sz-building-details.js:472 planCanopy | 250m、每栋 1 个、深 2.2 固定、宽 clamp(0.55×边长,3,6.5)、y=clamp(层高,3,4.2) | 开；有 retailFloors 的楼被抑制（:552-554） |
| 雨棚（零售） | js/sz-retail-frontage.js:97-100 | 深 0.72、宽=门宽+0.75、需 ≥3.05 且（离入口<6m 或 variation>0.8） | 开，概率约 2 成 |
| 空调 | js/sz-building-details.js:440 | 200m、≤16 台、0.38 概率、0.9×0.58×0.42m、仅 profile.airConditioner 或 residential | 开；profile 默认 false（facade-profiles.js:74） |
| 阳台 | js/sz-building-details.js:394 | 250m、≤30、2 面墙、22% 跳过、≥24m 从 2 层起、仅 profile.balcony | 开（住宅类） |
| 楼名牌 | js/sz-building-signs.js:332 planBuildingSigns | 只读 building.name；<60m 入口牌（宽 3–8、高 1.2–1.6、离墙 0.12）；≥60m 屋顶牌（宽 10–44、高 3–9、楼顶+0.35） | 开；无名/纯单元号跳过（:7-8、:36-41） |
| 屋顶设备 | js/sz-building-details.js:265 planRoofParts | 楼高<12 无；机械 1–2 台（3–5m、2.4–3.3m、70% 格栅）；水箱仅 waterTank 约 22%；天线≥150m 带航空灯（:324-331）；女儿墙≥8m（:335） | 开（allowRoofEquipment!==false，:539） |
| 夜间亮灯 | js/sz-materials.js:240-258；零售 js/sz-retail-frontage.js:180-185 | litShare 逐套间、groundGlow 0.34×(occupancy 0.45–1.0)、shopGlow 0.055–0.245；时段 uInteriorGlow（golden .48/midday .24/twilight 1.25/midnight 1.55） | 开 |

近景预算：js/sz-building-details.js:22-32 每块最近 40 栋完整近景，其余只女儿墙+便宜屋顶盒；650m 生成/850m 卸载、每帧 2 块、单块 4.5 万三角形。这决定任何新几何都必须按块计量。

## 2. 三条首层实现并存（必须先分清）

1. **普通楼着色**：js/sz-materials.js:124、:176-201。无几何、无门洞；中心门洞只是着色矩形。
2. **普通零售贴面**：js/sz-retail-frontage.js:102-109，每开间 1 个竖直四边形，材质里用视线偏移伪造 1.6m 纵深（:166-167）。数据来自包 retailBuildings：上一版 data/source/build-report.json 记 groundFloor 200 栋、retailBuilding 395 栋（tools/sz/building_appearance.py:263-264）。
3. **商圈专用首层**：js/sz-districts/facades.js:13-128。真凹进 2.35–2.55m（:26）、轮廓挖洞后另建上部体量（:110-128）、内景/柜台/货架/灯（:59-85）、店招文字（:65-66）、台阶净距探测（:42-49），并 registerShop 登记 mouth/interior/approach（:124-126）。覆盖 11+13+8=32 栋（js/sz-districts/index.js:14-38），入口在 :141-146。

## 3. 与真实商圈街景相比的 5 个最明显缺口

**G1 没有门洞与凹进，店铺不可“进入视觉”**
普通楼首层全部是墙面着色（js/sz-materials.js:229-235）或一片贴面（js/sz-retail-frontage.js:103-109）；门仅作为数据记录存在且 open:false（:96）。docs/10-PERF-QA.md:34（QA-B01）明确要求核“门洞”，当前普通楼没有可射线命中的门洞。对照：js/sz-districts/facades.js:36-41 已在做轮廓凹口 + 邻接重叠排除。

**G2 店招只有楼名，没有商铺/业态**
js/sz-building-signs.js:332-341 只读 building.name；fascia 仅一条色带（js/sz-retail-frontage.js:159）；全城没有一块商铺招牌。唯一有店名的路径是商圈 kit 的 STR.districts.shops（js/sz-strings.js:154-155），且只有 3 类×3 个名字循环（facades.js:65-66 按 i%3 取）。

**G3 雨棚尺寸统一、缺少连续骑楼与店面级遮阳**
通用雨棚一栋一个、深 2.2m 固定、宽按边长比例（js/sz-building-details.js:472）；零售雨棚深仅 0.72m、门宽+0.75、约 2 成概率（js/sz-retail-frontage.js:97-100）。没有“同一栋多店多雨棚”的组合，也没有回缩式雨棚（商圈 kit 才有 0.96m 回缩，facades.js:171-174）。

**G4 首层与标准层同一材质族，缺基座/台阶/无障碍差异**
立柱、石材基座、台阶、坡道在普通楼完全缺失：js/sz-materials.js:104-107 只有 wallBase 与 trimBase；js/sz-retail-frontage.js 只做铺装高度校验（:89-93）不生成台阶。真实商圈首层通常有 0.15–0.45m 台基与石材/金属基座带，这里只有色差。

**G5 夜间首层是一条连续亮带，且整栋商业被画成店面**
js/sz-materials.js:252-257 的 groundGlow/shopGlow 只按套间给 0.45–1.0 系数，20–40m 外即退化为均匀色块；js/sz-retail-frontage.js:166-167 的“室内”依赖视角偏移，没有灯位、货架明暗、招牌灯。更要紧的是 mode 2（整栋商业）把 top 设为 maxY（js/sz-retail-frontage.js:63-70），395 栋里若含写字楼/住宅，整栋都会被画成店面网格。

## 4. 可落地方案（按收益/风险排序）

**方案 A：首层凹进 + 门洞几何（收益最高，风险中）**
- 目标：普通零售楼每 7.2m 开间出现 0.5–0.9m 凹进、≥1.6×2.4m 门洞、内景 1 背墙+2 侧墙+顶棚。
- 改动：新建 js/sz-building-frontage.js，抽取 js/sz-districts/facades.js:13-57 shopOpenings 与 :59-85 openShop 的纯几何部分；在 js/sz-retail-frontage.js:102-109 处按开间生成凹进；js/sz-buildings.js:504/515 传入新函数。
- 数据来源：现有 retailFloors + 足迹 + pavementAt，不新增外部数据。
- 性能：约 595 栋×3–8 开间×6–10 三角形 ≈ 3–5 万三角形，需在 js/sz-building-details.js:22-32 的单块 4.5 万预算内分块统计；流式半径不变。
- 回归：tests/sz-buildings.test.cjs:195-237（零售墙替换+碰撞封闭）、tests/sz-facade-material.test.cjs:142-175（节点预算）、新增纯规划单测（凹进不越界/不穿内院/共墙跳过）。
- 重建包：不需要（retailFloors 已在包内）。
- 注意：凹进不改变通行语义，保持 open:false，避免触碰 CONVENTIONS:26。

**方案 B：商铺招牌与业态词表（收益高，风险低，最省）**
- 目标：fascia 与雨棚下沿出现 2–4 字中文店招，按用途/seed 抽取，与楼名牌视觉区分。
- 改动：新增 js/sz-retail-signs.js（复用 js/sz-building-signs.js:382 planSignAtlas 与 canvas 绘制 :348-369）；js/sz-strings.js 增 retailShops 分类词表；js/sz-retail-frontage.js:159 输出 fascia 区间供贴牌。
- 数据来源：新增纯文本词表（餐饮/便利/药房/银行/服饰），标注 estimate，不使用真实品牌。
- 性能：每 600m 块 +1 图集 mesh，纹理上限 2048×4096（js/sz-building-signs.js:17-18）。
- 回归：tests/sz-building-signs.test.cjs:166-204（图集不重叠、超高减半）、:137-145（无名不出牌）；新增店招确定性测试。
- 重建包：不需要。
- 风险：品牌名与真实性——必须写“示意词表”，复用现有 appearanceSource:'estimate' 语义。

**方案 C：雨棚参数化（收益中，风险低）**
- 目标：深 1.0–3.2m 按用途/宽度变化，同一栋可 2–3 段连续雨棚，加侧板与灯带。
- 改动：js/sz-building-details.js:472 planCanopy 增 canopyDepth/segments；js/sz-retail-frontage.js:97-100 提深至 0.9–1.4m 并允许 2 个；FACADE_PROFILES 增字段但默认值等于现值。
- 数据来源：FACADE_PROFILES（js/sz-facade-profiles.js:8-74），无需外部数据。
- 性能：少量三角形（每雨棚 +4–8）。
- 回归：tests/sz-building-details.test.cjs:311-359 样板断言（way/737426464 canopy.w=18 与 y 关系）必须保持。
- 重建包：不需要。

**方案 D：夜间首层分层（收益中，风险低，纯着色器）**
- 目标：首层 2–3 档亮度 + 冷暖差异 + 店内背墙亮度梯度，消除连续亮带。
- 改动：js/sz-materials.js:252-257、js/sz-retail-frontage.js:180-185。
- 数据来源：现有时段 uniform 与 seed。
- 性能：零几何；节点数需留在 tests/sz-facade-material.test.cjs:142-175 的 colorNode≤600 内。
- 回归：tests/sz-facade-material.test.cjs:467-509（twilight≥1.5×旧、midnight≤1.5×twilight）需重设基线并留新旧对比。
- 重建包：不需要。

**不建议先做**：把 mode 2 从“整栋”收敛为“首层+2–3 层”。它要改 tools/sz/building_appearance.py:258-259 的 mode 语义并重建包，L1/L2 全部重跑，收益不如 A/B。

## 5. 与 T13 / T4 的冲突与协调点

- **T13 共享场景规范**（docs/HANDOFF.md:11、docs/REGIONS-PLACES.md:17 场景参数）：方案 A 引入凹进后，“首层连续性”“前场净空”条款需明确凹进是否计入建筑占地；门洞若被登记为入口会触碰 docs/CONVENTIONS.md:26（真实入口需独立证据）。请求 T13 先给“装饰性凹进（不可通行）/ 有来源入口（可通行）”两档字段与判定规则，否则 A 只能做成视觉凹进。
- **T4 商圈前场**（docs/REGIONS-PLACES.md:9 商业地坪依据；docs/HANDOFF.md:152：T13 已接购物公园前场样板，卓悦中心三维场地由 T4 验证）：T4 承担前场地坪与通行网络。方案 A 的台基/门槛、方案 C 的雨棚外伸（1.2–1.4m）会侵占 js/sz-retail-frontage.js:59 的 1.7m 净空；需 T4 提供 paveHeightAt 与净空查询后再定尺寸，或把 A/C 限制在 T4 已核前场之外。
- **同一栋双重生成**：商圈楼已被 js/sz-scene-site.js:114 sceneSkipIds 排除在普通楼细节之外；A 复用 district kit 时必须保持该白名单，避免 32 栋出现两套首层。
- **与零售专用雨棚的抑制关系**：js/sz-building-details.js:552-554 已抑制通用雨棚；若 A 引入新雨棚，需把抑制条件扩展到新模块，否则同栋会出现双雨棚。

## 6. 证据缺口（不得当作已通过）

- 本工作树只有 data/source，没有生成包（data/ 下仅 source/），**无法执行 L3 正式场景与 L4 浏览器可见**；所有视觉结论均为未测。
- 595 栋 retailFloors 来自 data/source/build-report.json 的 retailBuildings（groundFloor 200 / retailBuilding 395），该报告与当前代码是否同版本未知，标“待核”。
- docs/04-BUILDINGS.md:5 自认“真实店面、门洞和公共入口需逐对象核实”；docs/HANDOFF.md:75 只把“橱窗”列为外观。
- 商圈 32 栋的凹进/店招是 L2/L3（代码与白名单已接入）；docs/HANDOFF.md:89 对 COCO Park 一期东南门外给出正面/侧面/日夜 L4，但新立面覆盖 446 个普通建筑源对象只到 L3，真实门线、室内开放、其他商圈接驳待核。**普通楼首层的 L4 视觉验收未做**。
- 夜间“整栋同亮度”不成立（有逐套间 litShare），准确表述是“首层连续化、店内无纵深”，已在 G5 修正。
