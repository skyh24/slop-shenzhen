# 纽约与武汉：建筑数据来源核查

核查日期：2026-11-13。范围为 Slop New York 与 Slop Wuhan 的实际建筑生成链路，不是两座城市所有可下载数据的清单。纽约参考本地 `536a907c605964421563f12f15c5e00d735fc94f` 与上游 `2813185434ec4f11e105fff7fb87665fab81b558`，武汉参考 `7a62402a81f3cb50b38e664323f2cf7e4e132eac`。本轮只读源码、已有数据与官方资料，没有重建数据、修改运行代码或做现场精度验收。

## 1. 核心结论

| 层次 | 纽约 | 武汉 |
| --- | --- | --- |
| 普通建筑轮廓 | 曼哈顿主要来自 NYC OTI 官方 Building Footprints | OSM 优先，Overture 补缺；实际 Overture 上游主要是东亚建筑数据 |
| 普通建筑高度 | 同一官方数据集的 `height_roof`，相对地面、英尺转米 | 少量源高度/层数、逐栋资料，大量 GloBFP 模型估高，剩余按规则估高 |
| 年代、用途 | 使用建成年份选外观；该导入器没有用途数据 | OSM 标签、楼内 POI、逐栋资料；土地用途可作估计，仍有未知 |
| 地标 | OSM 地标轮廓加人工程序模型/参数 | OSM 绑定对象加政府、建筑机构等逐栋资料，程序化简模 |
| 外墙、窗户、屋顶设备 | 程序化表现 | 程序化表现；少量身份绑定外观配置 |
| 覆盖边界 | 不能将曼哈顿数据推广成全纽约逐栋实景；外围包含程序楼群 | 本版是两江三镇核心区 48.412 平方公里，不是武汉全市 |

两边都不是直接加载全城照片贴图或完整实测三维模型。真实轮廓、源高度、模型估高、外观设计是不同层次，应分别判断。

## 2. 纽约：官方建筑数据为主体

### 2.1 曼哈顿普通楼

直接数据源是 [NYC Open Data 的 BUILDING / Building Footprints](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue/about_data)，发布部门为纽约市 Office of Technology and Innovation（OTI，原 DOITT）。实际生成器访问该数据集的 Socrata API。

生成器读取 `the_geom`、`height_roof`、`bin`、`feature_code`、`construction_year`，通过 BIN 首位筛出曼哈顿，再做岛内空间筛选。楼高按英尺乘 0.3048 转米；缺失、无效或非正高度的记录被排除。部分停车、雨棚、储罐、占位、临时构筑物及连桥也被过滤。轮廓简化和量化为约 0.5 米，楼高取整米，年代按十年存储，未知年代为 0。[生成器](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/tools/build-buildings.py)

现有生成文件记录 **37,353 条建筑记录**及原始快照 SHA-256；这是筛选后的曼哈顿数据量，不是全纽约楼数，也不是最终网格数。地标保留区还会排除部分普通楼，改由专用模型表现。头部没有明确快照采集日期，不能把今天官方 API 的更新日期当成项目数据日期。[生成数据头部](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/building-geodata.js#L1-L5) · [地标保留区](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L242-L274)

官方数据本身的上游包括年度航空影像、纽约建筑部门及其他市政记录、EagleView 斜视影像、Cyclomedia 全景照片。`HEIGHT_ROOF` 表示高出建筑地面基准的屋顶高度，不是海拔；不同记录可由摄影测量、图纸或人工整理产生。官方来源不等于每条数据都具有相同测量精度。Slop 使用整理后的数据，没有证据表明它直接导入这些影像作为外墙材质。[官方元数据](https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_BuildingFootprints.md)

### 2.2 地标与外围不是同一套来源

- 地标轮廓另从 `osm_landmarks.json` 读取 OSM 的命名轮廓、包围盒和可用高度，进入 `LANDMARK_SITES`。专用建筑代码再构造塔身、退台、尖顶等。不能把它们全归入 NYC 官方普通楼数据，也不能把人工尺寸全部称为实测。[地标数据导入](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/tools/build-geodata.mjs#L160-L173) · [地标模型](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js)
- 曼哈顿外的背景街区含大量程序化楼群：按人工设定的街区、土地用途、楼高范围、地块尺寸和固定种子生成。少数天际线塔楼在 `SIGNATURE_TOWERS` 中单独配置坐标、高度及体量。它们不是从同一份全纽约逐栋足迹表直接还原。[外围楼群模块](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/boroughs.js#L1496-L1608)
- 普通楼的材质主要按年代与固定随机值选择；代码明确说明源数据没有建筑用途，底层商铺另按表现规则选择。窗户、雨棚、消防梯、水箱等不能当成每栋楼的实际调查结果。[外观选择](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L343-L380)

未发现该普通建筑导入器单独读取 PLUTO。城市道路、边界、公园等 GIS 数据虽然参与场景生成，也不能全部列为建筑轮廓或高度来源。

## 3. 武汉：多个来源合并，轮廓和高度分开处理

正式入口走 `js/runtime/main.js`，读取 `wuhan-geodata.bin.gz`。构建链路是源数据 → `tools/build-wuhan.py` → `public/data/city.json` → `tools/build-runtime.py` → runtime 包；旧 manifest/tiles 和遗留其他城市工具不代表当前建筑来源。[正式入口](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/index.html) · [构建命令](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/package.json)

### 3.1 实际接入的来源

| 来源 | 固定版本或年代 | 本版实际用途与数量 |
| --- | --- | --- |
| OpenStreetMap，经 Geofabrik 湖北 PBF | 快照时间 `2026-10-27T21:23:59Z` | 优先轮廓、名称、标签、源高度、层数和建筑部件；最终普通楼中 3,143 条轮廓来自该导入 |
| Overture Maps Buildings | `2026-10-21.0` | 原始核心区提取 24,719 条；过滤去重后保留 20,318 条普通楼轮廓 |
| 东亚建筑数据集，Shi 等 | Zenodo v1，发布于 2023-07-22 | 经 Overture 间接使用，最终 20,302 条 Overture 楼记录标记此来源；另 16 条标记 OSM。发布日期不等于逐栋影像采集日期 |
| 3D-GloBFP | 参考年 2020；论文 2024；项目记录 Figshare v3 湖北数据块 | 裁剪 34,710 个候选，匹配后只补缺失高度，不追加足迹；最终 20,123 条建筑使用该模型高度 |
| 逐栋建筑资料、遗产资料 | 各条独立 URL 与日期 | 补身份、建筑总高、层数、用途，辅助外观和体量；包括政府资料、文史资料、建筑机构/设计机构及项目发布资料 |
| 显示估算规则 | `hankou-display-v1` | 剩余 2,764 条按类别、面积和固定种子估层高；不是外部实测数据 |

来源入口：[Geofabrik 湖北](https://download.geofabrik.de/asia/china/hubei.html)、[Overture 官方说明](https://docs.overturemaps.org/guides/buildings/)、[东亚建筑原始数据](https://zenodo.org/records/8174931)、[GloBFP 论文](https://essd.copernicus.org/articles/16/5357/2024/)。项目版本证据：[Overture 清单](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/data/source/overture-core-source.json)、[GloBFP 清单](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/data/source/globfp-source.json)、[普通楼成品](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/public/data/city.json)。本轮读取了前述官方说明；Figshare 版本/文件号依据仓库固定清单，未单独验证下载内容。

Overture 是聚合源；其全球来源包括多种开放数据，但本版武汉应以记录的 `sourceDatasets` 为准。不能因 Overture 全球包含微软/Google，就说武汉楼群主要来自它们。GloBFP 高度由遥感和机器学习估计，不能称为激光扫描或逐栋实测高度。轮廓数据与 GloBFP 的上游还可能共享数据血缘，匹配成功不等于独立精度验证。[Overture 来源说明](https://docs.overturemaps.org/guides/buildings/) · [GloBFP 方法与输入](https://essd.copernicus.org/articles/16/5357/2024/)

### 3.2 怎样合并

1. OSM 先入场；高度优先读取 `height` / `building:height`，否则楼层数乘 3.2 米。OSM 标签高度本身也不自动证明实测。
2. Overture 补足迹；与 OSM 的交叠面积超过两者较小面积的 25% 时排除。还过滤地下楼、过小轮廓、明显落水及道路/地标冲突。
3. Overture 同样支持 `height` 或 `num_floors × 3.2`；但本版最终没有 `Overture:height`，仅 3 条使用 `Overture:floors`。
4. 逐栋资料可覆盖已有值，并保留原高度信息；文献总高、层数换算和照片估计分别标记。
5. GloBFP 只给仍缺高的对象补高。匹配要求 IoU≥0.65、面积比≥0.7、中心距受限，并拒绝相近的歧义候选。
6. 再处理 OSM 部件和审核过的开口建筑，保留裙房、塔楼及通道的独立体量。剩余缺高在 runtime 构建期估算，浏览器加载已打包结果。

依据：[足迹合并与补高](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/build-wuhan.py#L122-L190)、[属性与文献覆盖](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/building_attributes.py#L11-L108)、[高度匹配](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/core_geometry.py#L13-L35)、[显示估高及打包](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/build-runtime.py#L25-L97)。

### 3.3 当前包的高度来源分布

| 最终高度来源 | 普通建筑记录数 |
| --- | ---: |
| GloBFP 模型估高 | 20,123 |
| 通用规则显示估高 | 2,764 |
| OSM 楼层换算 | 473 |
| OSM 部件最高值 | 32 |
| OSM 高度标签 | 17 |
| 文献建筑总高 / 近似总高 | 16 / 1 |
| 文献层数换算 | 6 |
| 照片包络 / 开口建筑包络估计 | 7 / 19 |
| Overture 楼层换算 | 3 |
| 合计 | 23,461 |

以上约 85.8% 使用 GloBFP、约 11.8% 使用通用规则估高。23,461 条普通建筑拆成 23,819 个渲染部件，另有 5 个独立地标；部件不能当楼数。数字来自当前成品与审计，不沿用旧扩区文档的中间数字。[runtime 审计](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/public/data/runtime-audit.json)

### 3.4 地标和外观的真实性边界

江汉关、黄鹤楼、龟山电视塔的高度字段关联政府页面；晴川阁和红楼的 18 米则明确标记为视觉估算。普通楼中还有逐栋资料和 22 个身份绑定遗产外观对象，这些不是新增 22 栋楼。资料可能只支持总高或楼层，不能自动支持每个退台、窗户和屋顶尺寸。[地标定义](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/build-wuhan.py#L99-L117)、[逐栋资料](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/data/source/building-evidence.json)、[遗产配置](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/config/hankou-heritage.json)

普通楼按足迹生成体量，外墙、窗户、屋顶采用程序化规则。用途可来自建筑标签、内部 POI 或明确资料；仅由土地用途推断时保留估计标记。地形高程数据只解决地面和山体，不是普通建筑楼高来源。GABLE、CNBH、Overture Places 在该版扩区说明中列为未接入，不能算现有来源。[分类规则](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/building_attributes.py#L28-L48) · [扩区说明](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/docs/CORE_EXPANSION.md)

## 4. 对深圳统一方案的启示

这些是后续规划建议，本轮未实施：

- 轮廓、高度、用途、外观分别记录来源；同一栋楼可能是 OSM 轮廓、GloBFP 估高、未知用途、通用住宅外观，不能只留一个含糊的 `source`。
- 源值与显示值分开，保留 `heightSource`、参考年、版本、对象 ID 和证据；建筑总高、屋顶离地高、屋顶海拔不得混用。
- 普通外墙、窗户、阳台及设备继续共享模板；资料不足时允许统一表现，但不要把表现选择写回事实层。
- 地标只覆盖有证据的参数，保留通用材质、部件与加载逻辑；总高可靠不代表整栋体量已核实。
- 数据融合、去重、稳定布局尽量在构建期完成。运行时消费统一建筑记录及少量特殊部件，不必每次加载重新辨认数据源或重新匹配高度。

纽约可借鉴的是有明确来源的轮廓/高度加通用外观；武汉可借鉴的是多源覆盖与估计标记。深圳仍需验证自己的覆盖、匹配误差与地标资料，不能直接继承两者的精度结论。
