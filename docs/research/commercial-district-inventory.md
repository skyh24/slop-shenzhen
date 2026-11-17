# 深圳商圈地标资产盘点

只读调研，核对于 2026-11-13。范围：购物公园—COCO Park、卓悦中心、海岸城、海上世界、欢乐海岸、万象天地、南头古城、华侨城创意园，并补充深圳湾万象城、万象城、欢乐港湾、深业上城作对照。结论中的“已接入”只表示代码或数据存在，不表示浏览器画面已验收。

## 1. 结论摘要

- 包内 102 个 retail 区域都带环、面积和建筑关联（HANDOFF.md:164），且全部走通用零售首层与雨棚（js/sz-retail-frontage.js:17-19）；但只有购物公园—COCO Park、海上世界、华侨城创意园、南头古城有专属三维模块。其余 7 处“有面、有楼、有通用首层”，没有专模、入口证据或前场路线。
- 唯一达到 L4 的商圈是 COCO Park 一期东南门外（HANDOFF.md:89）；唯一有门外局部 L5 的也是它（真实按键走 6.52 米停门外 0.48 米）。卓悦、海岸城、万象天地、深圳湾万象城、万象城、欢乐港湾均停在 L3 通用装配，没有任何 L4 画面记录。
- 三处 js/sz-districts 模块（海上世界、华侨城创意园、南头古城）提供的是“白名单楼栋改造 + 设计铺面 + 设计广场/设施 + 到达点”，不是有来源的公共边界。它们没有 L4 验收记录，设施坐标全部是场景设计值（js/sz-districts/index.js:40-69）。
- 现有审计只覆盖 urban-datum 的 4 个商业面（NEO 绿景广场、购物公园、COCO Park、卓悦中心，data/source/urban-datum.json:965-1189）；海上世界、华侨城、南头、海岸城、万象天地、欢乐海岸都不在审计范围内。
- 本轮建议：卓悦中心做“补齐空白型”体量+前场样板；海上世界做“现有模块深化型”入口证据与日夜验收。两者都不需要新增现场实测即可推进到 L3，L4 用内置浏览器同机位截图，L5 只主张已建模前场的短距离步行。

## 2. 证据等级口径

沿用 docs/10-PERF-QA.md:21：L1 来源/数据 → L2 生成 → L3 正式场景装配 → L4 浏览器同机位可见 → L5 实际操作且显示/接触一致。本文“证据等级”取**该商圈目前最强的已记录等级**，括号内注明缺口；同一商圈内不同要素等级不同时分别写。

## 3. 商圈资产总表

面积、建筑关联数、环数取自包内 mapRegions（OSM 快照 2026-11-08）。建筑关联数只表示区域多边形内关联的源足迹数量，不等于商场实际体量。

| 商圈 | 包内区域面 / POI | 三维专模 | 首层、前场铺装与入口证据 | 夜景证据 | 当前证据等级 |
| --- | --- | --- | --- | --- | --- |
| 购物公园—COCO Park | retail way/529086160 购物公园 29,161.0 m² / 16 栋 / 1 环；way/546582690 福田 COCO Park 35,271.0 m² / 7 栋 / 1 环。mapRegions.places 有 shopping-park-station 与 futian-coco-park 两条（全包仅此 2 条商圈场所） | 仅 COCO 圆筒体量壳 shopping-park-shell（js/sz-landmarks/layout.js:40，sourceIds way/238825588 + way/539435437，只做裙房与上段玻璃体分段接高）；购物公园无专模 | COCO 石材前场 3,199.08 m²（候选 5,822.01，保护 2,622.93）+ 1.36 米宽 publicRoute（data/source/urban-paving.json:14-19；build-report.json urbanPaving）；入口有源卡 data/source/coco-park-entrance-evidence.md（门线、门心、门槛厘米级高差待测）。购物公园石材 2,669.82 m²（候选 7,069.68，保护 4,374.45），无 publicRoute；B/C/D 地铁口与 COCO 东南门只到 partial（shopping-park-audit.json:123-127）；审计判定 publicWalkableArea 未知（:28） | COCO 东南门外正/侧、正午/午夜同机位 L4（docs/TASKS.md:169） | COCO 门外 L4，局部 L5；购物公园侧 L3 |
| 卓悦中心 | retail way/776141699 One Avenue 92,791.8 m² / 25 栋 / 5 环；无 places 记录 | 无（layout.js 无注册，landmarks.json 无条目） | 有商业地坪：build-report.json commercialPaving 含该 id（:358695-358701），并按车行足迹裁掉 5,176.60 m²（:358704-358717；HANDOFF.md:142 记约 5,175.13 m²）。地坪来源明写“中性硬景估测，不主张石材或公共可达”（:358702）。无入口/门线源卡；首层只有通用零售雨棚 | 无记录 | L3（二维区域面属购物公园—卓悦样区 L4，HANDOFF.md:123；三维无专模） |
| 海岸城 | retail relation/8841461 海岸城购物中心 21,532.9 m² / 3 栋 / 2 环；无 places 记录 | 无 | 只有通用零售首层雨棚；无前场铺装、无入口证据。唯一非通用记录是无人机航线：data/source/air-routes.json:61-66,117（美团无人机·海岸城商圈起飞点，柜位未公开） | 无记录 | L3（通用装配；区域面完整性待核） |
| 海上世界 | retail way/543176177 海上世界 82,965.6 m² / 16 栋 / 2 环（该 id 同时是 landmarks.json:232 的广场几何）；landmark sea-world + 到达点 sea-world-quay | 有：js/sz-districts 明华轮 4 段船体 + 4 层甲板室 + 双烟囱 + 救生艇（js/sz-districts/minghua.js），13 栋白名单改造（index.js:22-30），水面/铺装/灯具/树/绿栏（ground.js） | 设计前场铺装（拼缝 1.2 米，ground.js:45-49）、设计路线 2 条带 sourceIds、设计广场多边形；铺面 openShop 全为设计；西侧接驳桥 closed-gangway 带闭合门、不注册通行 | 只有设计灯效（heritage 卡注明为估计），无 L4 夜景记录 | L3（模块已接入；无 L4 记录） |
| 欢乐海岸 | retail way/322631274 欢乐海岸 406,801.9 m² / 166 栋 / 12 环；水秀剧场 way/359006522 为 public 3,143.3 m² / 0 栋；无 places 记录 | 无 | 通用零售首层；无前场/入口源卡。传送菜单可按区域锚点前往（js/sz-coco-park-approach.js:25,43-51） | T7 抽查有日夜画面与短距离步行（HANDOFF.md:54，L4 画面级），不是 T15 街面夜景系统验收 | L4 局部画面（模型与入口仍 L3 通用） |
| 万象天地 | retail way/586124738 华润万象天地 79,346.6 m² / 40 栋 / 1 环；无 places 记录 | 无 | 仅通用零售首层雨棚；无 urban-datum 商业面、无入口证据、无铺装源 | 无记录 | L3（通用装配） |
| 南头古城 | way/219961346 南头古城 130,813.5 m² / 345 栋 / 3 环，类型是 residential 不是 retail；landmark nantou-ancient-city + 到达点 nantou-south-axis | 有：南门砖石拱门（22 段拱券，净空 2.18 米）+ 牌坊 + 8 栋白名单 + 2 条街巷路线（js/sz-districts/nantou.js、index.js:31-38） | 设计铺装（拼缝 0.56 米）、设计店铺（浅进深展示铺位，入口/货架/柜台/招牌均为设计）；牌坊无精确足迹（index.js:168）；南达街保留车行 | 午夜灯光为设计，无 L4 记录 | L3（模块已接入） |
| 华侨城创意园 | **无区域面**（way/741581536 不在 mapRegions；landmarks.json:191 oct-loft 有） | 有：B10 圆盘/筛网/入口雨棚（10.95 米，设计估计）+ 11 栋白名单 + 2 条路线 + 广场（js/sz-districts/facades.js:203-229、index.js:14-21） | 设计铺装（拼缝 0.83 米）、设计铺面、设计广场；A3+ 楼梯带 closed-stair-gate，不注册可行走屋面（index.js:86-105） | 无记录 | L3（模块已接入） |
| 深圳湾万象城 | retail relation/19692109 深圳湾万象城 118,602.1 m² / 25 栋 / 9 环；无 places 记录 | 无 | 通用零售首层；传送菜单有区域锚点（sz-coco-park-approach.js:24）；无入口/前场证据 | 无记录 | L3（通用装配） |
| 万象城 | retail way/756810453 华润万象城 61,567.1 m² / 16 栋 / 6 环；无 places 记录 | 无 | 通用零售首层；无入口/前场证据 | 无记录 | L3（通用装配） |
| 欢乐港湾 | retail way/771513760 欢乐港湾 373,390.4 m² / 30 栋 / 4 环；无 places 记录 | 无 | 通用零售首层；无入口/前场证据 | 无记录 | L3（通用装配） |
| 深业上城（对照） | 无 retail 区域面；landmark upperhills（data/source/landmarks.json:171） | 有：双塔 388.1/299.3 米 + 裙房/LOFT 小镇 + 南梯 + 东西连桥（docs/05-LANDMARKS.md:18） | 南梯有局部实走；西侧连桥两端与桥下分层有局部证据（HANDOFF.md:144）；小镇细部为图照拟合 | 图照级，无系统夜景验收 | L4/L5 局部（建筑专模，不是商圈区域样板） |

补充事实：

- 全包 102 个 retail 区域，但 mapRegions.places 只有 2 条商圈场所；“地图有地名”与“有场所记录”是两件事。
- 华侨城创意园没有区域面，因此二维地图无法像其他商圈那样按区域高亮或生成传送锚点；它只有 landmark 入口。
- 南头古城区域类型为 residential，通用零售 storefront 不生效（js/sz-buildings.js:476-477 要求 retailIds 且 category 非 residential），其首层完全依赖 districts 模块的设计铺面。

## 4. 只有通用建筑 + 地点名的商圈：缺什么

| 商圈 | 现有 | 缺 |
| --- | --- | --- |
| 卓悦中心 | 区域面 5 环、25 栋、commercialPaving 已生成并裁车行、通用首层雨棚、地图样区覆盖 | 专模/体量分段、入口与门线证据、前场公共路线、岸边/连桥关系、按商圈的铺装统计 |
| 海岸城 | 区域面 2 环、3 栋、通用首层、无人机航线记录 | 区域面完整性核对（3 栋是否漏商场主体）、专模、入口、前场铺装、夜景 |
| 万象天地 | 区域面 1 环、40 栋、通用首层 | urban-datum 商业地坪、入口/门线、前场路线、专模；40 栋需先做足迹复核 |
| 深圳湾万象城 | 区域面 9 环、25 栋、通用首层、传送锚点 | 9 环内部关系、入口、前场、专模；与海岸城相邻，可共享一次南山后海踏勘（本轮不做） |
| 万象城 | 区域面 6 环、16 栋、通用首层 | 6 环内部关系、入口、前场、专模 |
| 欢乐港湾 | 区域面 4 环、30 栋、通用首层 | 滨海界面、入口、前场、专模；范围大，优先度低于 T14 已列对象 |
| 欢乐海岸 | 区域面 12 环、166 栋、通用首层、T7 日夜抽查 | 专模、入口、前场、街面夜景系统验收；体量过大，单轮不可控 |

已有可复用审计与源卡：

- data/source/shopping-park-audit.json（draft）：街块/场所/连接/保留特征与缺口，入口 partial、建筑 partial、路径 mapped、publicWalkableArea 明确为未知（:28, :107-141）。
- data/source/coco-park-entrance-evidence.md：入口身份、公开步行接入、门槛与接地的三段式源卡，是“入口证据卡”的现成模板。
- data/source/urban-paving.json：coco-park-southeast-stone（含 publicRoute 1.36 米）与 shopping-park-stone 两条前场铺装源。
- tools/sz/audit_commercial_paving.py:81-89：按 urban-datum 商业面输出 sourceAreaM2 / emittedPavingM2 / pavingAsphaltOverlapM2 / pavingBuildingFootprintOverlapM2，可直接用于“铺装叠路”回归。
- tools/sz/audit_shopping_park.py:146-197：区域统计、建筑抽样、地铁口，publicWalkableAreaM2 固定 None（:186-188），体现“无边界证据不给面积”的口径。
- tools/sz/urban_paving.py：石材/草坪编码、非公共 access 排除、地下/屋面/室内排除，是新增前场铺装的唯一合法入口。

## 5. 已有商圈地标模块能力与缺口（js/sz-districts）

### 5.1 能力

- 统一 kit：部件、碰撞体、标签、材质都由 createDistrictKit 生成；白名单命中才接管源楼，未命中保留通用楼（js/sz-districts/index.js:107-148）。
- 地面：铺装按路线生成，经 createRoadPolygonLayout 用车行面裁切；路线带 sourceIds；广场为设计多边形；1.24 米路线预留（ground.js）。
- 到达：sea-world-quay / oct-loft-court / nantou-south-axis 三个 walkOnly + exact 落点（index.js:70-74, 182-185）。
- 铺面：shopOpenings 有临街、同层高差 < 0.13 米、净空 2.6 米、内部在源轮廓内、退距 ≥ 1.6 米等硬门槛（facades.js:13-57），比通用雨棚更接近真实首层。
- 人群与设施：设计灯/凳/花箱/桌/艺术装置、12 米起 21 米间距双侧灯、1.15 米绿栏、树点（index.js:40-69、ground.js:247-290）。

### 5.2 缺口

1. **没有入口证据卡**。三处都没有 COCO 那样的门线/门槛/开放时段记录；西侧接驳桥是 closed-gangway（minghua.js），南头牌坊无精确足迹（index.js:168），华侨城 A3+ 楼梯 closed。到达点只是“能站人的前场”，不是“门”。
2. **设施坐标全是设计值**。FIXTURES / GREEN_EDGES / TREE_SITES（index.js:40-69）没有逐点来源，不能进验收证据；树用 simulated-district / species-estimate。
3. **铺面内容是设计**。openShop 的招牌、灯、货架、柜台均为场景设计（facades.js:59-85），不得表述为真实商家或营业状态。
4. **广场公共可达未知**。plazas 是设计多边形，没有产权/开放时段/边界证据；与 shopping-park-audit 的 publicWalkableArea 未知是同一问题。
5. **无夜景验收**。设计灯效存在，但没有同机位正午/午夜对照；T15 目前只覆盖 COCO。
6. **无专属审计**。三处都不在 urban-datum commercial 里，audit_commercial_paving.py 不覆盖；districts 铺装面积只能从 build-report 总量反推，无法按场所分项。
7. **覆盖范围有限**。每处只接管 11/13/8 栋白名单，240 米内邻楼仍是通用楼（index.js:124-125）；跨商圈连续街段没有样板。
8. **华侨城创意园没有区域面**，地图/传送/区域高亮链路缺一环；这是数据缺口，不是代码缺口。

### 5.3 与购物公园/COCO 的路线差异

COCO 是“封闭 mall + 单点门外前场”，证据链是“区域面 → 圆筒体量 → 东南门外铺装 → 门线源卡 → 6.52 米实走”。三处 districts 是“开放街区/历史街区 + 多入口 + 设计广场”，证据链缺“门线源卡”这一环，因此只能停在 L3。下一步应把 COCO 的入口证据卡模板复制到海上世界，而不是继续加设计设施。

## 6. 本轮两个目标

### 6.1 目标 A（补齐空白型）：卓悦中心体量与北侧前场

理由：

- 它是空白商圈里 L1 最强的一个：有 urban-datum 商业面（:1182-1189）、已生成的 commercialPaving、按车行裁切记录（build-report.json:358695-358718），以及“铺装叠路”这一条已记录异常（HANDOFF.md:136）。
- 与 T4 的购物公园—卓悦样区直接衔接，不需要新开地图样区；区域面 5 环、25 栋，足以验证多环区域与通用楼的接管边界。
- 不需要现场实测就能做到 L3：体量分段、前场边界闭合、叠路归零都能在包内数据上验收。L4 只做同机位画面，L5 只主张前场短距离步行。

可用来源：

- data/source/urban-datum.json:1182-1189（商业面与 excludeGroundCarriageway）。
- data/source/build-report.json:358695-358718（commercialPaving 总量、来源声明、车行裁切）。
- js/sz-city.json.gz 的 mapRegions way/776141699（5 环、25 栋）。
- js/sz-coco-park-approach.js:23（区域传送锚点已存在）。
- tools/sz/audit_commercial_paving.py（叠路/建筑压占审计）。

需要新增的 data/source 记录：

1. data/source/one-avenue-audit.json（draft）：按 5 个环拆街块/场所，记录 entrance=partial、building=partial、path=unknown、publicWalkableArea=unknown，风格对齐 shopping-park-audit.json。
2. data/source/one-avenue-entrance-evidence.md：只写可核事实（OSM 标签、公开图照、商业面边界），门心/门宽/门槛/开放时段一律写“待测”；不要从商业面反推入口。
3. data/source/building-footprint-reviews.json 增 5 环内部重叠与漏栋核对记录（现有文件已有 307 行南头候选的先例）。
4. 若要把前场升级为石材，必须先在 urban-paving.json 增有来源的 one-avenue 记录；没有来源就维持 build-report 的中性硬景，不得借 COCO 的石材参数。

验收路线：

- L1：审计 JSON + 入口证据卡字段齐全，未知项显式。
- L2：build.py 重建后，commercialPaving 中该 id 的 pavingAsphaltOverlapM2 归零或低于阈值；sourceArea 与 emitted 差值可解释。
- L3：layout.js 注册专模（体量分段 + 前场边界），通用楼按 sourceIds 退出；build-report 记录新增/退出数量。
- L4：北侧福华三路、南侧福华路两个同机位正午画面；不宣称夜景。
- L5：从北侧人行道走到前场边界 100–200 米，脚底与采样面同高，边界处不穿模；同时验证 T11 区域锚点落点不落在车行面。

### 6.2 目标 B（现有样板深化型）：海上世界入口与日夜验收

理由：

- 三处 districts 里它最完整：船体、水面、13 栋、铺装、灯具、树、到达点都有（index.js:22-30, 149-155；minghua.js；ground.js），但 HANDOFF 没有任何 L4 记录，深化成本最低、收益最直接。
- 深化内容是“证据闭合”而不是“再加设计物”：入口/门线、桥门状态、池岸标高、开放铺面清单。heritage 卡已把未知项写清楚，不会产生新的事实风险。
- 与 T15 的方法天然对齐：同机位正午/午夜，可以直接复用 COCO 的验收流程。

可用来源：

- data/source/landmarks.json:232（sea-world 及 sceneReview）。
- data/source/heritage-districts-evidence.md（明华轮 168×21 米、接驳桥 way/543176160–161、罩棚 way/543176183、设计灯效与池水标高为估计）。
- js/sz-districts/index.js:113-116, 149-155（basin 双点判据、船体、罩棚）。
- js/sz-districts/ground.js（路线 sourceIds、1.24 米预留、水景）。

需要新增的 data/source 记录：

1. data/source/sea-world-entrance-evidence.md：西侧接驳桥门线、广场主入口、明华轮登船口（closed）、池岸/喷泉范围、开放时段；全部标注“已核/估计/未知”。
2. data/source/landmarks.json 的 sea-world.sceneReview 增 entrance 与 opening 字段，指向上述卡片。
3. 若新增夜景验收，只在本地 QA 记帧时与机位，不新增“真实照明方案”主张。

验收路线：

- L1：入口卡三段式（身份/接入/门槛）齐全，桥门 closed 与登船口 closed 写明。
- L3：确认 13 栋中哪些铺面是 openShop 设计、哪些是纯立面；输出清单，避免把设计铺面当真实商铺。
- L4：明华轮正面、广场、西侧桥头三个机位，正午 + 午夜同机位对照；午夜只验可读性，不主张真实灯效。
- L5：从 sea-world-quay 步行到船前与桥头，接触一致；桥门不可穿越，后退可退出。

### 6.3 本轮不选及理由

- 万象天地：无 urban-datum 商业面、无入口证据，40 栋需先做足迹复核；L1 不足，容易把“街区型”做成布景。
- 海岸城：区域面仅 3 栋，商场主体是否漏画未知；先补足迹复核再谈专模，否则会把缺栋固化成错误体量。
- 欢乐海岸：406,801.9 m² / 166 栋，单轮不可控；T7 已有日夜抽查，重复投入收益低。
- 深圳湾万象城：118,602.1 m² / 9 环，内部关系复杂；应与海岸城合并为一次南山后海批次，而不是本轮单点。
- 深业上城：已有建筑专模与西桥局部 L5，属 T7 范围，不是商圈区域样板。

## 7. 与 T4 / T11 / T15 的重叠与派工边界

| 已有工作 | 归属 | 本盘点建议的边界 |
| --- | --- | --- |
| 区域面、公共边界、门槛、门内接续、前场铺装 | T4（docs/TASKS.md:61） | 卓悦专模/前场是 T4 子项，不另立任务；购物公园前场样板已由 T13 接入（HANDOFF.md:152），不要重做 |
| 地图选点、前往、落点、商圈同名消歧、有来源步行入口 | T11（docs/TASKS.md:149） | 本盘点只交付 region id、锚点现状与入口证据卡；MENU_REGIONS 已覆盖购物公园/卓悦/深圳湾万象城/欢乐海岸四个区域锚点（js/sz-coco-park-approach.js:21-28, 43-51），缺的是“有来源入口”而非“能前往” |
| 街面夜景 | T15（docs/TASKS.md:169） | 海上世界夜景验收走 T15 方法，不新建夜景任务；T15 当前仍只覆盖 COCO 东南门外 |
| 建筑专模、共边、立面 | T7（docs/TASKS.md:79-93） | 卓悦 25 栋立面/共边/高度不重做，沿用 T7/T9 成果 |
| 场所逐处推进 | T14（docs/TASKS.md:171-173） | 本表是 T14 的排序输入，不替代 T14 的逐处验收 |
| 模块整理 | T13（docs/TASKS.md:161-165） | districts 模块迁入统一 kit 时复用，不在本盘点范围内改代码 |

另外：

- shopping-park-audit 是 draft，不是运行时区域库（docs/REGIONS-PLACES.md:10）；不要把它当“已验收边界”。
- audit_shopping_park.py 只对该 draft spec 运行，publicWalkableArea 恒为 None（:186-188）；任何“商圈可步行面积”数字都不能由包内铺装或建筑差集推出。
- COCO 的 L5 是“门外 6.52 米”，不是“进入商场”；室内开放仍未验（HANDOFF.md:89）。

## 8. 待核清单

- 卓悦 5 环是否完整覆盖商场主体；25 栋关联里是否有重叠/漏栋。
- 卓悦 commercialPaving 与车行面的残余叠路面积（HANDOFF.md:136 仍列为保留异常）。
- 海岸城 relation/8841461 仅 3 栋：是商场单一体量，还是区域面不完整。
- 万象天地 40 栋中哪些是商场主体、哪些是住宅/办公；无商业地坪时前场边界如何闭合。
- 海上世界西侧接驳桥的实际门线、开放状态与桥下净空。
- 南头古城牌坊的真实位置与尺寸（现为设计值）；南达街车行与步行混行的边界。
- 华侨城创意园为何没有区域面（OSM 缺失还是筛选规则排除）；无区域面时的地图高亮方案。
- districts 设计设施（灯/凳/树/绿栏）是否有可替代的来源点位；没有就只能标设计。
- 三处 districts 的人群轨道是否接入 T8 的连续步行网络；目前只有 publicRoutes，跨商圈连续性未知。

## 9. 证据索引

- 区域与商圈总述、审计入口：docs/REGIONS-PLACES.md:5-11, 19, 29。
- 地标装配与“有地名不等于有专模”：docs/05-LANDMARKS.md:7, 34。
- 任务状态：docs/TASKS.md:61（T4）、:149（T11）、:169（T15）、:171-173（T14）。
- 验收与画面结论：docs/HANDOFF.md:89（COCO L4/L5）、:123（地图样区 L4）、:136/:142（卓悦铺装）、:54（欢乐海岸抽查）、:152（购物公园前场）、:164（区域统计）。
- 入口源卡模板：data/source/coco-park-entrance-evidence.md。
- 购物公园审计：data/source/shopping-park-audit.json:28, 107-141。
- 铺装源：data/source/urban-paving.json:14-19, 57。
- 商业地坪与裁切：data/source/urban-datum.json:965-1189；data/source/build-report.json:358695-358718。
- district 模块：js/sz-districts/index.js、ground.js、facades.js、minghua.js、nantou.js。
- 通用零售首层：js/sz-buildings.js:476-477；js/sz-retail-frontage.js:17-19；js/sz-scene-site.js:117-125。
- 传送区域锚点：js/sz-coco-park-approach.js:21-28, 43-51。
- 审计工具：tools/sz/audit_commercial_paving.py:81-89；tools/sz/audit_shopping_park.py:146-197；tools/sz/urban_paving.py。
