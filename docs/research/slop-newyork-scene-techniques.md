# Slop New York：建筑立面、场所、道路与行人机制

调研日期：2026-11-12。研究范围是源码机制与可迁移经验，不代表深圳已实施，也不代表纽约实景尺寸、通行和性能已验收。

联网核对上游为 [`2813185434ec4f11e105fff7fb87665fab81b558`](https://github.com/mrdoob/slop-newyork/tree/2813185434ec4f11e105fff7fb87665fab81b558)。本地只读参考 `ref/slop-newyork` 为 `536a907c605964421563f12f15c5e00d735fc94f`；逐文件比较确认两版 `js/*.js` 内容相同。下文链接固定到上游提交，避免后续版本漂移。上游另有 [迁移指南](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/PORTING.md)。本轮未运行纽约浏览器实走；核对快照与研究笔记留在本地 `docs/qa/slop-newyork-research/`。

## 1. 建筑外墙究竟怎么“贴”

它把建筑分成三层：**数据决定主体形状，着色器生成墙面细节，近景几何补充突出物。** 普通建筑墙面没有逐栋摄影贴图，也不是每扇窗都建立一个模型。

1. `building-geodata` 提供多边形外轮廓、内院、楼高和年代；当前包有 37,353 条建筑记录，坐标量化到 0.5 米、楼高到 1 米、年代到十年。这个数量不包含所有外围程序生成体量，也不等于最终可见网格数。[数据加载器](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/building-geodata.js#L1-L63)
2. `createBuildingFootprints()` 沿轮廓每条边建立墙面，屋顶按含孔多边形三角化。每面墙传入宽、高、种子和墙面类型，局部横坐标沿墙展开，因此斜街墙面也能保持以米为单位的窗宽。[轮廓建模](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/building-footprints.js#L24-L102)
3. `facadeCell()` 先算能放几列完整窗格，再微调每格宽度；砖石墙两端留实心墙柱。楼顶不足整层的部分封成实墙/女儿墙，减少半扇窗被转角和屋顶切断。[墙面坐标与窗格](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L423-L508)
4. TSL 材质计算玻璃、窗框、砖石色、污迹、檐线、粗糙度和自发光。窗后采用 `interior mapping`：根据视线与虚拟房间盒相交，画出有透视的室内；房间横跨整数 2 或 3 个窗格。它没有因此生成可进入的室内空间。细线通过 `fwidth` 等做像素尺度过滤，远处窗光趋向平均值，抑制闪烁。[室内计算](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L218-L411) · [砖石材质](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L878-L1224)
5. 突出的消防梯、屋顶水塔、设备、雨棚和施工棚才用额外几何。屋顶设备检查是否落在楼内、是否穿内院、是否被邻楼覆盖，并预约已占位置；建筑细节以四叉树查询约 560 米范围，移动约 18 米才重新选择，重复部件进入实例池。[细节布局](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/building-details.js#L31-L121) · [实例池及更新](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L491-L810)

**图片纹理仍有，但主要用于文字和广告。** 商铺文字在运行时画成一张 512×512 Canvas 图集，含 8 个通用英文店招；广告屏有 6 个 Canvas 主题并缓存，地标名称也可单独画 Canvas。它们是程序绘制的标牌，不是实拍外墙照片。[店招图集](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L511-L527) · [广告材质](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L2370-L2720) · [MetLife 标牌](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js#L52-L69)

## 2. 外墙有几种：需要区分统计口径

### 曼哈顿普通楼：2 类材质、5 套通用预设

| 预设 | 材质家族 | 视觉特征 | 目标窗格宽 / 层高 |
| --- | --- | --- | --- |
| 0 | 战前砖石 | 浅石灰石、米黄砖 | 2.6 / 3.7 米 |
| 1 | 战前砖石 | 暖红砖、陶土色 | 2.4 / 3.5 米 |
| 2 | 玻璃幕墙 | 蓝绿玻璃 | 2.7 / 3.9 米 |
| 3 | 玻璃幕墙 | 深青铜、炭黑玻璃 | 2.5 / 3.8 米 |
| 4 | 玻璃幕墙 | 银色框、冰蓝玻璃 | 2.9 / 4.1 米 |

这些是程序外观参数，不是测量出的实际层高。材质使用 `createPreWarBuildingMaterial()` 和 `createCurtainWallMaterial()`；颜色、亮灯概率、光色等参数可变化。[五套配置](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L167-L219)

分配规则也很明确：1945 年以前，80% 选浅砖石、20% 红砖；1945–1979 年，55% 浅砖石、45% 深色玻璃；1980 年以后或年代未知，60% 蓝绿玻璃、40% 银蓝玻璃。选择由位置派生的固定种子控制，同位置可复现。年代已经按十年量化，因此这不是对 1945 年逐栋精确判断。楼高至少 6 米的建筑另以 55% 概率赋予商铺首层，源码明确说明输入没有用途数据。[分配代码](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L343-L369)

还有一个独立维度是 **4 种墙面处理**：`shop` 商铺、`front` 普通正面、`rear` 内院/后墙、`lotLine` 邻楼贴合墙。内院不套商铺；邻楼贴合判断通过沿墙采样估计。这里的 `front` 也不是经过真实入口或街道朝向调查的“正门”。[墙面分类与邻楼采样](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/building-footprints.js#L5-L67) · [类型定义](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L416-L420)

### 外围城区：另一套单材质的 5 种样式

`boroughs.js` 并不直接套上述五套预设。它用一个共享材质，通过实例属性选择 0–4：砖墙开窗、玻璃幕墙、工业仓库窗、现代横带窗、棕石/浅石墙开窗；每栋还带尺寸、颜色和种子。因此不能说“整个纽约一共只有五种外墙”，也不能简单把两个系统相加当作十种互斥建筑类型。地标、码头建筑和特殊屋顶还会使用专门材质。[外围材质](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/boroughs.js#L948-L1039) · [配色映射](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/boroughs.js#L1428-L1438)

## 3. 建筑有哪些类型

按实际生成路径，可以分成以下三组；这是对源码职责的归纳，不是上游的统一用途分类表。

| 生成路径 | 包含内容 | 真实性边界 |
| --- | --- | --- |
| 曼哈顿源轮廓楼 | 不规则、多部件、带内院的轮廓墙体与平屋顶，再加砖石/幕墙和近景设备 | 轮廓、高度、年代有源数据；商铺、店名、设备及外观大多是程序推断 |
| 外围街区模板 | 临街联排住宅、无电梯公寓/老式公寓、郊区低层住宅、厂房仓库、绿地内十字形住宅塔楼、裙房加 1–3 座高楼，以及具名天际线塔楼 | 根据区域、用地、热点、密度和固定种子生成，不是逐栋测绘复刻 |
| 地标与特殊场所 | 特定高楼、车站、图书馆、公园、广场、码头、岛屿及桥梁组合 | 主要靠手写程序体量与识别性部件；模型存在不证明入口或交通接驳完整 |

源轮廓路径见 [buildings](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L343-L381)；外围的区域规则、生成分支和具名塔楼见 [neighbourhood / generateBlock](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/boroughs.js#L1495-L1764)。外围的地块宽度还随距曼哈顿的距离合并简化，不能据远处盒子数量推算真实楼栋数量。

## 4. 地标怎么做，哪些东西可重用

### 先做识别性形状，再套共享立面

`landmarks.js` 有 11 组主要建模段落：帝国大厦、克莱斯勒大厦、One Vanderbilt、中央车站与 MetLife、布莱恩特公园与纽约公共图书馆、One Times Square、洛克菲勒中心、花旗中心、熨斗大厦、西格拉姆大厦及广场、世贸一号。这个口径是该文件的建模段落，**不是整个场景地标总数**；外围、桥梁和码头还有其他专模。[地标源码](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js)

| 对象 | 主要程序建模方式 |
| --- | --- |
| 帝国大厦 | 多层退台盒体、竖向装饰、顶部塔身与尖塔 |
| 克莱斯勒大厦 | 退台楼体加专门的金属顶冠几何与材质 |
| 熨斗大厦 | 三角形曲线轮廓挤出，配倒角和屋顶收边 |
| 花旗中心 | 立柱、核心、抬高塔身、挤出的斜切屋顶 |
| 世贸一号 | 裙房、棱面塔体、顶部和天线组合 |
| 中央车站/图书馆 | 盒体、拱窗、柱列、门廊、屋顶和标牌的组合 |

具体依据：[帝国/克莱斯勒](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js#L190-L400) · [车站/图书馆](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js#L460-L698) · [花旗/熨斗](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js#L806-L907) · [世贸一号](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js#L950-L1034)。这些描述只陈述代码构造，不证明与实景每个细部一致。

### 复用集中在四处

- **材质复用：** 地标共用石灰石、浅大理石、银色幕墙、青铜幕墙四套主要立面参数；独特顶冠另设材质。材质工厂有缓存，可变色彩等通过 uniform 传入，减少重复着色器结构。[共享配置](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js#L71-L125)
- **几何复用：** 未旋转的盒形部件统一收集到 `createFacadeBoxes()`，用单位盒子实例化，传入尺寸与种子；相同材质的其他静态网格再批处理。旋转和非盒形部件仍走世界坐标窗格，不应假定所有专模都享有局部整窗格效果。[地标收集与批处理](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js#L1036-L1064) · [实例盒](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L1228-L1240)
- **放置复用：** 每个地标先在局部坐标建模，再由 `fitToSite()` 按场地包围盒、目标高度和可选偏移缩放、平移；碰撞盒同时变换。公园可沿两轴分别拉伸，车站与 MetLife 可先合并场地。这是简化拟合，并非精确复原全部足迹。[fitToSite](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js#L127-L187)
- **普通楼让位：** 先生成地标，普通楼构建时通过地标中心包含关系与碰撞重叠剔除源轮廓，再预约地标位置供设备等避让。这里不是逐对象源 ID 替换；迁移时可能连邻楼一起排除，深圳应保留自己的已核 ID 绑定。[主入口顺序](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/main.js#L113-L139) · [让位规则](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L242-L299)

**不能直接照搬碰撞简化。** 例如花旗中心虽然画出柱子和抬高塔身，登记的却是覆盖平面范围、没有 `minY` 的整块碰撞盒；入口、柱间与桥下是否可走需要另外建模。视觉开口不自动成为通行开口。[花旗碰撞](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/landmarks.js#L817-L856)

## 5. 特殊地方怎样形成整体风貌

时代广场不只靠 One Times Square 专模：`buildings.js` 检查附近墙面是否朝向百老汇/第七大道的广场带，在合适墙上从约 7.5 米到最高约 62 米分层挂广告平面，同主题合并成网格。普通建筑因此也参与场所外观。[墙面广告生成](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L415-L488)

地面由 `city-grid.js` 独立建立广场多边形、路缘、铺装和街具。铺装共用一种材质，通过属性选择 **六边形沥青砖、浅灰花岗岩错缝砖、青石/花岗岩方板三种样式**；长椅、灯、树有共享集合。TKTS 红台阶用 27 级盒体与发光材质构造。中央公园另读公园轮廓、草地、水体、道路和特色对象；码头也有各自的构造规则。[广场与共享集合](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/city-grid.js#L1622-L1764) · [公园](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/city-grid.js#L1807-L2016) · [铺装三样式](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L1500-L1576)

可迁移经验是：**区域规则可以作用于已有建筑、地面和街具，不必把整个商圈做成一个巨大专模。** 深圳商圈可以保留真实建筑身份，按已核场所边界配置首层、招牌、铺装与设施；不能因为设置了区域风貌就自动认定全部内部空间公共开放。

## 6. 车道线、斑马线和人行道怎么铺

### 标线是薄条带几何，虚线由材质裁出

`buildRoadPaint()` 直接读取车流使用的 `trafficSystem.network`，从同一车道偏移、道路端点和路口位置派生标线。每段条带只有四个顶点、两个三角形，附沿线距离、颜色、周期和占空比；材质按距离计算哪些位置显示油漆。主街面标线放在 `y=0.012` 米，避免与沥青共面争抢深度。这种方式既不是逐段下载图片，也不是每截虚线放一个立方体。[正式装配](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/main.js#L135-L143) · [条带几何](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-paint.js#L9-L99) · [油漆材质](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L2113-L2172)

| 标线 | 代码里的规则 |
| --- | --- |
| 同向车道白虚线 | 宽 0.13 米，12 米一个周期，25% 显示，即约 3 米线加 9 米空隙 |
| 双向中心双黄线 | 两条各宽 0.11 米，中心偏移 ±0.12 米；跳过不应跨越的中央障碍 |
| 停止线 | 宽 0.45 米，放在到达路口的车道末端附近；普通道路弯折节点不画 |
| 斑马线 | 路缘到路缘的条带，横纹周期 1.2 米、显示比例 50%，过街带深度约 2.2 米 |
| 绿色自行车带 | 只在满足宽度条件、至少四车道的单向大道上加 2 米宽绿带 |

这些是纽约模拟参数，不是可直接套到深圳的标线标准。[具体参数](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-paint.js#L145-L186) · [过街宽度常量](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-network.js#L23)

标线按 1200 米格子合批，每段最长 200 米，远处淡出与剔除；着色器还计算边缘磨损、湿润和细线的屏幕宽度补偿。可借鉴的是“语义位置由路网决定、画法由共享材质决定”。纽约主街使用平面标高，深圳坡路与高架需逐顶点取自己的活动表面高度，不能直接复制 `y=0.012`。[分块与材质](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-paint.js#L12-L99) · [远景过滤](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L2127-L2172)

### 人行道的形状与板缝是两层

矩形街块用实例化板体，非矩形街块按多边形挤出，人行道顶为 0.22 米，顶面内缩约 0.25 米露出路缘；板缝和污渍在 TSL 中按世界坐标生成，例如 1.524 米板格、6 毫米缝。板缝观感不意味着每块板都有实体高差。非矩形街块给部分矩形消费者的覆盖是近似矩形集合，也不是完整导航网格。[人行道几何](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/city-grid.js#L1543-L1620) · [人行道材质](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L2175-L2225)

## 7. 红绿灯怎样放置和驱动

灯杆、横臂、灯箱使用重复几何和实例矩阵；车灯是三个圆形灯片，灯片材质按时钟显示红、黄、绿。人行灯有独立灯箱和矩形面板，放在约 3.15 米高处。当前人行面板只是白色/橙色/闪烁的整片颜色，注释虽写 WALK/手掌，实际材质没有绘制完整人形或手掌图案。[灯材质](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/street-details.js#L49-L101) · [灯具与安装](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/street-details.js#L148-L315)

显示与行为有共同来源：每帧将同一个 `elapsed` 传给信号显示和交通系统；二者使用 `SIGNAL_TIMING`。周期 60 秒，大道先绿 26 秒、黄 4 秒，横街在后半周期绿 26 秒、黄 4 秒。行人各方向在对应绿灯最初 7 秒可以开始过街；已经走入车道的人继续走完。NPC 还检查来车、占用和能否停车，不是只见白灯就进入道路。[时钟接线](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/main.js#L698-L713) · [时序定义](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/city-config.js#L707-L726) · [过街权限](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/traffic.js#L814-L831)

但有两处重要简化：所有路口用全局同步相位，没有实际逐路口配时；当前人行灯面板统一接大道方向相位，NPC 过街权限却支持两方向。故“显示和行为共用时钟”不等于“双向灯具都已正确显示”。成功放置灯杆的路口才进入 `signalIntersections`，路网再据它标记信号节点。[人行面板接线](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/street-details.js#L240-L298) · [信号节点绑定](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-network.js#L1024-L1027)

## 8. 行人是不是走固定路线

**NPC 使用预计算并缓存的路径段，但整段旅程不是固定脚本。** 它是“沿街轨道、路口连接、随机目的方向、局部绕障”的组合；玩家自由步行另算。

1. **沿街路径：** 道路两侧各有两条常规轨道，位于路缘外约 1.7 米、2.8 米。路径需通过约每米一次、半宽 0.4 米的扫掠检查，并留在同一街块；结果按需生成后缓存。[轨道构建](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-routes.js#L3-L46)
2. **过街连接：** NPC 的过街轨道只在信号路口生成，两端各伸上人行道约 2 米，要求两端有效、路径无静态障碍。画了斑马线并不自动保证有对应 NPC 过街轨道。[过街路径](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-routes.js#L49-L67)
3. **局部选路：** 随机从附近道路取目标，每 120–300 秒或距目标小于 25 米重选；接近路径末端时，按目标方向、随机扰动和掉头惩罚选择下一段。没有全城最短路；无后继才掉头，所以不能说全体 NPC 都只走固定往返线。[目标更新](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-system.js#L383-L405) · [连接选择](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-routes.js#L156-L207) · [掉头](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-system.js#L480-L500)
4. **静态绕障：** 被挡后先尝试 ±0.6/±1.2 米偏移，再在最大横向 ±2.4 米的窄条内搜索折线；仍必须在人行道内、靠近街块边缘。彻底封死会拒绝路线，不会随意借车道绕行。这是局部避障，不是任意广场、公园、楼梯都能自由寻路的导航系统。[绕障搜索](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-routes.js#L84-L153)
5. **动态行为：** 等灯包含个体反应延迟、排队和继续过街；对玩家驾驶的车/自行车有威胁预测、停跑/退让/侧扑，但不是所有动态对象的通用自由避障。[信号队列](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-system.js#L90-L111) · [动态躲避](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-system.js#L285-L369)
6. **数量与生命周期：** 使用玩家周边 340 人的对象池，附近生成、远处回收，每帧分批补充。人物外观和首选速度可按固定 hash 重现，但出生与选路含 `Math.random()`，因此不是整个过程都确定。[对象池和个体参数](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-system.js#L7-L56) · [更新预算](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-system.js#L623-L645)

玩家角色虽然共用人物骨骼表现，却由键盘/手柄自由移动、跳跃和碰撞处理，不查询 NPC 轨道或信号权限。两者脚底高度也分别按简化规则计算，并非统一读取所有可见表面。切换载具后，非活动玩家角色还有自己的短距离行走/折返逻辑，不能把它与 340 人的 NPC 路网混为一谈。[玩家移动](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/controllers.js#L1157-L1225) · [玩家地高](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/controllers.js#L870-L890) · [NPC 地高](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-system.js#L580-L588) · [非活动玩家](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/controllers.js#L1104-L1122)

障碍输入也未完全统一：NPC 收到 `streetDetails.footprints`，玩家的 `allColliders` 没有合入该集合；灯杆可进入 NPC 障碍，但当前树木/树池实例化没有对应追加 NPC footprint 的接线。因而不能从“算法能绕障”推导“所有树灯都不会穿”。[两套输入](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/main.js#L126-L148) · [灯杆预约](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/street-details.js#L195-L201) · [树木/树池](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/street-details.js#L933-L977)

## 9. 深圳应记录和借鉴的经验

以下是基于源码的迁移判断，尚未授权实施；已有深圳接口见 [建筑](../04-BUILDINGS.md)、[地标](../05-LANDMARKS.md)、[街道方案](../32-ROAD-NETWORK-AND-STREET-PLAN.md) 和 [区域风貌](../REGIONS-PLACES.md)。

| 经验 | 深圳应用方式 | 不能一起照搬的部分 |
| --- | --- | --- |
| 形体、立面、突出细节分层 | 保留源轮廓与高度，墙面用少量参数化家族，近景设备按需实例化 | 年代未知不能默认全玻璃；用途、材质和估计要保留不确定性 |
| 局部米制整窗格 | 墙宽决定完整窗数，角部和残缺层封边，内院/贴合墙另处理 | 外观类别不代表真实住宅/办公用途，绘制的门不代表可进入 |
| 专模共用基础部件 | 复用材质、窗格、实例盒、屋顶设备和场地变换，只专做识别性轮廓 | 不采用整栋碰撞盒封死架空层；不按范围误删相邻源建筑 |
| 场所规则覆盖多个对象 | 商圈统一协调铺装、首层、广告、树灯与座椅，同时保留各对象身份 | 任意广告、街具概率和区域色不代表真实商业或开放边界 |
| 标线与行驶车道同源 | 先确定可驾驶断面、车道方向及路口，再派生线条与停止位置 | 不复制固定平面高度、纽约线宽/周期或右转规则当深圳事实 |
| 信号显示与通行共状态 | 每个路口、方向使用同一相位对象，联动车灯、人行灯、人车权限 | 不只同步计时而漏掉方向；不默认全城同相位 |
| 局部路线加可验证绕行 | 共用公共步行面及障碍表，检查角色宽度，提供过街与街角连接 | 不把路缘双轨当完整步行网，不让玩家/NPC/树灯各用一套障碍与地高 |
| 合批、缓存和实例池 | 普通楼按材质和空间合并；重复街具、设备、地标部件实例化 | 实例数、半径和编译注释都不是深圳性能收益实测 |

源码验证补充：纽约 `pedestrian-routes.test.cjs` 与 `pedestrian-signals.test.cjs` 共 10 项通过，零失败/跳过，覆盖局部绕障、封路拒绝、信号切换与过街连续性。这只是受控测试，未验证真实场景的障碍输入齐全、双向灯具显示或全城通行。深圳本轮仅更新研究文档与对应状态引用，未改运行代码或数据包。
