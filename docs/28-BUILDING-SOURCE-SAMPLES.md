# 28 建筑来源本地样本对比：福田高层、科技园、城中村、立交周边

状态：**调研文档，未改代码、未重建数据包**。日期 2026-11-11。任务来源：[23 号第 3 节](23-BUILDING-AND-STREET-PLAN.md)（先做深圳本地样本，再决定用哪套源）和第 8 节第 3 步。

编号说明：任务原本指定 `docs/25-BUILDING-SOURCE-SAMPLES.md`，与 [25-FAST-CHECKS.md](25-FAST-CHECKS.md) 重复；合并时改到 28 号（26 号为模块盘点，27 号为区域数据计划）。

## 0. 结论摘要

1. **在深圳，现有来源其实只有两个独立的“轮廓观测族”**：OSM（人工标注）和 CLSM（东亚建筑遥感轮廓，Zenodo 8174931）。GloBFP 的深圳轮廓就来自 CLSM（其论文用 Microsoft + Shi et al. 2024，而 Microsoft 明确不含中国），Overture 的非 OSM 部分也标记为同一个 Zenodo DOI。实测：Overture 遥感上游与 GloBFP 在 49,573 个相交轮廓上 IoU 中位 0.998，对称差面积中位 0.18 m²。**两者不能算两次独立核实。**
2. **GlobalBuildingAtlas（GBA）在深圳也不提供新的独立轮廓族**：它的多边形是 OSM、CLSM、Google Open Buildings、Microsoft 和自有 PlanetScope 2019 派生的融合；后两者都不覆盖中国（Google 只覆盖“Global South”，Microsoft 不含中国）。对深圳，GBA 能新增的只有它自有的 2019 年 PlanetScope 派生轮廓和 3 m 高度栅格。**2019 年影像比 GloBFP 的 2020 年还旧，解决不了 2021–2026 年的变化**（例如 2022 年启用的天空之城）。它的高度估计链（2019 PSR）与 GloBFP（2020 多源）是两条独立链，可以当第二意见，但论文的亚洲测试城没有中国城市，不能当深圳现状或精度背书。
3. **这批样本测出来的主要问题不是“源不够多”，而是现有源的质量和规则**：
   - 漏检：城中村 OSM 明显不足（下沙 99 条 vs Overture 遥感补集 216 条 vs GloBFP 633 条；白石洲南区 199/267/658）。
   - 误检：GloBFP 在 8 个样本里 3,724 条轮廓，OSM 只有 875 条；相对 OSM 的“独有”（IoU<0.1）有 2,846 条。影像小片上能看到植被、路面被当成楼体。
   - 轮廓偏差：OSM↔GloBFP 同楼匹配的 IoU 中位 0.62，质心距中位 3.8 m；面积比中位 1.085（OSM 轮廓中位比 GloBFP 大约 8.5%）。
   - 楼高：GloBFP 对超高层严重低估（平安金融中心同楼 164.1 m vs 公开 599.1 m；广电金融中心同楼未匹配，best-IoU 轮廓 74.0 m、附近最高 103.2 m，vs 公开 232.4 m）；OSM height 标签与 GloBFP 的 MAE 56.9 m（n=28），层数×3.2 的 MAE 22.1 m（n=121）。Overture 遥感补集**没有任何楼高/层数字段**。
   - 占道：按“估算车行道半宽 +1 m”口径，GloBFP 有 193 条 share≥0.5、71 条 share≥0.8（其中面积<300 m² 的 149/65 条）；Overture 遥感补集 13/5；OSM 32/11。影像确认 GloBFP FID 41021（155 m²）整块落在深南大道车行道上（share 1.000）。
4. **建议：本批不引入新源（含 GBA）。** 先按 23 号落地“中心线穿越”和“删除 globfp-overlap”两条规则，把 2026-01-25 影像逐案核对做成待核清单；来源记录补上“上游族 + 年代 + 许可”。若未来确实需要新观测，优先走**深圳市官方 2024 年 LOD1.3 / 0.1 m DOM / LiDAR**（依申请），而不是 GBA。GBA 只有在用户接受 CC BY-NC 4.0 且能裁出小区块时，才值得做一次试点。

## 1. 样本与影像覆盖

### 1.1 八个样本街区

| 编号 | 类 | 地点 | bbox（W,S,E,N，WGS84） | 主要内容 | 已登记影像 |
| --- | --- | --- | --- | --- | --- |
| A1 | 福田高层 | 福中三路西段（广电双楼、建行、招行一带） | 114.0415, 22.5420, 114.0475, 22.5480 | 广电金融中心（公开 232.4 m，OSM 230 m/50F）、广电大厦（26F）、建设银行大厦、招商银行深圳分行大厦（特区报业大厦在 bbox 西侧约 450 m 外） | fuzhong 1 张 z18 |
| A2 | 福田高层 | 益田路—福华路（平安金融中心、卓越世纪） | 114.0455, 22.5375, 114.0525, 22.5435 | 平安金融中心（599.1 m/118F）、卓越世纪中心、购物公园 | 无 |
| B1 | 科技园 | 科苑路—深南大道（科技园中区） | 113.9445, 22.5355, 113.9525, 22.5425 | 中检大厦、TCL 大厦、中国科技开发院等 | 无 |
| B2 | 科技园（片区北缘） | 留仙洞总部基地—大疆天空之城 | 113.9350, 22.5775, 113.9420, 22.5828 | 天空之城东塔 213 m/西塔 195 m（2022 启用）、连桥距地 105 m | dji 1 张 z18 |
| C1 | 城中村 | 下沙村 | 114.0345, 22.5270, 114.0425, 22.5340 | 福田最大城中村，6–7 层握手楼（整村约 1000 栋，公开口径） | 无 |
| C2 | 城中村 | 白石洲村南区（深南大道以南） | 113.9575, 22.5360, 113.9655, 22.5425 | 东一坊/西一坊、白石洲综合农贸市场、世界之窗西南角 | 无 |
| D1 | 立交周边 | 深南—香蜜湖立交（OSM 名“深南香蜜立交”） | 114.0165, 22.5340, 114.0285, 22.5420 | 深南大道×香蜜湖路，2023-04 全互通；中国有色大厦 99.8 m | chegongmiao 3 张 z19 |
| D2 | 立交周边 | 北环—香蜜湖立交（北环大道×香蜜湖路×福龙路） | 114.0255, 22.5585, 114.0425, 22.5655 | 1994-12 建成，2007-12 随福龙路增 6 条匝道 | beihuan 5 张 z19 |

命名与范围的三点说明（来自本地公开资料调研，见第 10 节来源）：

- **D1 不是“车公庙立交”本体。** 官方通稿把深南大道×香蜜湖路叫“香蜜湖立交（深南-香蜜立交）”；“车公庙立交（滨河-香蜜立交）”是香蜜湖路南端×滨河大道（兼福强路），在深南以南约 0.7 km。D1 的影像小片落在深南—香蜜节点，所以本文件按影像覆盖命名，避免把两处混为一处。
- **B2 不是科技园中区。** 留仙洞总部基地在科技园片区北侧，用“科技园（片区北缘）”标注，是因为它是唯一有已登记 2026-01-25 影像的高新片区样本；结论不能直接外推到科苑路。
- **C2 不在白石洲旧改拆除范围内。** 绿景沙河五村旧改范围“南临深南大道”，在深南以北；C2 在深南以南，是白石洲村南区。因此 OSM 里的握手楼不能判成“旧改残留”，本文件也不把 C2 当“来源陈旧”的证据。

### 1.2 已登记的 2026-01-25 影像

| 小片 | 瓦片（z/x/y） | 采集 | 分辨率 | 绝对精度 | 覆盖 | 文件 |
| --- | --- | --- | --- | --- | --- | --- |
| fuzhong | 18/214117/114214 | 2026-01-25 | 0.34 m | 8.47 m | 141 m × 141 m | `data/raw/streetscape/freshness-2026/fuzhong-18-214117-114214.jpg` |
| dji | 18/214039/114186 | 2026-01-25 | 0.31 m | 8.47 m | 141 m × 141 m | `data/raw/streetscape/freshness-2026/dji-18-214039-114186.jpg` |
| chegongmiao | 19/428201/228438、19/428199/228439、19/428200/228439 | 2026-01-25 | 0.34 m | 8.47 m | 合计约 210 m × 140 m | `data/raw/streetscape/chegongmiao-20260125/`、`data/raw/streetscape/urban-detail-chegongmiao/` |
| beihuan | 19/428208/228402、19/428214/228401、19/428219/228400、19/428224/228399、19/428228/228399 | 2026-01-25 | 0.34 m | 8.47 m | 沿北环大道的 5 个 69 m × 69 m 小片 | `data/raw/streetscape/beihuan-20260125/` |

影像来源、URL、哈希和元数据见 `data/source/sources.json` 的 `dji-freshness-2026-*`、`fuzhong-freshness-2026-*`、`beihuan-wayback-43291-*`、`chegongmiao-*` 条目，以及 [24 号第 1 节](24-VALIDATED-FAST-DATA.md)。使用边界：只是**局部定点核对材料**，不是全城建筑矢量源或高程测量；8.47 m 绝对精度意味着不能按像素判断小构筑物有无，也不能用单张小片统计整类样本的误检率。

## 2. 来源、版本与上游族

### 2.1 本批用到的来源

| 来源 | 版本/日期 | 提供什么 | 上游族 | 许可 |
| --- | --- | --- | --- | --- |
| OSM | 本地快照 2026-11-08（Geofabrik 广东省） | 轮廓、部分 height/building:levels、名称 | 人工标注（独立观测族） | ODbL |
| Overture Buildings | 2026-10-21.0 | OSM 子集 + 遥感补集；OSM 子集带 height/floors，遥感补集没有 | 两族混合：OSM + CLSM（`datasets` 标 `doi:10.5281/zenodo.8174931`） | 混合（ODbL + 上游许可） |
| 3D-GloBFP | 2020 参考年（ESSD 2024, 16, 5357；数据 Zenodo 11397014） | 轮廓 + 楼高（XGBoost） | 轮廓 = Microsoft + Shi et al. 2024（CLSM）；Microsoft 不含中国，深圳实际来自 CLSM | CC-BY-4.0 |
| CLSM（East Asian buildings） | Zenodo 8174931，发布 2023-07-22 | 东亚建筑轮廓 0.28 B，2020–2022 年影像 | 遥感轮廓（独立观测族的源头） | CC-BY-4.0（23.1 GB 单包） |
| GlobalBuildingAtlas | ESSD 2025, 17, 6647 | 轮廓 + 3 m 高度栅格 + LoD1 | OSM + CLSM + Google Open Buildings + Microsoft + 自有 PlanetScope 2019 派生 | 数据 CC BY-NC 4.0；代码 MIT + Commons Clause |
| 深圳市官方成果 | 2024 年 0.1 m DOM、16 点/m² LiDAR、LOD1.3 | 依申请，未取得 | 官方测绘（最独立、最新） | 依申请，非公开下载 |

### 2.2 上游族判定的证据

1. **Overture 的深圳遥感补集就是 CLSM。** 区域范围内 Overture 建筑 109,569 条，`datasets` 只有两种：`OpenStreetMap` 41,351 条，`doi:10.5281/zenodo.8174931` 68,218 条。Overture 官方 attribution 页也逐字列出该 Zenodo DOI 作为 Buildings 主题来源。Zenodo 8174931 的标题是 “A first high-quality vector data of buildings in East Asian countries…”，作者 Qian Shi、Jiajun Zhu、Zhengyu Liu，2023-07-22 发布，CC-BY-4.0，单文件 23.1 GB。GBA 论文把它称为 CLSM（Shi et al., 2024）。
2. **GloBFP 的深圳轮廓也是 CLSM。** GloBFP 论文（Che et al., 2024）2.1 节写明轮廓来自 Microsoft Building Footprints 和 Shi et al. (2024) 的建筑边界；GBA 论文表 2 明确 Microsoft 覆盖“Global excl. China”。所以中国境内 GloBFP 的轮廓只剩 Shi et al. 2024 这一支。
3. **实测几何一致。** 对全部 68,218 条 Overture 遥感补集与 GloBFP 求最大 IoU：49,573 条有重叠，IoU 中位 0.9982，57.1% 的配对 IoU≥0.95，对称差面积中位 0.18 m²，Hausdorff 中位 0.006 m，最大 205 m（少数跨块/裁切差异）。这已经不是“同族”，而是同一批轮廓被两个产品分别采用。
4. **OSM 与遥感补集几乎不相交。** 68,218 条 Overture 遥感补集中，与 OSM 轮廓 IoU≥0.1 的只有 13 条，≥0.5 的 5 条。Overture 的融合结果里，遥感补集是“OSM 未覆盖/未被吸收”的补集，不是对 OSM 楼的独立复测。**因此 OSM→Overture 遥感补集 matched=0 是数据结构，不能解读为“两源不吻合”。**
5. **GBA 的深圳轮廓同样混合上述上游。** GBA 的 HuggingFace 说明写明 Part II 的多边形来自 Google Open Buildings、CLSM 或自有派生；GBA 论文 3.2 节列出 OSM、Google Open Buildings、Microsoft、CLSM 和自有 GlobalBuildingMap 派生。Google Open Buildings 覆盖“Global South”，Microsoft 不含中国，因此深圳的新增部分只有 GBA 自有的 PlanetScope 2019 派生。

结论：**“OSM + CLSM（GloBFP/Overture 遥感补集）+ GBA”不是三个独立核实，而是“一个人工源 + 一个 2020 年前后的遥感源 + 同一个遥感源的不同再加工”。** 23 号第 3 节要求的“同一上游族不算两次独立核实”，在这批样本上得到了量化确认。

## 3. 方法

### 3.1 交叉来源统计

- 投影：`tools/sz/geo.project`，局部米制坐标（x 东、z 南），面积用局部坐标计算。
- 轮廓过滤：与 bbox 相交、裁切后面积 ≥16 m²（与管线 `MIN_AREA` 一致）；Overture 丢弃 `is_underground`；无效几何 `buffer(0)`。计数按“裁切后轮廓块”，MultiPolygon 拆块。
- 匹配：有向 best-IoU，A 的每个轮廓在相交的 B 中取最大 IoU。`matched` = IoU≥0.5，`ambiguous` = 0.1–0.5，`unique` = 最大 IoU<0.1。**不强制一对一**，同一 B 可被多个 A 选为 best，所以 unique/ambiguous 不是互斥实体数。
- 楼高：OSM `height` 取前导数字（沿用 `buildings._metres` 语义），`building:levels`×3.2 m（管线 `LEVEL_HEIGHT`）。偏差定义为 GloBFP−OSM。
- 占道：复用 `tools/sz/buildings._local_carriageways` 与 `_carriageway_share`（OSM width/lanes/道路等级估算半宽，+1.0 m 缓冲），与管线误识别规则同一口径。**道路宽度是估算值，不是实测边界**，占道结果只作可疑清单。
- 影像核对：把已登记瓦片按 WGS84 瓦片范围精确配准（Web Mercator），叠加 OSM、Overture 遥感补集、GloBFP 和现行共享包轮廓，逐片目视。道路配准用共享包车行道覆盖到影像车辆上做 sanity check（北环小片可见车行道与车辆重合）。**没有下载新影像。**

### 3.2 统计阈值

| 项目 | 取值 |
| --- | --- |
| 最小面积 | 16 m² |
| matched / ambiguous / unique | IoU ≥0.5 / 0.1–0.5 / <0.1 |
| 层高 | 3.2 m |
| 占道缓冲 | 车行道半宽 + 1.0 m |
| 占道阈值 | 0.5、0.8 |
| 误识别面积线 | 300 m²（23 号规则的面积线） |

## 4. 逐类样本结果

### 4.1 各来源轮廓条数（裁切后 ≥16 m²）

| bbox | 地点 | OSM | OV-osm（对照） | OV-auto（遥感补集） | GloBFP |
| --- | --- | ---: | ---: | ---: | ---: |
| A1 | 福中三路 | 47 | 39 | 35 | 132 |
| A2 | 益田路 | 65 | 39 | 37 | 175 |
| B1 | 科苑—深南 | 96 | 72 | 59 | 244 |
| B2 | 留仙洞 | 45 | 29 | 94 | 166 |
| C1 | 下沙 | 99 | 99 | 216 | 633 |
| C2 | 白石洲南区 | 199 | 193 | 267 | 658 |
| D1 | 深南—香蜜湖 | 134 | 117 | 120 | 507 |
| D2 | 北环—香蜜湖 | 190 | 189 | 480 | 1,209 |
| 合计 |  | **875** | **777** | **1,308** | **3,724** |

中位面积（m²）：A1 967/910/75/204；A2 1763/1973/115/286；B1 1456/1608/108/232；B2 1166/2076/116/266；C1 508/508/132/118；C2 142/140/99/99；D1 1147/1147/90/180；D2 620/620/142/121。

### 4.2 匹配结果

全部 8 个 bbox 合并：

| 配对 | matched | A 独有 | B 独有 | ambiguous | IoU 中位 | 质心距中位 | 面积比中位 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| OSM→OV-auto | 0 | 875 | 1,308 | 0 | — | — | — |
| OSM→GloBFP | 204（OSM 的 23.3%） | 154 | 2,846 | 517 | 0.622 | 3.75 m | 1.085 |
| OV-auto→GloBFP | 535 | 239 | 2,463 | 534 | 0.999 | 0.0 m | 1.000 |
| OSM→OV-osm（方法自证） | 799 | 23 | 1 | 53 | 1.000 | 0.0 m | 1.000 |

按类（OSM↔GloBFP matched / OV-auto↔GloBFP matched）：A 22/47，B 31/87，C 40/142，D 111/259。OSM→OV-auto 全类均为 0，原因见 2.2 第 4 条，不是质量结论。

解读：

- **轮廓偏差（同楼）**：OSM 与 GloBFP 能对上的 204 栋，IoU 中位 0.62、质心距 3.8 m、面积比 1.09，属于“大致对上但边界不同”，不是坐标整体偏移。面积比中位 1.085 表示 OSM 轮廓中位比 GloBFP 大约 8.5%。
- **漏检（OSM 侧）**：GloBFP 有、OSM 没有的 2,846 条；城中村和立交周边最集中（C 1,291 条 GloBFP 里只有 99+199=298 条 OSM 轮廓）。其中一部分是棚屋/屋顶附着物，需要影像逐案判断，不能全算真实建筑漏检。
- **“Overture 比 OSM 多”不等于新信息**：OV-auto 与 OSM 不相交，是因为 Overture 已经把 OSM 吸收了；OV-auto 与 GloBFP 同形，说明它只是 CLSM 的一个子集。

### 4.3 楼高对比（OSM ↔ GloBFP，同楼匹配）

| bbox | height n | 均值偏差 m | MAE m | RMSE m | levels×3.2 n | 均值偏差 m | MAE m | RMSE m |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A1 | 1 | −70.9 | 70.9 | 70.9 | 5 | +5.0 | 12.0 | 12.9 |
| A2 | 8 | −48.9 | 56.2 | 60.2 | 12 | −12.3 | 32.4 | 39.3 |
| B1 | 13 | −18.6 | 25.4 | 31.4 | 22 | +10.1 | 18.6 | 24.1 |
| B2 | 2 | −126.5 | 126.5 | 170.0 | 2 | −83.3 | 86.8 | 120.3 |
| C1 | 0 | — | — | — | 10 | −7.3 | 7.3 | 9.1 |
| C2 | 0 | — | — | — | 5 | +3.2 | 3.9 | 5.0 |
| D1 | 4 | −122.5 | 122.5 | 133.2 | 25 | −17.2 | 28.3 | 38.6 |
| D2 | 0 | — | — | — | 40 | −20.3 | 21.2 | 32.6 |
| **全部** | **28** | **−51.7** | **56.9** | **79.2** | **121** | **−11.3** | **22.1** | **34.2** |

偏差 = GloBFP − OSM；只统计两边都有值且 IoU≥0.5 的配对。OSM 的 height 标签本身不是实测，层数×3.2 也只是估算口径，所以上表说明的是“两个估计值之间的差”，不是实测误差。

Overture 楼高/层数覆盖率（裁切后轮廓块）：OV-auto **0/1,308（0%）**；OV-osm 对照 9.1% 有 height、55.6% 有 num_floors（这些值本来就抄自 OSM）。

具名塔楼对照（公开值来自第 10 节来源；GloBFP 取同楼匹配值，未匹配时给“150 m 内最大高度”）：

| 塔楼 | 公开高度 | OSM | GloBFP 同楼匹配 | GloBFP 附近最大 | 现行共享包 |
| --- | --- | --- | --- | --- | --- |
| 平安金融中心 | 599.1 m / 118F | 599.1 m / 117F | 164.1 m（IoU 0.627） | 164.1 m | 599.1 m（osm-height） |
| 广电金融中心 | 232.4 m（承建方 231.7 m）/50F | 230.0 m / 50F | 未匹配（best IoU 0.032） | 103.2 m | 230.0 m（osm-height） |
| 天空之城东塔 | 213 m / 44F | 无总高；翼 180 m/211.6 m | 未匹配（IoU 0.016） | 49.7 m | 211.6/180 m（osm-height 分翼） |
| 天空之城西塔 | 195 m / 40F | 198 m / 44F | 未匹配（IoU 0.086） | 18.8 m | 198 m（osm-height） |
| 天空之城连桥 | 距地 105 m | 117 m / 26F | 无相交 | — | 117 m |
| 市民中心 | 84.7 m（另说 81 m） | 无总高（局部 66 m） | 未匹配（IoU 0.021） | 74.3 m | 主体 15 m（estimate） |
| 中国有色大厦 | 99.8 m / 26F | 26F（层数×3.2 = 83.2 m） | 未匹配（IoU 0.393） | 58.2 m | 83.2 m（osm-levels） |

这张表说明两件事：**GloBFP 不能用于地标或塔楼高度**——平安同楼只有 164.1 m（−72.6%），广电同楼未匹配、best-IoU 轮廓 74.0 m、附近最高 103.2 m，都远低于 232.4 m；天空之城（2022 年启用）在 2020 年产品里根本没有塔楼轮廓。现行共享包在塔楼上主要靠 OSM 标签，只有市民中心主体仍用 `estimate` 15 m，与公开 84.7 m 相差很大（属 23 号“塔楼/裙房未分离”一类问题，本任务不改）。

### 4.4 占道（估算车行道 halfWidth + 1 m）

按类汇总（share≥0.5 / share≥0.8；括号内为面积<300 m² 的条数）：

| 类 | OSM | OV-auto | GloBFP | OV-osm（对照） |
| --- | --- | --- | --- | --- |
| A 福田高层 | 3/1（0/0） | 3/1（3/1） | 19/5（12/4） | 0/0 |
| B 科技园 | 4/2（2/0） | 2/1（2/1） | 48/20（29/17） | 1/0 |
| C 城中村 | 24/8（23/8） | 6/3（5/3） | 77/29（70/29） | 23/8 |
| D 立交周边 | 1/0（0/0） | 2/0（2/0） | 49/17（38/15） | 0/0 |
| **合计** | **32/11（25/8）** | **13/5（12/5）** | **193/71（149/65）** | **24/8** |

最可疑条目（share 降序）：

| 来源 | id | 面积 m² | share | 地点 | 说明 |
| --- | --- | ---: | ---: | --- | --- |
| GloBFP | FID 41021 | 155 | 1.000 | D1 深南大道（114.02284, 22.53886） | 整块落在深南大道车行道/引道上，已由 `sources.json` 的 `chegongmiao-footprint-review-*` 登记为“open-road footprint review” |
| GloBFP | globfp/51713 | 16.8 | 1.000 | C1 下沙 | 与 OV-auto `a86d2357-…` 同形，小棚屋/附着物类 |
| GloBFP | globfp/49048 | 18.0 | 1.000 | C1 下沙 | 与 OV-auto `ccdfa627-…` 同形 |
| OSM | way/674009613 | 16.2 | 1.000 | C2 白石洲南区 | OSM 自己标注的小体量对象压在支路上 |
| OV-auto | a86d2357-dc0c-49b2-9bb8-544bfca008a0 | 16.8 | 1.000 | C1 下沙 | 同一足迹的另一来源重复 |

**不能说“GloBFP 占道 193 条 = 现实中 193 栋楼挡路”**：车行道宽度是估算，share≥0.5 还可能来自骑楼、雨棚、门廊等真实出挑；这份表只用于排待核顺序。

### 4.5 影像核对（2026-01-25，四组小片）

| 小片 | 看到什么 | 判定 |
| --- | --- | --- |
| fuzhong（福中三路西段） | Overture 遥感补集 `f090af25`（94.3 m²，包内 #21871，估算 7.3 m）落在广电金融中心北侧的绿化/树冠带，影像上没有独立屋顶；GloBFP 303 m²/25.3 m（包内 #34235）同样落在树冠带；GloBFP 716 m²/73.3 m（包内 #34229，占道 share 0.60）压在影像中的辅路/铺装带 | **误检/占道候选（3 条）**；受 8.47 m 绝对精度限制，不能断言“现实中完全没有小型构筑物”，但至少不支持按独立楼体渲染 7.3–73 m 的体量 |
| dji（天空之城） | 天空之城 2022 年启用，影像上两塔与连桥清楚；GloBFP 在该片只有零星小轮廓（150 m 内最大 49.7 m），塔楼位置没有同形轮廓 | **2020 年产品的时间性漏检**，不是轮廓算法失败；同时说明“用 GloBFP 补 2021 年后的新楼”不可行 |
| chegongmiao（深南—香蜜湖） | GloBFP FID 41021（155 m²）整块压在深南大道车行道/引道上（share 1.000），影像上该处是路面与绿化带 | **占道误检确认**；与 sources.json 里已登记的“open-road footprint review”一致 |
| beihuan（北环—香蜜湖） | 共享包估算车行道覆盖到影像车辆上，配准正常；OV-auto 红框多落在厂房/住宅屋顶与内院，GloBFP 绿框与 OV-auto 大量重合；少数红框落在内院/巷道 | 只作配准与形态核对，**不对每条下“是/不是楼”的结论**；这一片需要更多影像才能逐案判 |

影像叠图在 `docs/qa/building-source-samples/overlays/`（只留本地），原始截图和页面对应关系见第 9 节。

### 4.6 现行共享包在这八个街区的状态（参照）

解码 `js/sz-city.json.gz`，按同一 bbox 统计，共 **2,498 栋**：

| 街区 | 楼体数 | heightSource 主要构成 | 车辆道路中心线穿越 |
| --- | ---: | --- | ---: |
| A1 福中三路 | 100 | globfp 45、globfp-overlap 16、osm-levels 19、estimate 17、osm-height 3 | 11 |
| A2 益田路 | 116 | globfp 52、osm-height 21、osm-levels 20、estimate 12、globfp-overlap 11 | 13 |
| B1 科苑—深南 | 176 | globfp 65、osm-height 36、estimate 32、osm-levels 26、globfp-overlap 17 | 9 |
| B2 留仙洞 | 176 | globfp 97、estimate 33、osm-height 31、globfp-overlap 15 | 26 |
| C1 下沙 | 389 | globfp 157、globfp-overlap 106、estimate 65、osm-levels 61 | 18 |
| C2 白石洲南区 | 527 | globfp 148、globfp-overlap 143、osm-levels 124、estimate 106、osm-height 6 | 18 |
| D1 深南—香蜜湖 | 320 | globfp 170、osm-levels 63、globfp-overlap 43、estimate 33、osm-height 11 | 20 |
| D2 北环—香蜜湖 | 694 | globfp 240、globfp-overlap 221、osm-levels 72、estimate 161 | 23 |
| **合计** | **2,498** | globfp 974（39.0%）、globfp-overlap 572（22.9%）、estimate 459（18.4%）、osm-levels 385（15.4%）、osm-height 108（4.3%） | **138（5.5%）** |

三点：

- **22.9% 的楼体仍在用 23 号要删掉的 `globfp-overlap` 高度继承**，城中村和北环立交一带最集中（C1 27.2%、C2 27.1%、D2 31.8%）。这批样本可以直接当第 1 步规则的失败/通过样本。
- **138 栋楼与车辆道路中心线相交**（按共享包估算车行道），这是第 1 步“中心线穿越”门槛的直接输入；其中包含 OSM 已标注楼（23 号明确不自动删），需要与影像核对后进待核清单。
- 塔楼高度见 4.3：PAFC、广电、天空之城靠 OSM 标签；市民中心主体仍是 `estimate` 15 m。**本任务不改这些值。**

## 5. 各来源在这批样本上的对比

| 来源 | 覆盖（8 街区） | 误检（候选） | 漏检（候选） | 轮廓偏差 | 楼高 | 占道 | 年代 | 独立？ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OSM | 875 条，城中村明显不足（C1 99 条） | 少（人工标注，误检通常低）；但小体量出挑/雨棚也标 | 多：相对 GloBFP 漏 2,846 条候选；高楼/厂房/村落都有缺口 | 与 GloBFP 同楼 IoU 0.62、质心 3.8 m | height 标签覆盖 26.7%（A）/47.9%（B）/2.2%（C）/4.6%（D）；levels 覆盖 48–69%；本身非实测 | 32/11 | 编辑快照 2026-11-08 | 是（人工族） |
| Overture 遥感补集 | 1,308 条，补 OSM 空白；C1 216、D2 480 | 与 GloBFP 同形；fuzhong 94 m² 落树冠 | 只补 OSM 空白，不解决 2021+ 新楼 | 与 GloBFP IoU 0.999 | **0%** 有高度/层数 | 13/5 | CLSM 2020–2022 | **否**（CLSM） |
| GloBFP | 3,724 条，最密 | 大量小轮廓：2,846 条与 OSM 无对应；影像确认植被/路面被当楼；193 条 share≥0.5 | 2020 后新楼（天空之城）；部分高楼无同形轮廓 | 与 OSM IoU 0.62、OSM 面积比 1.09 | 有高度但偏低：平安 −72.6%；广电同楼未匹配、附近最高 103.2 m；普通楼 MAE 22–57 m（对 OSM 标签） | 193/71 | 2020 | **否**（CLSM 轮廓） |
| GBA | 未下载实测；深圳可比较部分 = CLSM = OV-auto | 取决于其自有派生，本批无法判 | 2019 影像，无法覆盖 2021+ | 自有派生未测 | 3 m 高度栅格，论文亚洲 RMSE 5.9 m（非深圳实测） | 未测 | 2019（自有）/2020–2022（CLSM） | 部分（自有 PSR 是独立观测族，但 2019 更旧） |

一句话：**OSM 缺数量、GloBFP 多噪声且高度偏低、Overture 是 CLSM 子集且没有高度、GBA 是同一熔炉再加一层 2019 年自有派生。** 这批样本没有出现“换一个源就能同时解决误检、漏检、高度和占道”的候选。

## 6. GlobalBuildingAtlas 与其他候选源

### 6.1 GBA 的关键事实（论文/官方说明，访问日期 2026-11-11）

| 项目 | 内容 |
| --- | --- |
| 论文 | Zhu et al., *GlobalBuildingAtlas: an open global and complete dataset of building polygons, heights and LoD1 3D models*, ESSD 17, 6647–6668, 2025，DOI 10.5194/essd-17-6647-2025；数据 mediaTUM DOI 10.14459/2025mp1782307（2025-09-02 发布，生产截止 2025-04-30） |
| 产品 | GBA.Polygon（轮廓）、GBA.Height（高度栅格）、GBA.LoD1（三维模型）；2.75 B 轮廓、2.68 B 带高度、高度完整率 >97% |
| 轮廓上游 | 论文口径：OSM 0.49 B、Google Open Buildings 1.62 B、Microsoft 0.43 B、CLSM（Zenodo 8174931）0.07 B、自有 PlanetScope 派生 0.14 B。深圳实际只有 OSM + CLSM + 自有 PSR（MS 覆盖不含中国大陆，Google Open Buildings 只覆盖非洲/南亚/东南亚/拉美，无中国） |
| 高度 | PlanetScope 地表反射率 2019 年（缺 2019 时用 2018）影像，机器学习单体高度，3 m 栅格 |
| 精度（论文表 3，亚洲） | GBA.LoD1：AP50 27.9、AR50 46.8、N-ratio 1.04、IoU 44.7、RMSEBH 5.9 m、MAEBH 4.6 m、Comp. 0.76；3D-GloBFP 对照：IoU 32.0、RMSEBH 6.0 m、Comp. 0.67。28 个测试城市里亚洲只有日本和歌山等少数城市，**没有中国城市**，所以 5.9 m 不能当深圳或本批样本的实测精度 |
| 许可 | 多边形与 LoD1 数据 CC BY-NC 4.0（禁止商业使用）；代码 MIT + Commons Clause |
| 获取 | HuggingFace `zhu-xlab/GBA.LoD1` 与 `zhu-xlab/GBA.ODbLPolygon`，最小发布单元是 5°×5° 瓦片；高度在 mediaTUM（全量 36 TB、1844 个文件）。官网 web viewer 明确说明不要用 WFS 做批量导出 |
| 深圳所在瓦片 | Part II 多边形 `Polygon/asiaeast/e110_n25_e115_n20.geojson` = 3,684,702,479 字节（3.43 GiB）；LoD1 `LoD1/asiaeast/e110_n25_e115_n20.json` = 574,922,429 字节（548 MiB）；ODbL 子集瓦片 182,997,024 字节（175 MiB）；**高度包 `Height/asiaeast/e110_n25_e115_n20.zip` = 97,955,277,662 字节（约 91.2 GiB，441 个 0.2° GeoTIFF）**。坐标参考 EPSG:3857（README 说明即使标 4326 也按 3857 处理） |

### 6.2 能不能在这批样本上比较 GBA

- **能比较的部分**：GBA 深圳轮廓里的 CLSM 部分就是 Overture 遥感补集/ GloBFP 的同形轮廓，本文件第 4 节已经按同一批样本实测（IoU 0.999、无高度）。也就是说，GBA 的“CLSM 子集”不会比现有数据多任何信息。
- **不能比较的部分**：GBA 自有的 PlanetScope 2019 派生轮廓和 3 m 高度，必须下载 3.43 GiB 多边形瓦片（或 548 MiB LoD1）才能取样；高度包是 91.2 GiB，单块 0.2° GeoTIFF 约 219 MiB，可以用 zip64 偏移做区间读取（研究时只验证了文件头，未完成整块解压）。本任务定位是“只调研、写文档”，不做大文件下载，也不重建数据线，所以**没有对这部分做实测**。任何把 GBA 写成“在本批样本上已验证更好”的说法都不成立。
- **能确定的替代结论**：GBA 的观测年份是 2019（自有派生）或 2020–2022（CLSM），两者都不覆盖 2024–2026；它不能替代 2026-01-25 影像核对，也不能解决 2021 年后新楼（天空之城这类）的漏检。

### 6.3 其他候选

| 候选 | 覆盖深圳？ | 年代 | 轮廓/高度 | 许可 | 结论 |
| --- | --- | --- | --- | --- | --- |
| Google Open Buildings / 2.5D Temporal | 否（“Global South”，不含中国） | 至 2021 / 2016–2023（Sentinel-2，4 m） | 轮廓 + 2.5D 高度 | CC BY 4.0 / ODbL（按版本） | 不适用 |
| Microsoft Building Footprints | 否（coverage 网格不含深圳；官方与 GBA 均标 “Global excl. China”） | Bing 2014–2024 | 轮廓（约 20% 带高度） | CDLA Permissive 2.0（2026 现势；GBA 论文 2025 仍写 ODbL，存在版本口径差） | 不适用 |
| 深圳市 2024 LOD1.3（OBJ，1:10000）、0.1 m DOM、16 点/m² LiDAR；2025 地形图 | 是 | 2024–2025 | 官方测绘轮廓/高度 | 全部“依申请”（广东政务服务网“一般基础测绘成果提供使用”），非公开下载 | **最值得走的方向**：比任何全球产品新、且是官方测量；公开渠道只有天地图·深圳 WMTS 18–20 级影像，没有矢量建筑。需用户/单位申请，具体费用与周期未确认 |
| 商业影像/三维（Esri、Planet、Maxar 等） | 是 | 最新 | 影像/DSM | 商业许可 | 不引入；已登记影像只作核对材料 |
| OSM 后续快照 / 本地补测 | 是 | 2026+ | 人工轮廓/高度 | ODbL | 成本高但可定点补；比换全球产品更可控 |

### 6.4 如果以后要引入新源，先过这几道门槛

1. **独立观测**：不与 OSM/CLSM 同上游；能说清影像/测量年份和传感器。
2. **许可**：允许本项目使用与再分发（NC 许可要先由用户确认项目性质）。
3. **年代**：至少晚于 2024；2019/2020 的产品只能当历史底数，不能当现状。
4. **可取样**：能拿到一个街区级（≤几平方公里）样本做本文件这样的对比，而不是只能下整块 5° 瓦片。
5. **可核对**：能与 2026-01-25 已登记影像或官方测绘成果对上；上游族、年代、精度写进来源记录。

## 7. 建议

### 7.1 本批不引入新源

理由按重要性排序：

1. **在深圳，GBA 的轮廓主要是我们已有的两个族**（OSM + CLSM），新增的自有派生是 2019 年、比 GloBFP 还旧，且无法在不下载 3.43 GiB 多边形瓦片（高度包 91.2 GiB）的前提下取样验证。
2. **许可风险**：CC BY-NC 4.0 与当前仓库的 ODbL/CC-BY 来源不同，是否可用于本项目需要用户明确决定；不能由代理自行引入。
3. **不解决本批测出的问题**：误检（植被/路面）和占道是“轮廓质量 + 过滤规则 + 影像核对”的问题；换一个同样基于 2019/2020 影像的产品不会让它们消失。漏检（2021+ 新楼）只能靠更新的影像或官方测绘。
4. **成本/收益**：GBA 能带来的新信息主要是 3 m 高度栅格（全村/普通楼可能有帮助），但需要 548 MiB–91.2 GiB 下载、坐标/许可/融合处理，收益没有在本批样本上被证明。
5. **23 号的顺序**明确是“先改合并和占道规则，再决定用哪套源”。本批样本支持这个顺序：规则没落地前换源，只会把同一批错误换个来源再引入一次。

### 7.2 现在该做什么

1. **先落 23 号第 1 步**：占道加“道路中心线穿越”门槛；删掉“覆盖一半就继承高度”（`globfp-overlap`）。用本文件的 8 个 bbox 和第 4.6 节的 572 栋 `globfp-overlap`、138 栋中心线穿越做回归样本。
2. **把影像核对做成逐案清单**：本文件第 4.5 节已经给出 3 个 fuzhong 误检候选、1 个 dji 时间性漏检、1 个 chegongmiao 占道确认。后续按同样格式补 C1/C2/D2，结论只写“影像支持/不支持/无法判断”，不写“实测不存在”。
3. **来源记录补三列**：上游族（OSM / CLSM / 其他）、观测年代、许可。Overture 遥感补集和 GloBFP 要标成同一族，不能再当两次核实；高度来源继续用现有 `heightSource` 枚举，但报告里要带“上游族 + 年代”。
4. **高度策略**：GloBFP 高度只用于普通多层/高层（并保留 `estimate` 兜底）；地标和 200 m 以上塔楼不采用 GloBFP 值；市民中心这类“大屋顶 + 塔楼”要按塔楼/裙房分开，不能把 70,687 m² 的主体按 15 m 一整块挤出来（属 23 号塔裙规则，另列任务）。
5. **复核 C2 的定位**：本文件把白石洲南区当“未拆的旧村现状”；如果要研究“旧改前后来源差异”，应另取深南以北 22.5425–22.5500 的 bbox，并且不能用 2019/2020 的产品证明 2026 现状。

### 7.3 什么时候重新评估 GBA

- 用户明确接受 CC BY-NC 4.0；
- 能拿到深圳一个街区级的 GBA 裁片（或作者提供的小样本），而不是整块 5° 瓦片；
- 23 号两条规则已经落地，有干净的对比基线；
- 届时只测“自有派生轮廓 + 3 m 高度”能否改善本批样本的漏检/高度，并同样用 2026-01-25 影像核对。

### 7.4 不建议的做法

- 不要把 Overture 遥感补集当“第二来源独立核实”，也不要拿 OSM→OV-auto matched=0 证明“两源不吻合”。
- 不要用 GBA 的亚洲汇总精度（IoU 44.7、RMSE 5.9 m）写成深圳或本批样本的实测精度。
- 不要因为 GloBFP 轮廓多就全量替换 OSM；也不要用 2019/2020 影像否定 2026 年的现状。
- 不要为了“换源”重建共享包；本任务没有数据线。

## 8. 未完成与局限

- **GBA 未下载实测**：3.43 GiB 多边形瓦片 / 548 MiB LoD1 / 91.2 GiB 高度包超出本任务范围；GBA 的“自有派生”部分在本批样本上没有数值结论。
- **影像只有 4 组小片**（fuzhong、dji、chegongmiao、beihuan），C1/C2/A2/B1 没有已登记影像；小片只有 141 m/69 m 见方，不能统计整类误检率。
- **8.47 m 绝对精度**：不能按像素判定小构筑物；本文件的“误检候选”都保留“无法 100% 排除小型构筑物”的余地。
- **OSM height/levels 不是实测**：4.3 的偏差是“两个估计值之差”，不是测绘误差。
- **占道口径是估算车行道**：道路宽度由 OSM width/lanes/等级推算，share 只能排待核顺序；OSM 轮廓含 building:part 与父轮廓，可能重复覆盖。
- **匹配是有向 best-IoU、不强制一对一**：unique/ambiguous 不是互斥实体数；bbox 边缘会切断轮廓，边缘指标偏小。
- **D1 命名**：取深南—香蜜湖节点，与官方“车公庙立交”本体相距约 0.7 km；两者同属香蜜湖路改善工程，不能混为一处。
- **C2 范围**：白石洲南区不在绿景旧改拆除范围，本文件没有把 C2 当“旧改残留”的证据；若要研究旧改变化，需另取深南以北样本。
- **B2 范围**：留仙洞总部基地不等于科技园中区，结论不能直接外推到科苑路。
- 没有改代码、没有重建 `js/sz-city.json.gz` / `js/sz-city.szc.gz`；本任务不是数据线。

## 9. 复现与本地产物

自动统计（只读，固定输入，无网络）：

```sh
.venv/bin/python docs/qa/building-source-samples/scripts/analyze_sources.py
.venv/bin/python docs/qa/building-source-samples/scripts/verify_reproducible.py
```

产物（`docs/qa/` 已在 `.gitignore`，只留本地，不进 Git）：

| 路径 | 内容 |
| --- | --- |
| `docs/qa/building-source-samples/metrics/metrics.json` | 全部结构化结果（bbox、阈值、逐对指标、占道 top20、塔楼、影像小片清单、输入哈希、耗时） |
| `docs/qa/building-source-samples/metrics/summary.md` | 中文摘要与口径 |
| `docs/qa/building-source-samples/metrics/self-check.json` | 复现校验（两遍一致、配平、IoU/面积比不变量） |
| `docs/qa/building-source-samples/metrics/package-crossings.json` | 现行共享包车辆道路中心线穿越明细 |
| `docs/qa/building-source-samples/scripts/analyze_sources.py` | 统计脚本 |
| `docs/qa/building-source-samples/scripts/verify_reproducible.py` | 复现校验脚本 |
| `docs/qa/building-source-samples/scripts/make_overlays.py` | 影像叠图生成脚本 |
| `docs/qa/building-source-samples/overlays/` | 四组叠图页面与截图（fuzhong/dji/chegongmiao/beihuan） |
| `docs/qa/building-source-samples/research/shenzhen-local-facts.md` | 本地公开事实与 76 条来源（S1–S76） |
| `docs/qa/building-source-samples/research/global-building-atlas.md` | GBA 与候选源调研笔记（R1–R21） |
| `docs/qa/building-source-samples/research/research-sources.json`、`global-building-atlas-sources.json` | 来源清单（标题/URL/日期/类型） |

测试基线（2026-11-11，开工时实际运行）：`SZ_THREE_PACKAGE_DIR=MAIN/.agents/three-0.187.0 node --test tests/*.test.cjs` **480 项通过、0 失败、0 跳过**；`MAIN/.venv/bin/python -m unittest discover -s tools/sz/tests` **105 项通过**。本任务只新增文档，不改代码/数据，结束时复跑同数量。

## 10. 来源

外部来源（访问日期均为 2026-11-11）：

- GBA 论文：Zhu et al., ESSD 17, 6647–6668, 2025，<https://essd.copernicus.org/articles/17/6647/2025/>（DOI 10.5194/essd-17-6647-2025；预印本 arXiv:2506.04106）；GBA 代码与许可：<https://github.com/zhu-xlab/GlobalBuildingAtlas>；数据（Part II）：<https://huggingface.co/datasets/zhu-xlab/GBA.LoD1>；Part I：<https://huggingface.co/datasets/zhu-xlab/GBA.ODbLPolygon>；高度数据：<https://mediatum.ub.tum.de/1782307>（DOI 10.14459/2025mp1782307）。
- CLSM（East Asian buildings）：<https://zenodo.org/records/8174931>（DOI 10.5281/zenodo.8174931，CC-BY-4.0，23.1 GB）。
- 3D-GloBFP 论文：Che et al., ESSD 16, 5357–5374, 2024，<https://essd.copernicus.org/articles/16/5357/2024/>；亚洲数据：<https://zenodo.org/records/11397014>（CC-BY-4.0）。
- Overture 版本日历：<https://docs.overturemaps.org/release-calendar/>；Building 主题署名（逐条列出 Zenodo 8174931）：<https://docs.overturemaps.org/attribution/>；本地 2026-10-21.0 快照的 `datasets` = `doi:10.5281/zenodo.8174931` / `OpenStreetMap`。
- 深圳 2026 版公开成果目录（2024 LOD1.3 / 0.1 m DOM / 16 点每平米 LiDAR）：<https://pnr.sz.gov.cn/xxgk/gggs/content/post_12759228.html>。
- Google Open Buildings（Global South）：<https://sites.research.google/open-buildings/>；2.5D Temporal：<https://sites.research.google/gr/open-buildings/temporal/>。
- Microsoft Building Footprints：<https://github.com/microsoft/GlobalMLBuildingFootprints>（不含中国，见 GBA 论文表 2）。

本地事实与楼高（详细出处见 `docs/qa/building-source-samples/research/shenzhen-local-facts.md` 的 S1–S76；以下只列本文件直接引用的）：

- 平安金融中心 599.1 m/118F（CTBUH、维基）；大疆天空之城东 213 m/44F、西 195 m/40F、连桥距地 105 m（华阳国际、ArchDaily 中文）；市民中心 84.7 m（百科多源一致，缺官方原文）；广电金融中心 232.4 m（建筑师）/231.7 m（承建方）/50F（设计方、承建方）；中国有色大厦 99.8 m/26F（百科、商业资料）。
- 深南—香蜜湖立交 2022-07-11、2023-04-25 分批开通、全互通（深圳市交通运输局 2023-04-25 通稿、深圳商报）；车公庙立交（滨河—香蜜湖）2022-04-02 具备全部规划转向（深圳商报）；北环—香蜜湖立交 1993-03 动工、1994-12 完工、2007-12 增 6 条匝道（交通百科/维基）。
- 白石洲旧改范围“南临深南大道”（南山区城市更新和土地整备局公示转载）、2021-01-25 分四期、2026-02-04 一期竣工交付（绿景中国公告转述）；下沙村约 1000 栋 6–7 层握手楼（百度百科）、超十万人口（南方都市报 2022）；《深圳城中村楼栋字典 2022》4–8 层占 54%、面积 58.4%（中国（深圳）综合开发研究院，2023-09）。

仓库内依据：[23 号](23-BUILDING-AND-STREET-PLAN.md) 第 3、8 节；[24 号](24-VALIDATED-FAST-DATA.md) 第 1、2 节；[25-FAST-CHECKS](25-FAST-CHECKS.md)；`data/source/sources.json`；`data/source/build-report.json`；`tools/sz/buildings.py`（`MIN_AREA`、`LEVEL_HEIGHT`、`filter_misidentified_footprints`、`_local_carriageways`、`_carriageway_share`）。
