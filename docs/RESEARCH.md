# 前期调研

整理日期：2026-11-09。本文记录动手前查过什么、结论是什么、出处在哪里。结论变了就在这里改，并在 [HANDOFF.md](HANDOFF.md) 的变更记录里写一行。

## 1. 参考仓库

`ref/` 下三个仓库只读，不在里面改。

| 仓库 | 作用 | 关键结论 |
| --- | --- | --- |
| `ref/slop-newyork`（mrdoob，MIT） | 代码底座 | three.js `0.187.0` 的 WebGPURenderer 加 TSL，`index.html` 里的 import map 从 jsDelivr 取 three，不打包；`js/` 约 3.4 万行；`node --test` 跑测试 |
| `ref/slop-wuhan`（LightYearZh） | 中国城市数据管线和流程经验 | OSM 加 Overture 加 3D-GloBFP 加 Terrain Tiles 的楼高融合；地标按 OSM 身份绑定；出租车接单；“数据有、生成了、加进场景、看得见、碰撞相符”逐级验收 |
| `ref/slop-cities`（zz85） | 社区城市索引 | 只作参考，不取代码 |

### 纽约底座能直接用的部分

- `road-network.js` 有一条中心线道路分支：方格网大道和横街列表都为空时只读 `GEO.roadGraph`，照样生成车道、路口、转向，并只保留最大强连通部分。深圳路网全部走这条分支。
- 和曼哈顿方格网绑死的只有 `city-config.js`、`city-grid.js`、`boroughs.js`；`traffic.js`、`controllers.js`、`buildings.js` 通过少数函数和数据接口取数据。模块矩阵见 [01-ARCHITECTURE.md](01-ARCHITECTURE.md)。
- 建筑数据格式 `NYB1`（varint、坐标差分、gzip）可以扩成 `SZB1`。

### 武汉留下的教训（摘自 `ref/slop-wuhan/docs/PROJECT_HISTORY.md`、`SURFACE_FIXES.md`、`GROUND_CONNECTIONS.md`、`CITY_WORKFLOW.md`）

| 武汉遇到的现象 | 原因 | 深圳要提前做的 |
| --- | --- | --- |
| 建筑稀疏、方盒子多 | 开放轮廓不足，用矩形代替真实多边形 | 一开始就合并 OSM 和 Overture，保留真实多边形和内院 |
| 模块在仓库里却没生效 | 输入字段、生成入口、场景挂接有一环没接上 | 每个功能都按“源数据→转换→生成→挂进场景→画面”逐级确认 |
| 水面长草、车在地底开 | 地形整块铺满没裁水面；显示用的三角面和高度查询不是同一套 | 地形只在山体掩膜内抬高；渲染和接触共用同一组三角面 |
| 桥中间掉下去 | 两条单向车道各自建桥面，中间没有支撑 | 一期不做可驾驶高架；二期按完整桥宽建桥面 |
| 路边有看不见的墙 | 街具摆放时的避让半径被直接当成碰撞范围 | 摆放避让和碰撞分开定义 |
| 门洞、骑楼被挤成实心盒子 | 二维轮廓被当成全高实体 | 深圳的架空层、连桥（腾讯、大疆）按分段实体建 |
| 楼看着不对 | 高度低估、塔楼和裙房没分开、轮廓年代不一致 | 楼高逐栋记来源；塔裙分开；地标用身份绑定 |
| 截图正常、实际不能玩 | 测试状态、固定镜头、隐藏界面没恢复 | 验收后恢复成普通游玩页面 |

## 2. 数据源（已下载，哈希见 `data/source/sources.json`）

| 数据 | 版本 | 大小 | 说明 |
| --- | --- | --- | --- |
| Geofabrik 广东 OSM | `guangdong-261108.osm.pbf`，最后修改 2026-11-08 | 175 MB | APEC 会前快照 |
| Overture Buildings | `2026-10-21.0` | 45 MB JSONL，109,569 栋 | 按范围框 `113.88–114.135E, 22.455–22.60N` 用 duckdb 截取 |
| 3D-GloBFP | 网格 `2265`、`2269` | 171 MB、71 MB | Shapefile（`.shp/.dbf`），读取需要 `pyshp` |
| Terrain Tiles | `N22E113`、`N22E114` | 各约 7 MB | SRTM HGT |

本机已有的工具：`.venv` 里装了 `osmium`、`shapely`、`numpy`；系统有 `duckdb`。没有 `ogr2ogr`，不要依赖 GDAL。

## 3. APEC 2026

| 事项 | 结论 | 出处 |
| --- | --- | --- |
| 领导人非正式会议 | 2026 年 11 月 18 日至 19 日，深圳 | [中国外交](https://cn.chinadiplomacy.org.cn/2025-12/12/content_118225703.shtml)、[Wikipedia](https://en.wikipedia.org/wiki/APEC_China_2026) |
| 工商领导人峰会 | 11 月 17 日至 18 日 | [Shenzhen Decoded](https://www.shenzhendecoded.com/en/guides/apec-2026-shenzhen) |
| 主会场 | 深圳国际交流中心，福田香蜜湖；官方领导人公告只写城市 | [深圳政府在线专题](https://www.sz.gov.cn/en_szgov/news/infocus/APEC2026)、多家媒体 |
| 主题 | “建设亚太共同体，促进共同繁荣” | 外交部 |
| 城市氛围 | 深南大道、滨河大道、滨海大道双语道旗；公交主题涂装（经过市民中心、会展中心、华强北）；平安、京基100、华润大厦灯光秀 | [深圳外事办 2026-09-23](https://fao.sz.gov.cn/xxgk/zyxw/content/post_1975477.html)、[香港01](https://www.hk01.com/01%E8%AB%96%E5%A3%87/60378815/%E4%BE%86%E7%A8%BF-%E4%B8%8A%E6%B5%B7-%E5%8C%97%E4%BA%AC-%E6%B7%B1%E5%9C%B3-apec%E5%86%8D%E8%87%A8%E4%B8%AD%E5%9C%8B-%E7%82%BA%E4%BD%95%E8%90%BD%E5%AD%90-%E5%A5%87%E8%B9%9F%E4%B9%8B%E5%9F%8E) |

对项目的影响：主会场在一期范围内，新增地标 `iec-xiangmihu`；数据用会前快照，会后再拉一次做对比；“APEC 周”主题做成开关，默认开启。

## 4. 地标核实

2026-11-09 用 Overpass 逐个查了 OSM 对象，结果写进 [`data/source/landmarks.json`](../data/source/landmarks.json)，范围表见 [00-SCOPE.md](00-SCOPE.md)。

- **计划初稿的手写坐标偏差大**：世界之窗、平安金融中心、深业上城、市民中心偏约 500 到 600 米，京基100 偏约 1 公里。原点因此改为市民中心主楼 `114.0545E, 22.5463N`。
- **华强北在一期框内**：电子科技大厦 `114.0837E`，一期东界是 `114.085E`，所以从二期提前。
- **OSM 已有可靠楼高**：平安 599.1 m，京基100 441.8 m，春笋 392.5 m，深业上城 1 号塔 388.1 m，腾讯南塔 245.8 m、北塔 194.8 m，赛格屋顶 291.6 m，大疆连桥顶 117 m。
- **冲突**：世界之窗埃菲尔铁塔 OSM 写 170 m，公开资料约 108 m（1:3），暂用 108，M4 前定。
- **缺口**：大疆东西塔高度、市民中心、国际交流中心、春茧、地王大厦的高度 OSM 都没有，需要找公开资料。
- “深圳湾大桥”在 OSM 里按“西部通道”系列命名，二期做远景时按 `bridge=yes` 加 motorway 来找。

## 5. 联网检索服务状况

| 服务 | 现象 | 原因 | 处理 |
| --- | --- | --- | --- |
| Tavily MCP（`mcp.tavily.com`） | 一直返回 429“请求过多” | 托管 MCP 网关限流。密钥本身正常：`/usage` 显示 1000 次额度只用了 1 次，直接调 REST `https://api.tavily.com/search` 返回 200 | 绕开 MCP，直接用 REST（`Authorization: Bearer <key>`）；或等网关解封 |
| Perplexity MCP | “You exceeded your current quota” | 账户额度用完 | 需要到 console.perplexity.ai 充值，否则不用 |
| Overpass API | 不带 User-Agent 返回 406；kumi 镜像超时 | 主站要求 UA | 请求加 `-A "slop-shenzhen/0.1"`，复杂查询设 `[timeout:120]` |

密钥只放在 `~/.cursor/mcp.json`，不要写进仓库或日志。

## 6. 仍未定的事

- 大疆双塔、市民中心、国际交流中心、春茧、地王的高度
- 埃菲尔铁塔仿建的高度冲突
- 会后快照和会前快照有没有实质差别（11 月 20 日之后查）
- “京基百纳”仍按京基100 和 KK MALL 理解，等用户确认

## 7. 正式版移植代码复核（2026-11-09）

**同日修正**：用户要求尽量使用真实高程。下述掩膜/中值滤波仅保留为已否决的移植研究记录；当前实现改为完整 HGT 包围盒采样，不压平、不羽化、不平滑、不按目标山高调整。桥面、水面和建筑标高要另按来源处理。详见 `qa/m1-terrain/README.md` 的修正记录。

- 纽约 `js/main.js` 的启动阶段、`index.html` 元素 ID、输入/相机/音频系统作为正式版骨架；不能把 MVP 的 MapControls 面板换个文件名冒充原版交互。
- 纽约 `js/road-network.js` 的 `centrelineStreets()` 确实读取 `GEO.roadGraph`，但 `onLand` 仍使用纽约岸界，主干道正则仍是英文街名；这两处及道路高度需要移植，不能只改数据 URL。
- 武汉 `tools/core_geometry.py` 的 `hill_grid`、`sample_hill` 使用声明的山体掩膜、边缘羽化与同一对角线的三角面取样。深圳复用方法，不复用武汉的山体椭圆、24 米高程偏移和 180 米限幅。
- 深圳 HGT 在原生像元做 3×3 中值滤波、双线性采样后量化为分米。网格接触采用东北—西南对角线的平面插值；单元测试以两组三角面上的重心点核对高度。
- 当前 `PHASE1_BOXES` 是 L 形而非完整外包矩形；只有留仙洞西北延伸达到 22.588N，福田北界为 22.565N。笔架山被裁切，塘朗山、银湖山缺掩膜，需要补范围/远景方案，不能仅凭已经下载 HGT 就勾选地貌完成。
- 第 1 节“桥只做外观”和第 4 节“深圳湾大桥二期做”是历史结论，已被新版 11-MVP 第 3.2 节覆盖：一期主要立交可通行，深圳湾大桥做真实走向远景。
