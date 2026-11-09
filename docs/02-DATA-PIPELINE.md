# 02 数据管线

## 原则

- 原始快照锁定版本，记录下载地址、日期和 SHA-256，原始大文件不进 Git
- 运行时不联网拉数据，浏览器只读生成好的压缩包
- 每栋楼的高度都带来源标签，推断值不冒充实测值
- 生成文件不手改；要改就改规则或 `data/source/` 下的人工核对表，再重新生成

## 数据源

| 数据 | 来源 | 版本 | 用途 |
| --- | --- | --- | --- |
| OpenStreetMap | Geofabrik 广东切片 `guangdong-latest.osm.pbf` | 下载时的快照，时间戳和哈希见 `data/source/sources.json` | 道路、海岸线、水系、公园、绿地、地铁出入口、树点、地名、一部分建筑 |
| Overture Maps Buildings | `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings` | `2026-10-21.0`（下载时的最新版） | 补全建筑轮廓，自带部分高度和层数 |
| 3D-GloBFP | figshare 文章 28904453（第 IX 部分），网格 `2265`、`2269`（下载地址见 `sources.json`） | 参考年份 2020 | 缺高度时的遥感估算高度 |
| Terrain Tiles | `elevation-tiles-prod/skadi/N22/N22E113.hgt.gz`、`N22E114.hgt.gz` | Mapzen / Tilezen，底图来自 USGS SRTM | 莲花山、塘朗山等山体起伏 |
| 地标高度 | `data/source/landmarks.json`，人工核对 | 每条附出处 | 地标总高 |

### APEC 时间点

用户要求“APEC 前后最新的数据”。已核实（2026-11-09）：

- 第三十三次领导人非正式会议：**2026 年 11 月 18 日至 19 日**，深圳；工商领导人峰会 11 月 17 日至 18 日
- 主会场：**深圳国际交流中心**，福田区香蜜湖（OSM way `1080860977`，`amenity=conference_centre`，中心约 `22.5473N, 114.0241E`），在一期范围内
- 出处：外交部与新华社公告（日期、城市），深圳市政府外事办 2026-09-23《深圳APEC氛围持续升温》（道旗、公交涂装），多家媒体报道会场；官方领导人公告只写城市，没写具体建筑

快照策略：

1. **会前快照（已锁定）**：Geofabrik `guangdong-261108.osm.pbf`（2026-11-08）、Overture `2026-10-21.0`，哈希见 `data/source/sources.json`。M1 到 M9 都用这一套
2. **会后快照（见 [TASKS.md](TASKS.md) 的 M1 数据）**：11 月 20 日之后重新下载 Geofabrik，跑同一条管线，把建筑、道路、地名数量的差异写进 `data/source/build-report.json`。有实质变化（新开道路、竣工楼、香蜜湖片区改造）才切换
3. **会期氛围**：深南大道、滨河大道、滨海大道的双语道旗，公交 APEC 主题涂装，平安金融中心、京基100、华润大厦的 APEC 主题灯光秀，都做成可开关的“APEC 周”主题（见 [06-STREETSCAPE.md](06-STREETSCAPE.md)），默认开启

## 处理步骤

```mermaid
flowchart TD
  fetch[fetch.py_download_and_hash] --> osm[import_osm.py]
  osm --> roads[roads.py_graph_and_surfaces]
  osm --> land[land.py_coast_water_parks]
  osm --> bosm[OSM_buildings]
  ov[Overture_jsonl] --> merge[buildings.py_merge_dedupe]
  bosm --> merge
  gb[GloBFP_shapefiles] --> merge
  dem[HGT_tiles] --> terrain[terrain.py_masked_hills]
  roads --> blocks[land_minus_roads_equals_blocks]
  land --> blocks
  merge --> pack[pack.py_SZB1]
  roads --> geo[sz-geodata.json.gz]
  blocks --> geo
  terrain --> geo
  land --> geo
  lmk[landmarks.json] --> merge
```

### 1. 坐标

原点 `114.0545E, 22.5463N`（市民中心主楼）。用和纽约 `geo-base.mjs`、武汉 `build-wuhan.py` 相同的椭球局部切平面公式：

```
KX = (π/180) · N(φ0) · cos φ0
KY = (π/180) · M(φ0)
x =  (lon − lon0) · KX
z = −(lat − lat0) · KY
```

### 2. 道路

- 可驾驶道路：`motorway`（地面段）、`trunk`、`primary`、`secondary`、`tertiary`、`unclassified`、`residential`、`living_street` 和各级 `_link`
- 不进可驾驶路网：`service`、`footway`、`cycleway`、`path`、`steps`，以及 `bridge=yes`、`tunnel=yes`、`layer≠0` 的段（一期高架和隧道只做外观）
- 宽度：OSM `width`；没有就按 `lanes × 3.25 m`；再没有就按等级估算（trunk 22、primary 16、secondary 12、tertiary 9、residential 7、link 6 米）
- 输出纽约 `roadGraph` 格式：`nodes [x, z, ...]`、`links [a, b, 名称序号, 宽度, 车道数, 方向, 内部形状点]`、`names`
- 路口：度数大于等于 3、且至少两条主次干道相交的节点设信号灯

### 3. 陆地、海、街区

- 海：OSM `natural=coastline` 闭合成陆地多边形，范围框内其余为海
- 内陆水体：`natural=water`、`waterway=riverbank`
- 公园和绿地：`leisure=park`、`landuse=grass`、`natural=wood` 等
- 路面：可驾驶道路中心线按宽度缓冲后合并
- 街区（人行道抬高面）：陆地减去路面、减去水体，抬高 0.18 米
- 全部按 500 米网格裁切，方便剔除

### 4. 建筑合并与楼高

1. 读 OSM 建筑（保留 `height`、`building:levels`、`building`、`name`）
2. 读 Overture，和 OSM 轮廓重叠超过 25% 的丢掉
3. 楼高按顺序取第一个可用值：
   1. `landmarks.json` 里核实过的值（只对地标）
   2. OSM `height`
   3. OSM `building:levels × 3.2 m`
   4. Overture `height`
   5. Overture `num_floors × 3.2 m`
   6. 3D-GloBFP：交并比至少 0.6、面积比至少 0.65、中心距不超过 12 米，且没有相近的第二候选
   7. 按用途和占地估算，标 `estimate`
4. 每栋楼记录 `heightSource`、`category`、`facade`
5. 面积小于 16 平方米或大半在水里的轮廓丢掉

### 5. 地形

HGT 取样到 25 米网格，3×3 中值滤波去掉楼顶回波，只在声明的山体掩膜（莲花山、塘朗山、笔架山等公园多边形）里抬高地面，边缘羽化到零。路面和建筑不压到山上。

### 6. 打包

- `js/sz-geodata.json.gz`：路网、陆地、海、街区、公园、山体、地标、地名、树点、地铁出入口
- `js/sz-buildings.bin.gz`：`SZB1` 格式，沿用纽约 `NYB1` 的元数据流加 X、Z 坐标差分流（zigzag varint），每栋多存用途、立面类型、高度来源三个字节
- 浏览器读到字节后看 gzip 魔数判断是否还需解压，兼容服务器自动解压的情况

## 许可

- OSM 及由其派生的合并数据：ODbL 1.0
- Overture Buildings：ODbL（保留每条的上游数据集标签）
- 3D-GloBFP：CC BY 4.0，引用 Che, Y. et al., 2024, ESSD 16, 5357–5374
- Terrain Tiles：Mapzen / Tilezen，地形数据来自 USGS
- 代码：MIT，沿用纽约原版
