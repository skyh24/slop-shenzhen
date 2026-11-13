# Slop Wuhan：外墙、建筑形体、街道与行人机制

调研：2026-11-12—13。结论来自正式入口的源码、运行包统计及定向测试；本轮未进行浏览器画面或实际通行验收，未修改深圳运行代码和正式包。

武汉本地只读参考与联网核对的上游 HEAD 同为 [`7a62402a81f3cb50b38e664323f2cf7e4e132eac`](https://github.com/LightYearZh/slop-wuhan/tree/7a62402a81f3cb50b38e664323f2cf7e4e132eac)。正式入口是 `index.html → js/runtime/main.js`，不能将顶层旧生成器或遗留的 Taipei/Shanghai 注释当作当前武汉行为；但 runtime 确实还导入部分顶层通用组件。纽约对照固定到[此前核对的版本](slop-newyork-scene-techniques.md)，不将两项目各时期的代码混算。[正式装配][main]

## 1. 外墙怎么贴：主要是计算图案，特殊建筑再加几何和小纹理

普通楼采用“源轮廓挤出＋一个共享外墙材质”。沿每条真实轮廓边生成墙面，包含内院；墙面传入沿墙距离、墙长、地面高度、楼高，以及样式、临街标记和固定种子。材质在 GPU 上计算窗格、瓷砖、玻璃、污迹、防盗窗、空调、店面和夜间窗光。普通墙面不逐栋下载照片，也不逐窗创建网格。[楼体生成][buildings] · [外墙材质][facade]

窗列数按墙长四舍五入成整数，再用墙长除以列数，因此每面墙能放下完整窗列；楼层从自身地面标高起算，不足完整一层的顶部通常封成实墙/女儿墙。玻璃分支保留自己的顶部处理。窗后房间使用视线与虚拟盒体相交的室内映射，只制造有纵深的观感，不生成可进入的房间。细线和窗格按像素尺度过滤，远处细节逐渐简化。[窗格与室内][facade]

临街墙通过墙外采样与附近非高架道路判断，临街首层可显示商铺、招牌色带、卷帘门和骑楼阴影；背墙会减少住宅窗户。这里的商铺、骑楼、封闭阳台和空调多为材质表现，不能据此认定真实用途、凸出的实体或可进入入口。[临街判定][buildings] · [首层与细节][facade]

历史建筑采用真实几何做拱窗框、柱廊、阳台、檐口和顶冠；砖石、金属屋顶、匾额等小纹理由 Canvas 本地绘制。`heritageMaterials()` 缓存一套共享材质，匾额按文字缓存。黄鹤楼还有专门绘制的琉璃瓦、檐底、栏杆/窗棂和匾额纹理。这些是程序纹理，照片作为造型参考，并非直接贴整栋照片。[历史立面][heritage] · [共享建模工具][craft] · [黄鹤楼][yellow]

## 2. 目前有哪些墙面样式

### 普通楼材质声明 9 种样式

| 编号 / 标识 | 视觉表现 | 选择依据与范围 |
| --- | --- | --- |
| 0 `walkup` | 低层老公寓，小瓷砖、密窗、防盗窗、空调与雨痕 | 低矮普通楼或 HOUSE 分支；并非所有都是实测年代的老住宅 |
| 1 `midrise` | 中层住宅，较大窗、部分整开间封闭阳台、瓷砖墙 | 普通较高住宅及较低商业楼回退样式 |
| 2 `glass` | 玻璃幕墙、竖框、窗间板与天空反射 | 较高商业/公共楼或指定滨江办公 profile |
| 3 `civic` | 浅色涂料/混凝土、较宽窗带 | 普通公共楼、historic 回退；不等于历史专模 |
| 4 `shed` | 波纹金属外墙、较高位置的小窗 | 工业/棚屋分支 |
| 5 `temple` | 红墙，配独立曲面瓦屋顶 | 声明的普通寺庙分支；当前包的 kind 转换未使用 TEMPLE，不能算作实际批量启用的普通楼样式 |
| 6 `residentialTower` | 现代浅色高层住宅，复用中层住宅窗格逻辑并减少老式杂物 | 指定滨江住宅或 category 为住宅且高度至少 60 米 |
| 7 `hotel` | 浅色墙体加水平深色玻璃窗带 | `qingchuan-hotel` 专项外观选择 |
| 8 `hankouTower` | 米褐色的汉口滨江住宅塔楼 | `hankou-riverfront-residential`，与现代住宅共享主要计算 |

上述 9 是 `BUILDING_STYLE` 的定义数，**当前包普通共享材质路径实际使用 8 种，temple 为零**。它们不是 9 张外墙图片或 9 套完全独立的着色器；现代住宅、酒店和汉口住宅在同一计算结构上组合或覆盖部分表现，也不包含历史建筑、地标和标牌的全部材质。[样式定义与分支][facade] · [选择函数 styleOf][buildings]

独立调用实际 `styleOf()`、并按生成分支排除历史/街景外观和专用门楼后，共 23,503 条普通部件、23,419 个源 ID：低层 13,783、中层 8,903、玻璃 317、公共 311、工业 33、现代住宅塔楼 146、酒店 1、汉口滨江住宅 9。排除了 22 条 heritage、1 条 context 和 293 条专用 passage 部件；仍走普通材质的 building-passage 部件保留。原 `detailStats.styles` 在这些分支排除前就累加，不能直接用它当作普通材质实际绘制数量。[分支顺序][buildings]

颜色是另一维度：普通材质包含 12 个瓷砖色、6 个涂料色、6 个钢板色、6 个玻璃色，再由种子和样式混合。不能把这些色板数量相加当作新的建筑类型；尺寸、窗格和亮灯状态同样可复用参数变化。[色板][facade]

### 历史建筑是另一套模板

`config/hankou-heritage.json` 当前有 **22 个绑定源身份的建筑配置、9 个模板名**：台湾银行、汇丰银行、花旗银行、转角圆顶、古典商业、克制装饰艺术、现代银行、柱廊银行、砖墙商业。它们通过同一个 `buildHeritageBuilding()` 选择柱廊、拱窗、柱数、楼层和屋顶细节，不能简单与普通楼的 9 种相加成“18 种墙面”。身份按源 ID 和预期名称检查，装饰尺寸仍有参考推估。[配置][heritage-config] · [身份绑定][heritage-profiles] · [生成器][heritage]

运行包另有 **1 个 `contextAppearance`**：长江航务管理局沿街外观，复用古典商业模板，但明确标注为临时街景重构，未核实为历史建筑身份。保留这个区分比增加一套外墙生成器更有用。[运行转换][runtime-build] · [场景分支][buildings]

## 3. 建筑的样子怎么决定

墙面样式与建筑形体独立：同一住宅材质可以包裹长条楼、折线楼、带院落的楼和住宅塔楼。主体通常由地图足迹、孔洞、高度和部件确定；裙房、塔楼、顶冠通过 `massingParts` 保留各自轮廓与底高。屋顶按足迹三角化，架空部件另画底面并保留高度范围。[运行转换][runtime-build] · [轮廓与屋顶][buildings]

数据契约声明 8 个 kind：住宅、商业、公共、工业、寺庙、雨棚、独立住宅、车站。但本次实际解包的 23,819 条建筑部件仅用了前 4 个：住宅 21,579、商业 1,808、公共 399、工业 33。去重为 23,461 个 `sourceId`；这些是该版本数据分类，不代表现实所有建筑均已准确核实用途。宗教/历史类别在现行转换中映射到公共类，塔楼/顶冠部件可映射到商业类，故不能只看枚举宣称当前有 8 类不同模型。[映射代码][runtime-build]

按实际建模路径，可理解为四组：

| 路径 | 形体与细节 | 复用方式 |
| --- | --- | --- |
| 普通源轮廓楼 | 不规则多边形楼体、平屋顶、内院，部分有已配置塔裙/顶冠 | 同一墙材质，按 600 米空间块合并几何 |
| 普通楼屋顶附属物 | 少量程序化设备房/铁皮棚，先检查屋顶容纳与孔洞 | 单位盒体和坡顶实例化，共享波纹金属材质 |
| 历史及街景外观 | 源足迹上加石材分层、拱窗、柱廊、局部阳台、顶亭/圆顶 | 同一历史建筑工厂、缓存材质、按材质合并 |
| 具名地标及门洞 | 按地标识别形状专建；通道另有 passage 分支 | 基础几何与纹理工具复用，特色结构独立 |

当前普通屋顶代码保留水箱模型构造，但 `tanks` 列表没有填充，实例数量为零；因此不能从旧注释推断“武汉楼顶到处都有水箱”。低层/中层楼的屋顶棚是稀疏示意，也不是实测屋顶设施清单。[屋顶实现][buildings]

## 4. 地标、特殊地方和重用

`GEO.wuhanLandmarks` 当前是 5 个具名地标对象，不含全部高楼外观、22 栋历史建筑或桥梁装饰；绿地中心等滨江高楼还可沿源建筑部件/profile 路径表现，不能只查这个列表判断是否有建筑。[地标装配][landmarks] · [建筑 profile][buildings]

| 地标/场所 | 特殊形体怎么做 | 共享部分与边界 |
| --- | --- | --- |
| 江汉关 | 源凹形足迹、柱廊、钟楼、四面钟盘与顶冠，窗格沿实际墙边排列 | 盒体/柱体与同材质批处理；檐带跟足迹走，避免包围盒填掉凹口 |
| 黄鹤楼 | 多层楼身、曲面飞檐、屋脊、柱栏、窗棂和匾额 | 程序几何及小纹理；识别轮廓需要专门屋顶算法 |
| 龟山电视塔 | 三条斜支腿、收分塔身、观景层和天线 | 圆柱/杆件复用；夜景材质独立，避免照亮其他共材质建筑 |
| 晴川阁 | 两层楼身、柱列、曲面屋顶 | 核心地标的盒、柱、梁、屋顶函数 |
| 红楼 | 源轮廓与红砖主体、门窗和顶部部件 | `modelBuilder()`、足迹几何和砖纹理 |
| 长江大桥、晴川桥、江汉桥 | 桁架、红色钢拱、吊杆和桥墩等识别结构 | 交通桥面由道路/桥面系统提供；景观结构不能重复加一块封路碰撞面 |

来源：[江汉关][jianghanguan] · [黄鹤楼][yellow] · [红楼][red-house] · [其他地标及桥梁装饰][core-landmarks]。

`modelBuilder()` 提供 `box/cyl/beam/add/finish`，按材质收集后合并几何并释放中间对象。这里是**部件函数复用＋静态合批**，不等于全部地标都实例化，也不等于全城只剩一个材质。`core-landmarks.js` 与江汉关还各保留相似的局部收集器，说明武汉已有复用，但尚未彻底统一。[工具][craft] · [核心地标][core-landmarks]

江汉路采用“既有步行面换铺装＋路侧少量街具”：构建阶段把已有步行多边形与江汉路走廊求交，只分割换材质，不向道路、水体或建筑扩大；材质坐标沿最近源路径的长度和横向距离计算，中央青石带随道路拐弯。花箱、长椅、特色灯和防撞柱共用摆放预约与材质合批，但位置与造型注明是示意布景。[铺装裁切][heritage-paving] · [沿路坐标][paving-coordinates] · [街具][streetscape]

通行不能只凭外观判断：历史建筑仍登记源轮廓整体碰撞；具名地标也主要登记轮廓和整体高度，未将每个柱间/入口从碰撞中扣出。显示有台阶、凹入柱廊、门洞阴影，不证明 NPC 或玩家可以走入。部分桥梁共享三角面用于显示与接触，是可借鉴的接口，但仅适用于满足配对条件的桥面；其固定基准扣减不应复制为深圳真实标高。[建筑碰撞][buildings] · [地标碰撞][landmarks] · [桥面][bridge-surfaces]

## 5. 车道线、人行道与红绿灯怎么做

### 车道线是沿路网生成的条带

`PaintBuilder.strip()` 沿折线两侧生成顶点，附沿线距离、周期、显示比例及颜色。共享 TSL 材质裁出虚线、做远处细线抗锯齿和磨损/湿润效果；不是每截虚线创建一个盒子或下载一张图片。标线按 1,000 米空间块合并，路口按节点半径退让。[标线几何][paint] · [标线材质][paint-material]

| 内容 | 该版本程序参数，不是现实规范 |
| --- | --- |
| 同向白虚线 | 宽 0.15 米，周期 10 米，其中 40% 显示 |
| 主路双黄线 | 两条各宽 0.15 米，中心偏移 ±0.13 米 |
| 较小双向路中心黄虚线 | 宽 0.15 米，周期 6 米，其中 50% 显示 |
| 斑马线 | 源 crossing 点确定位置/朝向，沿车行方向深 3 米，横向周期 0.9 米、显示 50%；旧注释写 0.8 米，以执行值为准 |
| 停止线与两轮车等待区 | 合适信号进口派生；停止线宽 0.4 米，宽路可加等待区轮廓 |

顶点高度按地形、已配对桥面或道路自身采样选择，再加 `0.055` 米偏移；不是统一放在世界零高度。但斑马线分支固定查地形，信号停止线分支不查配对桥面，因此并非所有标记都已经消费同一分层表面。[取高与具体分支][paint]

道路标线与车流虽共用 `ROAD_LINKS`，仍各自推断车道宽度：双向主路的标线使用 `(半路宽−1.2)/每向车道数`，交通图使用 `半路宽/每向车道数`。这意味着“同一路网”不等于“车道线和车辆中心位置严格统一”；深圳应只生成一次断面供两者读取。[画线断面][paint] · [交通断面][traffic]

### 人行道实体与砖缝分开

人行道轮廓是多边形网格，侧边另建路缘；`createWuhanSidewalkMaterial()` 声明 3 种表面：30 厘米方砖、20×10 厘米红砖、米灰相间铺装，按 60 米世界坐标格的哈希选择。砖缝只是材质图案，不是每块砖都有独立碰撞。江汉路青石另用沿路坐标材质；通用公园铺装工厂虽支持另外 3 个模式，当前广场/步行街调用主要选其中的花岗岩模式，不能把所有声明模式当作已铺满场景。[地面调用][ground] · [人行道材质][sidewalk-material] · [江汉路材质][paving-material]

### 红绿灯是实例化实体，灯面图案由着色器计算

每个有效进路口方向，在右路缘生成杆、横臂、横向三灯灯箱和人行灯箱。几何实例化；每个实例携带路口偏移与相位，着色器画红黄绿圆灯、人行灯的简化头部/身体图案及绿灯末段闪烁。并没有每盏灯各加载一张红绿灯图片，也没有完整动画走路小人。灯具数量取决于有效进口、路长、单行方向及摆放预约是否成功。[灯具与灯面][signals]

本次包中有 **102 个信号控制记录、154 个 crossing 记录**；这不是 102 根灯杆或 154 个已验证可走的过街连接。信号周期为 66 秒：每方向绿 28 秒、黄 3 秒、全红 2 秒；人行允许阶段 22 秒，末 6 秒闪烁。每路口通过位置产生相位偏移，各进口按主轴分组，人行灯采用交叉方向相位。上述均为模拟规则，未核验现实逐路口配时。[控制器][signal-config]

车辆 CPU 逻辑、人行提示音与灯面 GPU 逻辑使用同一时钟/参数来源；灯面和车辆仍有不同的计算实现，需要验证边界一致性。信号灯实例底高目前直接用 `SIDEWALK_HEIGHT`，不能据标线贴地就宣称灯杆也适配所有坡路。[灯具][signals] · [车流][traffic] · [音效][audio]

## 6. 行人是不是固定路线

**环境行人基本是“选一条路段，再沿固定偏移线来回走”。** 起点、左右侧、偏移、速度和方向随机；存活期间并不持续寻找新的全城目的地。[生成与更新][traffic]

1. 候选来自非高架、长度超过 25 米的道路，筛选主要道路或禁车步行线路，按空间格查找附近候选。
2. 普通道路沿路缘外 1.0–2.2 米偏移；步行街在路宽中间约 80% 范围随机横向偏移。道路两端扣除路口半径再加 3 米，生成点在有效区间内。
3. 普通人行道出生点检查 `SIDEWALKS.contains()`；这不是对整段路径的连续净宽/障碍检查。
4. 到达段端就反向，随机停 0–2 秒；没有普通环境 NPC 路口选路、信号等待和斑马线穿越逻辑。`walkSignal()` 被音效使用，交通系统中的 NPC 没有消费它。
5. 离镜头超过 300 米回收再选路段，默认池 260 人，轻量模式 80 人；池容量不等于每帧都实际出现这么多人。骨骼姿态与实例化人物资源可复用。

玩家自由步行由独立控制器处理，不限制在这些 NPC 线段上；出租车乘客等专用行为也不能与这里的环境行人池混为一谈。[正式装配][main] · [环境行人][traffic]

**树灯避让仍有断层。** `SpatialPlacement` 会预留车道、步行走廊、隧道坡口等范围，设施摆放失败就不生成；玩家收到根据树干/杆体真实尺寸构造的街具碰撞。但 `main` 虽传了 `streetProps`，`createTrafficSystem(scene)` 没接收该第二参数，环境 NPC 更新没有用街具障碍做绕行。步行街 NPC 还使用固定 `0.04` 米脚底回调，不能将材质随山地起伏理解为行人也正确贴面。[预约系统][placement] · [实体碰撞][prop-colliders] · [接线][main] · [行人脚底与更新][traffic]

## 7. 和 New York 相比有什么不同

| 方面 | 武汉当前核对版本 | 纽约已核对版本 |
| --- | --- | --- |
| 普通墙面组织 | 一套共享材质声明 9 个样式，当前使用 8 个，偏住宅瓷砖、混凝土、工业和滨江塔楼细分 | 曼哈顿砖石/幕墙 2 家族、5 预设；外围另一个材质的 5 模式，不能说全城只有 5 种 |
| 样式分配 | 用途类别、楼高、指定 facade profile 与种子；部分细节是示意 | 曼哈顿主要按建筑年代和种子；商铺比例也有程序推断 |
| 普通楼形体 | 源足迹/内院、塔裙部件、底高；当前 HOUSE 枚举不代表另有已启用的别墅系统 | 曼哈顿同样用源足迹；外围还有联排、郊区低层、厂房、十字住宅塔与裙房高楼等程序模板 |
| 近看住宅 | 瓷砖、防盗窗、封闭阳台、空调及老化多由着色器表达 | 砖石檐线与窗格较突出，另有实体消防梯、屋顶水塔和设备实例 |
| 历史风貌 | 22 栋身份绑定建筑共用历史工厂，1 个临时街景外观明确标注 | 重点通过具名地标、普通砖石立面、广告和广场塑造风貌 |
| 地标形体 | 钟楼、古建飞檐、电视塔、红楼及跨江桥，更多专项轮廓 | 退台摩天楼、尖塔、斜切/棱面塔体、三角楼、古典公共建筑等 |
| 外观贴图 | 普通楼程序化，历史/地标部分使用本地生成的小纹理 | 普通楼程序化，文字/广告主要用 Canvas 图集 |
| 地面与标线 | 标线可查地形/桥面，江汉路铺装随弯曲道路；仍有分支不一致 | 标线由交通网络派生，主街多用固定平面标高 |
| 人行灯 | 有简化人形、每路口相位偏移；不代表 NPC 会等灯 | 人行面板主要为颜色切换；双向接线存在限制 |
| 环境行人 | 选路段后往返，缺少普通跨路口与树灯绕行 | 缓存路径段、随机目标、路口连接和局部绕障，但输入及碰撞也有边界 |

纽约的具体依据与局限见[纽约源码调研](slop-newyork-scene-techniques.md)。视觉取向可概括为：武汉更强调汉口街面、国内住宅细节和少量身份明确的历史建筑；纽约更强调砖石街墙、幕墙天际线与外围街区模板。这是从生成规则推导的风格判断，本轮未做同机位画面对比，也不能据样式数量判断哪边更真实或更快。

## 8. 记录给深圳的可复用经验

| 可以采用 | 应怎样收敛 | 不能一并照搬 |
| --- | --- | --- |
| 真实体量与程序立面分离 | 同一少量材质覆盖不同真实足迹，类型默认值集中 | 9 个样式不意味着深圳也必须增加到 9 个；保留未知和估计语义 |
| 墙面局部米制坐标、整窗格 | 普通楼和可兼容部件复用计算，减少转角残窗 | 视觉商铺、骑楼和室内映射不自动产生可进入空间 |
| 历史/地标组件词汇 | 柱、窗、檐、栏、屋顶、铭牌共享，只保留识别轮廓 | 不给整个区域随机套古典建筑，不复制每栋专用材质工厂 |
| 先裁公共面、再换铺装 | 商圈/办公前场复用石材，沿路铺装使用局部路径坐标 | 不能把整个商圈多边形涂平，也不把遗留固定基准当真实高程 |
| 预约布局、实例化街具 | 净通行带优先，物件预约与实体碰撞尺寸明确分开 | 预约成功不证明 NPC 已消费障碍；显示、玩家和 NPC 必须核对实际接线 |
| 路网驱动标线和信号 | 一套断面结果、一套按方向信号状态，多个消费者读取 | 不保留标线/车流分别推车道的重复计算，不把模拟灯时当现实配时 |
| 人物池与局部路线缓存 | 复用模型、数量预算和路径数据，特殊行为单独接入 | 不把武汉短段往返升级描述为完整导航，也不降低深圳现有能力来求统一 |
| 合批与材质缓存 | 静态按材质/空间批次合并，重复可动对象实例化 | 单材质仍可能有复杂着色计算；省材质数不直接等于省 GPU 时间 |

这些经验补充 [34 号统一规范与复用计划](../34-SHARED-SCENE-AND-STYLE-PLAN.md) 和 [32 号道路方案](../32-ROAD-NETWORK-AND-STREET-PLAN.md)，不新增实施授权或改变正式任务状态。

验证：只读解包统计了建筑 kind、源 ID、历史配置、地标、信号和 crossing 数；使用武汉随仓 three.js 与本地 QA 导入映射，运行其历史建筑、铺装坐标和空间预约三个测试文件，共 **10 项通过、零失败、零跳过**。范围只覆盖身份/几何与部分规则，不包含浏览器灯面、NPC 过街、真实通行或整页性能。原始日志与核对脚本保存在本地 `docs/qa/wuhan-scene-research/`。

[main]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/main.js#L82-L110
[buildings]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/buildings.js
[facade]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/tsl-materials.js#L2937-L3183
[heritage]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/hankou-heritage.js
[craft]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/landmark-craft.js
[yellow]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/yellow-crane.js
[heritage-config]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/config/hankou-heritage.json
[heritage-profiles]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/heritage_profiles.py
[runtime-build]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/build-runtime.py#L18-L98
[landmarks]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/landmarks.js
[jianghanguan]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/wuhan-landmarks.js
[red-house]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/red-house.js
[core-landmarks]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/core-landmarks.js
[heritage-paving]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/heritage_paving.py
[paving-coordinates]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/paving-coordinates.js
[streetscape]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/wuhan-streetscape.js
[bridge-surfaces]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/bridge-surfaces.js
[paint]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/road-paint.js
[paint-material]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/tsl-materials.js#L1770-L1827
[traffic]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/traffic.js
[ground]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/ground.js#L220-L261
[sidewalk-material]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/tsl-materials.js#L3271-L3310
[paving-material]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/tsl-materials.js#L1424-L1449
[signals]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/street-props.js#L211-L335
[signal-config]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/city-config.js#L359-L420
[audio]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/audio-sources.js#L205
[placement]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/spatial-placement.js
[prop-colliders]: https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/prop-colliders.js
