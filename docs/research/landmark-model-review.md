# 地标专模与夜景辨识度调研

范围：只读审查。未改运行代码、未提交、未启动浏览器；所有"夜间表现"结论来自材质/几何参数推断（L2），不含截图验收（L4）。
证据等级沿用 [docs/10-PERF-QA.md:21](../10-PERF-QA.md)：L1 来源/数据 → L2 生成 → L3 正式场景 → L4 浏览器可见 → L5 显示/接触一致且实际操作。

## 0. 结论

1. **注册数量口径三处不一致**：[docs/05-LANDMARKS.md:7](../05-LANDMARKS.md) 写 13 个建筑专模，HANDOFF 写 16，任务前提 21，而 `js/sz-landmarks/layout.js:30-60` 实际注册 **23 个建筑模型 + 4 个场馆 = 27 项**（第 51 行 `...sportsLandmarks`，来源 `sports-venues.js:370-372`，venues 共 5 个、`chunjian` 已在第 45-50 行单独合并）。文档口径需统一，否则"21 个"无法核对。
2. **05 号文档只覆盖 13 个模型**（第 13-25 行表），另外 10 个注册模型没有任何参考卡：`qianhai-museum`、`bay-opera`、`mocape`、`tencent-towers`、`university-town-library`、`diwang`、`kk100`、`shenzhen-stock-exchange`、`shopping-park-shell`、`shenzhen-north`。本报告的改法依据只能落在源码与源足迹上。
3. **夜景最大系统性缺口不在单体模型，而在接线**：`js/sz-scene-site.js:126` 的 `detailSkipIds` 含 `landmarks.skipIds`，第 131-133 行把它作为 `excludeIds` 传给 `buildSzLightShow`，因此灯光秀**不覆盖任何专模源楼**；`planLandmarkBands` 只认平安 8 根巨柱（`js/sz-light-show.js:90-98` 的 `/:mega-column:(\d+):(\d+)$/`）。全城 27 个专模里只有平安参与节目。
4. **夜间"发光面"高度不均**：仅 13 个 style 走 `crownMaterial`（`materials.js:263-277`），`landmarkEdge` 强度只有 0.15；`programEmission` 只挂 4 个 style（`materials.js:224` 的 `CBD_GLASS_STYLES`）。大量结构材质完全没有 `emissiveNode`（见 §6），这些体量在夜间只剩剪影。
5. **最弱 5 个**（23 个建筑模型内，四维总分最低）：`shopping-park-shell`(5)、`shenzhen-stock-exchange`(8)、`bay-opera`(11)、`tencent-towers`(11)、`iec-xiangmihu`(11)。次弱 `press-tower`/`diwang`/`convention-center`(12) 主要输在夜间。

## 1. 21/27 个注册专模简表

部件数为在 fixture 计划上实测（`planSzLandmarks` 输出 `plan.parts` 计数，L2 证据；civic/chunjian/convention 的大数主要来自屋面三角面，不代表细节密度）。
"夜间"列只写各模型实际用到的发光通道。

### 1.1 建筑专模（23）

| # | 模型 | 文件 | 部件/复杂度 | 材质与夜间 | 最容易被认出的特征 | 明显缺失或失真 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | qianhai-museum | `qianhai-museum.js` | 36 件 / 5 style | `cultureCladding` 0.11，`cultureSkylight` crown 0.33 | 五级出檐 + 内收玻璃 + 顶层凹园 | 屋顶坡线未核实（05 未列卡） |
| 2 | bay-opera | `bay-opera.js` | 31 件 / 3 style | `operaPearl` cultureCladding **0.045**（全仓最暗之一） | 白色"珍珠"主厅 + 铜门架 + 广场波形挑檐（`bay-opera.js:42-49`） | 50 m 舞台体接近方盒（`:22-23`）；无海侧界面；夜间几乎不亮 |
| 3 | mocape | `mocape.js` | 83 件 / 4 style（其中 49 件是 48 级台阶） | `mocapeMetal` 0.064 | 双 40 m 体量 + 东侧裂隙 + 拱檐 13 段 | 体量贴源足迹，折面靠 panelStrip 近似 |
| 4 | tencent-binhai | `tencent-binhai.js` | **8 件** / 4 style | `tencentCopper` glow `0xffb179`（无 wash） | 双塔 + 铜色文化连层 + 两根门廊柱 | 无幕墙竖挺、无入口雨棚；首层只有 2 根柱（`:30-31`） |
| 5 | tencent-towers | `tencent-towers.js` | 11 件 / 4 style | `tencentLegacyGlass` wash 0.04 | 24 边形梭形双塔 6 段收分 + 悬挑雨篷 | 无竖挺/无幕墙分格；连桥只有体量 |
| 6 | university-town-library | `university-town-library.js` | 129 件 / 5 style | ribbon wash 0.12；`libraryShell` **无 emissive** | 跨河长卷 + 北端卷壳 + 36 级台阶 | 夜间壳体和平台全暗 |
| 7 | diwang | `diwang.js` | 11 件 / 4 style | `diwangGlass` wash 0.047/0.074，尖杆 `landmarkEdge` 0.15 | 双圆冠 + 双 384 m 尖杆（`:35-36`）+ 两道 290-304 m 冠带 | 塔身是源足迹直挤、无分层；夜间双尖几乎不可见 |
| 8 | kk100 | `kk100.js` | 9 件 / 3 style | `kkCrown` wash 0.19 | 8 段收分不对称拱顶（441.8 m） | 只有一种玻璃，冠部无细节 |
| 9 | shenzhen-stock-exchange | `stock-exchange.js` | **3 件** / 3 style | `stockExchangeTower` 无 wash（仅 lit 0.11） | （现实中）抬升基座 + 斜交网格 | 模型只有 lobby/podium/tower 三个体量，OMA 的悬浮感和斜交网格全缺 |
| 10 | shopping-park-shell | `shopping-park-shell.js` | **2 件** / 2 style | 两种 style **都无 wash** | 圆筒 + 弧形裙房 | 无首层/雨棚/招牌/入口/前场；圆筒是源足迹直挤 |
| 11 | dji-sky-city | `dji-sky-city.js` | 380 件 / 6 style | `djiBridgeEdge` 0.23、`djiBrace` 0.18、`djiGuard` 0.035 | 双塔 12 个悬浮体 + 89.75 m 起拱连桥（`:152-155` 校验桥端埋入） | 塔高口径分歧、地面残留足迹待核（05:15） |
| 12 | ping-an | `ping-an.js` | 156 件 / 8 style | `pingAnCrownEdge` 0.86、`pingAnCrown` 0.77、`pingAnSteel` 0.16-0.45 + `programEmission` | 八边形收分 + 8 巨柱 + 4 面 V 撑 + 钻石冠（599.1 m） | 逐部件比例为照片拟合（05:16） |
| 13 | chunsun | `chunsun.js` | 631 件 / 6 style | `chunsunCrown` wash 0.66、`chunsunCrownSteel` 0.69 | 28 组×2 侧斜交肋 + 15 段壳体收分 + 2.8 m 内退首层 | 首层基底/下沉广场/滨水连接缺来源（05:14） |
| 14 | civic-center | `civic-center.js` | 4486 件（屋盖三角面 3765）/ 7 style | `civicTrim` 0.55 + `civicGlass` 节目；`civicStone`/`civicTowerRed/Yellow` **无 emissive** | 13 m 网格波浪屋盖 + 红黄双塔 + 17×2 树状柱 | 曲面/柱位为估计（05:24）；夜间双塔不亮 |
| 15 | chunjian | `chunjian.js` | 5762 件（屋面 3694）/ 5 style | `stadiumRib` roof wash 0.05 | 10 m 三角网壳 + 海之门 + 8 根树形柱 | 工程 +6 m 平台缺绝对基准（05:19） |
| 16 | convention-center | `convention-center.js` | 3360 件 / 6 style | `conventionSkylight` 0.14；`conventionRoof/Hall/Rib/Stone` **无 emissive** | 9 馆 + 15×11 屋面网格 + 30 m 采光带节奏 + 42 级北台阶 | 夜间屋盖整体全暗；入口细部少 |
| 17 | upperhills | `upperhills.js` | 514 行、数百件（未统计） | 自建 `0xf3d2a2`/0xc7e1f3 emissive（`:490`） | 双塔幕墙凹槽百叶 + 32 个 LOFT 小镇体块 + 东西公园桥 | 小镇细部为图照拟合（05:18） |
| 18 | nonferrous-tower | `nonferrous-tower.js` | 48 件 / 7 style | 檐底灯 0.85（`:192`）+ 立面 0.85 lit（`:225`） | 三件套弧面共边 + 上段 11 层弧阳台 + 7 柱门廊 | 北侧真实入口未知（05:21） |
| 19 | press-tower | `press-tower.js` | 34 件 / 5 style | `landmarkEdge` 0.15 + `pressTowerGlass` 节目 | 弧形玻璃翼 + 每侧 4 层外露桁架 + 11 段"新闻眼" + 260 m 尖塔 | 塔身源足迹直挤、无竖挺；夜间轮廓只靠 0.15 |
| 20 | iec-xiangmihu | `iec-xiangmihu.js` | 32 件 / 6 style | 自建 glow（`:191`）、檐口 0.08、大堂 0.22 | 南/北翼 35.5/43.57 m 檐口 + 酒店 99.9 m | 体量与高程全 estimate（05:23） |
| 21 | shenzhen-north | `shenzhen-north.js` | 71 行 / 5 style | `northGlass` wash **0.6**（夜间最亮的专模之一） | 13 段×4 条长屋面 + 2 个无柱雨棚 + 两侧 12 根柱廊柱 | 缺站台/轨行/换乘细节；需 `northRail` 否则返回 []（`:11`） |
| 22 | super-hq | `super-hq.js` | 245 件 / 7 style | 自建 lit 0.85 + 冠部 90-320 m 渐变（`:786`） | C 塔双塔 + 119.15 m 连廊下挂 33 m 倒三角 V + 十字双轴 | 全部 design/estimate，0 个 published（`:9-17`） |
| 23 | shenzhen-bay-culture-square | `shenzhen-bay-culture-square.js` | 278 行、9 块巨石（22 环 loft）+ 29 m 起伏屋面 | `culturePark` 铺装遮罩 + 石材 | 9 个巨石体量 + 整片可走屋面公园 | 施工图未取得，坡线/标高待核（05:20） |

### 1.2 场馆（4 个独立注册 + chunjian 合并项）

| 模型 | 部件/复杂度 | 夜间 | 特征 | 缺失 |
| --- | --- | --- | --- | --- |
| `shenzhen-stadium` 深圳体育场 | 碗状生成器（`sports-venues.js:332-368`） | `sportsRoof` 无 emissive | 68×105 场地 + 看台 | 屋盖/立面都靠单一 `sportsRoof` |
| `shenzhen-gymnasium` 深圳体育馆 | arena 分支 | `sportsLamp` emissiveIntensity 0.65（唯一发光场馆） | 封闭馆体 | 只有体量 + 灯位 |
| `szu-yuanping-stadium` | campus 碗 | 同上无 emissive | 深大元平场 | 无看台分缝/罩棚 |
| `university-town-stadium` | university 碗 | 同上无 emissive | 大学城场 | 同上 |

## 2. 四维评分（1-5，主观但有源码依据）

远看轮廓 / 中距材质 / 近看首层与部件 / 夜间表现。

| 模型 | 远 | 中 | 近 | 夜 | 总 | 主要依据 |
| --- | --- | --- | --- | --- | --- | --- |
| ping-an | 5 | 5 | 4 | 5 | 19 | 8 style、0.86/0.77 冠、节目 + 巨柱灯带 |
| chunsun | 5 | 5 | 4 | 5 | 19 | 631 件、0.66/0.69 自发光、内退首层 |
| dji-sky-city | 5 | 4 | 4 | 4 | 17 | 380 件、桥缘 0.23 |
| chunjian | 5 | 4 | 4 | 3 | 16 | 网壳 + 海之门；屋盖只有 0.05 |
| shenzhen-bay-culture-square | 5 | 4 | 3 | 2 | 14 | 9 巨石轮廓强；夜间只靠石材/铺装 |
| upperhills | 3 | 4 | 4 | 2 | 13 | 小镇 + 桥近景强；自建 emissive 但无冠灯 |
| nonferrous-tower | 3 | 3 | 4 | 3 | 13 | 檐底灯 0.85；轮廓普通 |
| civic-center | 4 | 3 | 3 | 3 | 13 | 屋盖可读；双塔夜间不亮 |
| tencent-binhai | 4 | 4 | 2 | 3 | 13 | 铜连层可辨；仅 8 件 |
| qianhai-museum | 4 | 3 | 3 | 2 | 12 | 五级出檐；0.11 |
| mocape | 4 | 3 | 3 | 2 | 12 | 双体裂隙；0.064 |
| university-town-library | 3 | 3 | 4 | 2 | 12 | 卷壳/台阶；壳无 emissive |
| diwang | 4 | 3 | 3 | 2 | 12 | 双尖在；wash 0.047-0.074 |
| kk100 | 4 | 3 | 3 | 2 | 12 | 拱顶在；0.19 |
| convention-center | 3 | 3 | 4 | 2 | 12 | 9 馆屋盖；夜间全暗 |
| press-tower | 4 | 3 | 3 | 2 | 12 | 桁架/新闻眼；0.15 |
| super-hq | 4 | 3 | 3 | 2 | 12 | 连廊 V；全 estimate |
| shenzhen-north | 4 | 2 | 3 | 3 | 12 | 长屋面 + wash 0.6；材质单薄 |
| **bay-opera** | 4 | 3 | 3 | **1** | **11** | 珍珠形在；0.045 夜间近黑 |
| **tencent-towers** | 3 | 3 | 3 | 2 | **11** | 梭形在；wash 0.04 |
| **iec-xiangmihu** | 3 | 3 | 3 | 2 | **11** | 檐口/酒店；体量 estimate |
| **shenzhen-stock-exchange** | 2 | 2 | 2 | 2 | **8** | 3 个体量，无悬浮/斜交网格 |
| **shopping-park-shell** | 1 | 2 | 1 | 1 | **5** | 裙房 + 圆筒，无首层/无发光 |
| 4 个场馆（平均） | 2.5 | 2 | 3 | 1.5 | 9 | 碗状生成器 + 单一屋面材质 |

## 3. 最弱 5 个与改法

排序规则：23 个建筑模型按总分升序；同分按"夜间"再按"近看"排。场馆另作一类（§1.2），不与城市级地标混排，但其屋盖/夜间问题同源（见 §6）。

### 3.1 `shopping-park-shell`（5 分：1/2/1/1）——几何 + 材质 + 环境三重缺失
只有 2 个 part（`shopping-park-shell.js:11-13`），裙房 + 圆筒，共边由 `createBuildingEnvelopePlan` 裁切；**没有首层、雨棚、入口、招牌、前场**，两种 style 都无 `wash`（`materials.js:32-33`）。
改法：
1. **首层内退 + 通长雨棚**：在 `build()` 里对 `podium` 增加 5-6 m 高内退环（`footprintParts` 用 `{min: base, max: base + 5.5, bottomFace:false}`），外侧加 2.2 m 深雨棚板（`roofPanelPart` 或 `volume()`），材料沿用 `shoppingParkBase`。风险：雨棚顶面会被当成可站面，需显式 `topFace:false` 或 `roofContact:false`；共边测试 `tests/sz-landmarks.test.cjs:169`、`:737` 需同步。
2. **圆筒改真圆**：现在 `upper` 是源足迹直挤。用 `model-profile.js` 的 `ellipse()` + `stackedLofts()` 拟合（半径按 `upper` 包围盒内切圆），顶部 2 段收分。风险：碰撞体从多边形变圆，四角净空变大，需 `:169` 断言更新。
3. **夜间**：`materials.js:32-33` 给 `shoppingParkBase` 加 `wash: 0.16`、`shoppingParkGlass` 加 `wash: 0.1`；再给圆筒顶部加一圈 `shoppingParkCrown`（`crownMaterial(0x..., 0.4, 0.3, 0.45)`）。新 style 必须同时在 `createLandmarkMaterial` 注册，否则 `materials.js:304` 会抛 `Unknown landmark material`。

### 3.2 `shenzhen-stock-exchange`（8 分：2/2/2/2）——几何缺失最严重
`stock-exchange.js:11-16` 只有 lobby（`topFace:false`）、raised podium、tower 三个 `footprintParts`。OMA 方案的两个识别点——**抬升的悬浮平台**与**斜交网格立面**——都没有。
改法：
1. **悬浮基座**：podium 顶面抬到 `podium.minHeight + 8`，下方用 2 排 `column()`（半径 0.8、间距 ~12 m）落地，形成"平台浮起"的负空间；参考无 05 卡，只能按源足迹 + 现状照片判读，证据级别 L1 足迹 / L2 形态。
2. **斜交网格**：用 `renderLandmarkTrim` 的 InstancedMesh 在 tower 四角加 ±45° 斜撑（边长按层高 8.1 m、间距 7 m，约 60-80 根），不新增 draw call（`render.js:172-186`，`cullDistance: 140`）。
3. **夜间**：`materials.js:29` 的 `stockExchangeTower` 无 `wash`，加 `wash: 0.12`；该楼在福田范围内，可考虑并入 `CBD_GLASS_STYLES`（`materials.js:224`）参与节目。风险：悬浮平台会改变 `approaches()`（`:19-22`）的通行净空。

### 3.3 `bay-opera`（11 分：4/3/3/1）——夜间最弱的城市级地标
`operaPearl` 的 `cultureCladding` glow 只有 **0.045**（`materials.js:257`），夜间几乎不发光；50 m 舞台体是 `rect(-28,-14,28,14)` 直上直下（`bay-opera.js:21-23`）。
改法：
1. **夜间**：`materials.js:257` 把 `operaPearl` 的 glow 从 0.045 提到 0.2-0.24，或改成 `crownMaterial(0xcfd1ce, 0.4, 0.3, 0.35)` 的混合；这是**单参数、零几何风险**的改动，建议先做。
2. **舞台体收分**：`towerSegment` 顶段再收 0.88，并加 8-12 根竖向百叶（trim），避免"方盒子"。
3. **海侧界面**：沿 `hall.maxZ` 补 1 段 40 m 檐廊（现状只有广场侧 `panelStrip` 10 段，`:42-49`）。风险：檐廊占滨海步道，需 `approaches()` 与 `reservesApproach` 同步（`index.js:42-46`）。

### 3.4 `tencent-towers`（11 分：3/3/3/2）——材质与近景单薄
11 件、4 style，`tencentLegacyGlass` wash 0.04（`materials.js:21`）；门厅只有 11 根 trim。
改法：
1. **幕墙竖挺**：沿 24 边形外环每 ~1.6 m 一根，两塔约 240 根，走 `renderLandmarkTrim`（1 个 draw call、140 m 外剔除），不影响远景帧率。
2. **首层**：补 2 处入口雨棚 + 4 级台阶（`model-profile.js` 的 `rect`/`volume`）。
3. **夜间**：wash 0.04 → 0.12-0.14（`materials.js:21`）。风险：trim 会增加近景三角形，但实例化后总量可控；碰撞不变。

### 3.5 `iec-xiangmihu`（11 分：3/3/3/2）——体量全 estimate，环境依赖重
32 件、6 style，自建材质（`iec-xiangmihu.js:191` 的 lit、`:227` 檐口 0.08、`:261` 大堂 0.22）；地面广场在 `iec-grounds.js` 单独建。
改法：
1. **檐口灯带**：`iec-xiangmihu.js:227` 的 0.08 → 0.22，勾出 35.5/43.57 m 两道檐口，这是夜景唯一可读的线条。
2. **屋面天窗带**：南北翼屋面上加 3-4 条 `iecSkylight` 采光带（复用 `roofPanelPart`），补"会展"中距材质层次。
3. 不动的部分：酒店塔高 99.9/框架 105.95 参与 `sz-apec.js:132` 的站位，改尺寸会连带 APEC 锚点；建议只加灯和天窗。风险：APEC 场景回归。

### 3.6 次弱提示（12 分，夜间同为 2）
- `press-tower`：塔身是源足迹直挤、无竖挺，夜间全靠 `landmarkEdge` 0.15。最小改动是把 `pressTowerSteel`（`materials.js:271`，当前纯 Standard、无 emissive）换成 `crownMaterial(0x939da5, 0.39, 0.48, 0.3)`，让外露桁架在夜间发亮——这是它最独特的部件。
- `diwang`：双尖是 `landmarkEdge` 0.15 的 12 边锥（`diwang.js:35-36`），夜里几乎消失。把两根尖杆换成 `crownMaterial(..., 0.55)` 或新增 `diwangSpire` style，收益/风险比很高。
- `convention-center`：`conventionRoof/Hall/Rib/Stone` 四个材质都无 emissive（`materials.js:299-303`），9 个馆的屋面网格在夜间完全丢失；给 `conventionRoof` 加 0.1-0.15 的 wash 即可恢复屋面节奏。

## 4. `shopping-park-shell` 专项评估

**结论：不足以代表 COCO Park / 购物公园（当前是"占位体量"，不是模型）。**
- 现状：2 个 part、2 种 style，无首层、无入口、无雨棚、无招牌、无前场、无夜景；圆筒是源足迹直挤，不是真圆（`shopping-park-shell.js:11-17`）。
- 唯一可辨元素是"裙房 + 一个上段圆筒"的体量关系；远看只能读到"这里有个商场"，读不出"购物公园"。
- 与 HANDOFF 的"购物公园东南门 L4 + 局部 L5"不是同一件事：那条是对**现实场所**的验收，模型里没有对应的入口几何，两者不能互相证明。

**最值得补的 3 个特征（按收益排序）**：
1. **首层通高玻璃 + 内退柱廊 + 通长雨棚**（购物中心的第一识别层；同时解决"近看 1 分"）。实现：`build()` 内 2-3 个 `footprintParts`/`volume`，材料 `shoppingParkBase` + 新增 `shoppingParkCanopy`。
2. **圆筒真圆化 + 顶部灯带/灯箱位**（COCO Park 唯一记忆点）。注意：不做品牌字，招牌内容需按 AGENTS 约定走 `sz-strings.js` 并确认，不得直写 "COCO Park"。
3. **东南门入口广场**：铺装 + 3-4 级台阶 + 2 处树池/灯柱，接 `approaches()`，让玩家能从街面走进来（与 HANDOFF 的实走结论对齐）。风险：入口广场会占用 `reserveWalk` 带，需查 `sz-scene-site.js:176` 的预留链。

## 5. 夜景的系统性缺口（比单体更值得先修）

| 缺口 | 证据 | 影响 |
| --- | --- | --- |
| 灯光秀排除全部专模 | `sz-scene-site.js:126,131-133`（`excludeIds: detailSkipIds`，含 `landmarks.skipIds`） | 27 个专模里只有平安巨柱有节目灯带（`sz-light-show.js:90-98`） |
| 节目材质只挂 4 个 style | `materials.js:224` `CBD_GLASS_STYLES` | 春笋、大疆、会展、市民中心之外的专模没有节目动画 |
| 冠灯是静态常量 | `materials.js:100-104` `crownMaterial` | 没有呼吸/流动，远看是死光 |
| 轮廓灯只有 0.15 | `materials.js:263` `landmarkEdge` | 报业、地王尖杆、腾讯门廊夜间轮廓极弱 |
| 结构材质无 emissive | `materials.js:259,262,271,284-287,291-293,299-303` | 会展屋盖、市民中心双塔、场馆屋盖、文化广场石材夜间只剩黑剪影 |

建议（小步、可回归）：
1. 在 `sz-light-show.js` 增加"专模包围盒竖带"分支：用 `landmarks.colliders` 的包围盒 + 高度生成 4 条竖带，不再依赖源楼是否被排除；或最小改法——把 `detailSkipIds` 中属于专模的 id 从 `excludeIds` 里剔除（但专模源楼已不渲染，灯带会浮空，故必须走前者）。
2. 给 `crownMaterial` 增加一个 0.05-0.1 的低频脉动（复用 `sceneUniforms.night` 已有的时间 uniform），一次改动覆盖 13 个 style。
3. 把 `pressTowerSteel`、`civicStone`、`civicTowerRed/Yellow`、`conventionRoof`、`stadiumRoof` 五个"大面"材质补最小 emissive（0.08-0.15），只影响夜景通道，不动几何。

## 6. 证据缺口（按等级）

- **L1**：源足迹/高度来自 `js/sz-city.json.gz`（本次用 `decodeCityPayload` 实测），可信。购物公园圆筒无"真圆"来源；证券交易所的 OMA 形态无 05 卡、无附件，属形态判读。
- **L2**：部件数、style 数、包围盒最高点均为本次实测；材质发光值直接读 `materials.js`。可信。
- **L3/L4**：**未做**。本次只读，未启动浏览器，所有"夜间表现"是基于参数与材质的推断，不是截图验收。任何"改完变好"的判断都需要一次 `main` 上的日夜截图（黄昏/夜间各一张，固定机位）。
- **L5**：未做。首层/入口改动必须实走，否则"可见"不等于"可进"。
- 05 号文档缺 10 个模型的参考卡（见 §0.2），这是后续所有改法无法标注"参考特征来自 05 第几条"的根因。

## 7. 建议的 3 个最高优先级改造（收益/风险排序）

1. **夜景接线：让灯光秀覆盖专模（收益最高、风险低）**——`js/sz-light-show.js` 新增专模包围盒竖带分支 + `js/sz-scene-site.js:130-133` 传入 `landmarks.colliders`；同时把 `crownMaterial` 加低频脉动。一次改动点亮 20+ 个地标，不碰几何、不重建数据包；回归面：`tests/sz-landmarks.test.cjs` + 一次夜间截图。
2. **补 `shopping-park-shell` 的首层/雨棚/真圆 + `stock-exchange` 的悬浮基座与斜交网格（辨识度缺口最大）**——两个模型分别只有 2 件、3 件，改完就是从"占位"到"可认"；风险集中在共边与碰撞测试（`tests/sz-landmarks.test.cjs:169,737`）。
3. **统一夜间材质表（收益中、风险最低）**——`js/sz-landmarks/materials.js`：`landmarkEdge` 0.15→0.3、`shoppingParkBase/Glass` 加 wash、`pressTowerSteel`/`conventionRoof`/`civicStone`/`civicTowerRed`/`civicTowerYellow`/`stadiumRoof` 补 0.08-0.15 emissive、`operaPearl` 0.045→0.22。纯参数，零几何、零碰撞；新 style 必须注册否则 `materials.js:304` 抛错。

## 8. 测试与回归面

- 现有覆盖：`tests/sz-landmarks.test.cjs:169`（购物公园共边单壳）、`:737`（裙房顶面裁剪）、`:105`（只退源对象、快照不全回退）、`:354`（碰撞射线）、`:698`（材质分发器）。
- 新增几何后至少补：新 part 的 `partCollider` 高度与 `roofContact` 断言；新 style 的 `createLandmarkMaterial` 断言（否则运行期才抛错）。
- 性能：本报告所有建议都不改变 `renderChunkSize`，新增 trim 一律走 InstancedMesh + `cullDistance 140`；圆筒真圆化会让一个 batch 的顶点数小幅上升，可忽略。
