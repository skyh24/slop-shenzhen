# 三处地标身份与场景设计来源

核对日期：2026-11-13。地图使用 [sources.json](sources.json) 锁定的 Geofabrik 广东 OSM 2026-11-08 快照（ODbL-1.0，哈希见清单）及正式城市包。照片仅用于判读，未复制到运行资源。坐标为项目 WGS84 局部米制；照片和地图不能确定绝对施工标高或现行开放权限。

| 场所身份 | 本轮核实 | 场景设计或估计 |
| --- | --- | --- |
| 海上世界：`landmarks.json#sea-world`，明华轮 [way/105683429](https://www.openstreetmap.org/way/105683429)，广场 [way/543176177](https://www.openstreetmap.org/way/543176177)，池 [way/261597655](https://www.openstreetmap.org/way/261597655) | [深圳市地名志](https://pnr.sz.gov.cn/attachment/1/1285/1285348/10537364.pdf)记载船长约 168 米、宽 21 米；[2021 航拍](https://commons.wikimedia.org/wiki/File:Sea_World_in_Shekou_Shenzhen2021.jpg)与[2025 现场照](https://commons.wikimedia.org/wiki/File:SZ_Shenzhen_Nanshan_Shekou_Sea_World_MingHua_Ship_April_2025_R12S_311.jpg)支持东北船首、南侧水池、两端广场与阶叠甲板。城市包内池线较 OSM 简化，和地表裁切同一数据。 | 船壳拟合快照足迹，驾驶台、甲板、灯效、池水标高与喷泉设备均为估计。西侧接驳参考 way/543176160–161；仿真船体与通道关闭，不表示实地停运。way/543176183 为 layer=1 的罩棚，保留轮廓，改作可从地面穿过的高位屋面。零售楼只改无来源估高；有来源楼高保留。 |
| 华侨城创意文化园：`landmarks.json#oct-loft`，场所 [way/741581536](https://www.openstreetmap.org/way/741581536)，B10 [way/435827468](https://www.openstreetmap.org/way/435827468) | [设计方提交的项目图照](https://www.archdaily.com/1004207/ocat-b10-urbanus)说明 B10 原为两层磁碟厂，改造后有露天展厅、白色体量、筛网和圆盘主题；园区 [北区改造资料](https://www.trueart.com/news/374176.html)说明 A4/A5 有二层连廊与平台。步行主轴参考 way/435827458，西转庭院参考 way/435827462。 | B10 保留源足迹，替换 52.1 米通用估高；约 10.95 米为视觉估计。A3/A4/B1 等 GloBFP 高度保留；2–4 层模板限于明确选中的无可靠高度、无层数记录对象。筛网、外挑阳台、露台、门面、A3+ 关闭楼梯、坐凳和艺术装置为场景设计，不给室内及屋顶分配公共通行权限。 |
| 南头古城：`landmarks.json#nantou-ancient-city`，场所 [way/219961346](https://www.openstreetmap.org/way/219961346)，南门 [way/1183877518](https://www.openstreetmap.org/way/1183877518)，门洞 [way/1436861800](https://www.openstreetmap.org/way/1436861800) | [南头古城运营方](https://www.nantoucity.com/building)的南门、牌坊图照及[景观设计说明](https://www.archina.com/index.php?a=show&g=works&id=6723&m=index)确认南牌坊与历史南城门分立，南城门为砖石拱门，入口轴接中山南街。南北路径来自 way/1436861799、way/317200055，东支巷来自 way/1050467258。 | 牌坊在南段步行轴配准，快照没有精确足迹；檐部及两翼短墙为设计尺寸，两段墙均为用户指定扩展，不属于历史城墙测绘。原南门以源足迹和门洞方向建模，券顶高度、砖石、照明及内部店面细节为近似。南达街仍有车行线，NPC 在两侧各自活动。 |

地块之外保留原生产模型。派生步行条带和场地铺装贴现有地表，排除车行面；南头中山南街与南达街交叉处保留车行面。海上世界环路走水池外侧的地面，未将源台阶和分层通道冒充同一条测绘路线。

开放门店是临步道的浅进深展示铺位，入口、货架、柜台、商品和招牌均为场景设计；不表示真实商家或交易功能。路灯以约 21 米为候选间距，受地面、建筑、门店和通道净宽限制。花圃、外摆与低栏为设计布置，午夜灯光不复刻真实照明方案。
