# 纽约与武汉：道路标线为何有整洁度差异

2026-11-13，源码对照研究。这里的“线”按三维道路中心线、车道线、边线、停止线和过街线理解，不包括地图导航线路。未取得用户所见位置的同机位截图，因此下文确认的是实现差异及其可能视觉后果，不把所有“杂乱”归为已定位缺陷。

## 1. 结论

纽约对**道路身份、路口退距、弯道接头和虚线连续性**的整理更完整；武汉正式 runtime 主要按每条 link 单独铺线，路口采用较粗的节点半径裁切，跨 link 的连接与节奏缺少同等处理。武汉还自动增加慢车道边线及部分待行框，观感可能更密。这比“换一张更好的贴图”更接近代码层面的解释。

两者都有程序化标线、屏幕细线补偿及虚线滤波，不能说武汉完全没抗锯齿。纽约的规则也带有简化：网格道路整合、短连接合并、平面标高等不应直接移植到深圳的真实道路拓扑。

## 2. 版本与证据

- 当日 `git ls-remote`：纽约上游 HEAD 为 `2813185434ec4f11e105fff7fb87665fab81b558`，武汉为 `7a62402a81f3cb50b38e664323f2cf7e4e132eac`。
- 本地纽约参考为 `536a907c605964421563f12f15c5e00d735fc94f`；此前已核其 45 个 JS 文件与上述纽约上游一致，见[场景调研](slop-newyork-scene-techniques.md)。武汉本地参考与上述上游 HEAD 一致，两份参考工作区均无修改。
- 纽约正式接线是 `main.js → trafficSystem.network → buildRoadPaint`；武汉是 `index.html → js/runtime/main.js → runtime/road-paint.js`。武汉顶层旧文件不代表正式运行路径。[纽约入口](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/main.js#L135-L143) · [武汉入口](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/main.js#L90-L96)

## 3. 六个具体区别

### 3.1 先整理同一条路的多份表达，再决定画几条线

纽约先排除已被网格道路承载的中心线，处理分隔道路的两个方向，并对相同起终点的重复有向边保留一个优先对象。画线时再将同一对端点的正反向边归为一条物理道路，合并两侧车道后排序，只在相邻车道之间决定画白线或黄线；中间有分隔物时还有跳过逻辑。[路网整理](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-network.js#L251-L321) · [分隔路与重复边](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-network.js#L494-L534) · [物理道路分组](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-paint.js#L125-L162)

武汉画线遍历 `ROAD_LINKS`，从各 link 的单行、车道数和宽度生成标线；此处没有纽约上述物理道路归组。**这证明处理层级不同，不证明武汉所有相邻 link 都是重复道路。** 真正独立的主辅路、上下行分离车道和不同层级必须保留，不能按近距离直接去重。[武汉逐段生成](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/road-paint.js#L105-L150)

本轮直接加载武汉正式运行包复算：通过类型与长度筛选的 2,462 条 link 中，精确相同或反向相同的整条 XYZ 折线重复数为 **0**。检测以解码后的 Float32 点列及反序列归一成键；不覆盖近似重叠或不同采样的共线段。因此当前证据不支持把武汉的杂乱主要归因于“双向道路画了两遍”。

### 3.2 路口留白：纽约考虑夹角和汇入关系

纽约 `computeArms` 将进口、出口整理为路口方向，再识别普通弯折、斜交和分合流。`stopBack` 根据相交道路宽度与夹角计算退距，分合流还检查车道间是否达到足够横向距离；普通弯折不生成路口停止线和斑马线。其退距仍有上限和短路段折中，不能称任意路口都准确。[方向与退距](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-network.js#L606-L758)

武汉纵向标线在连接数至少 3 的节点退 `n.r + 3.5` 米，其他节点退 0.5 米；本函数不根据实际进口夹角求路口范围。斜交、宽窄变化和复杂分合流可能留白不足或过量。其独立 OSM 过街线、信号停止线/待行框分别生成，也没有在此统一裁切互相覆盖。[节点裁切](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/road-paint.js#L110-L121) · [过街与停止线](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/road-paint.js#L153-L200)

节点半径由所有连接路段的最大半宽加 0.5 米生成，计数包含步行分支。复算正式包 9,573 条 link，3,103 条通过标线类型筛选，其中 **641 条（约 20.7%）裁切后不足 3 米而跳过**，剩余 2,462 条进入标线分支。这是生成规则触发数量，包含合理的路口留白，不是 641 处已证实错误；它说明密集短段对当前退距规则很敏感。[半径生成](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/runtime_streets.py#L18-L40)

另一个值得优先验证的区别：武汉路面在构建时经过合并、建筑/水体裁切，但标线仍从 link 偏移生成，没有再裁到最终车行面。因此“沥青看起来连成一片”不等于“白黄线也按同一边界收好了”。字段 `roadPaintTrimmedM2` 在该生成器里统计路面/步行面裁切面积，不能拿它证明 runtime 白黄标线已经裁切。[路面裁切](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/spatial_rules.py#L52-L72)

### 3.3 弯道接头：纽约让两侧线真正接到同一点

纽约在普通弯折处匹配偏移、颜色、线宽及虚线参数相容的标线，求两条偏移线的交点，并限制接头延伸长度；匹配不成立就保留间隙，不让线无限伸向路缘。这是受限的斜接处理。[接头与限长](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-paint.js#L195-L241)

武汉的折线顶点用前后采样点之差求方向，再沿其法线偏移；没有在该生成器中计算偏移线交点，也没有跨 link 匹配接头。因此折点附近不能普遍保证到两侧中心线的偏移距离恒定，跨段端点也不保证重合。示例：等长两段构成直角时，角平分法线偏移 `d`，到每一段的距离只有 `d/√2`；这是算法说明，不是某个武汉路口的实测误差。[武汉偏移方式](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/road-paint.js#L30-L64)

### 3.4 虚线节奏：纽约跨已连接弯折延续，武汉逐 link 重起

纽约匹配接头后传播累计距离、相位和方向；相邻边方向相反也会修正。此连续性限于成功连接的标线，不代表全城所有路口都强行延续虚线。[相位传播](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-paint.js#L235-L259)

武汉 `strip(..., s0 = 0)` 在单条折线内部累计距离，但普通道路的调用没有传入跨 link 相位，每条重新从零开始。连续道路若被数据切成许多 link，接头可能出现不规律的空白和短划。不能误写为“每个折线顶点都重起”。[距离累计](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/road-paint.js#L30-L57) · [调用参数](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/road-paint.js#L124-L148)

### 3.5 画线密度：武汉规则额外画了一些东西

纽约普通同向白虚线为 12 米周期、25% 着漆；武汉为 10 米周期、40% 着漆。武汉还在双向主干道两侧添加慢车道实线，并在满足条件的信号进口增加待行框。其文件注释明确提及台湾标线模板，实际也保留相应规则；这不证明这些武汉进口确实有对应设施。[纽约线型](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-paint.js#L150-L186) · [武汉线型及待行框](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/road-paint.js#L124-L200)

所以视觉上更密的一部分是模板选择，并非必然几何错误。不能以两种虚线着漆比例推断全城标线数量或实际交通规范。

### 3.6 远景和坡面：共同抗锯齿，另外的差异要分开看

两者均将屏幕过细的线拓宽至约 1.5 像素并相应降低透明度，对虚线做像素覆盖滤波。纽约另外在约 1300–1650 米范围淡出，并结合标线分块距离剔除；武汉这个材质没有相同的距离透明度项，但它已接入场景剔除，不能说完全没有远景处理。[纽约材质](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tsl-materials.js#L2107-L2156) · [武汉材质](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/tsl-materials.js#L1770-L1817) · [武汉剔除接线](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/main.js#L161-L166)

纽约普通街道标线是固定平面高程；武汉标线顶点会按地形或桥面取高，场景更复杂。仅在顶点取高并不保证两个顶点之间的长三角形始终贴合下面的三角面；若用户看到的是断裂/闪烁，应另核网格剖分、坡面和深度，不直接归因于路网杂乱。[纽约平面](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/road-paint.js#L107-L118) · [武汉取高](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/road-paint.js#L50-L63)

## 4. 深圳应复用的公共能力

核查深圳基线 `a33a19b`：标线和交通已共同读取 `sz-road-section.js`，标线也已有受限斜接/斜切及自交处理；这些不是新任务。但 `sz-road-markings.js` 普通路口仍按 `min(width × 0.38, 7, length × 0.30)` 留白，普通虚线调用仍以相位 0 开始。[当前标线实现](../../js/sz-road-markings.js) · [共享断面](../../js/sz-road-section.js)

后续可在道路公共模块内分三步补足，作为道路专项研究输入，不扩张已完成 T13 的模块迁移验收：

1. **路口统一布局结果。** 从同层真实进口方向和共享断面派生停止位置、过街范围及可画线区域；各类标线消费同一结果。每条物理标线有稳定身份，合批前去重，保留主辅路和上下层区分。
2. **连续标线链。** 只有方向、线型、断面和层级相容的普通接续才连接；复用已有折线偏移，增加跨 link 端点匹配和沿链里程。进入真实路口或发生断面变化时允许终止，不强接全部线。
3. **少量有依据的线型与渲染参数。** 停止线、过街线和待行区根据对应语义生成；几何正确之后再调线宽、虚实比例、远景淡出。不得照搬纽约短连接合并距离，或通过删辅路、删车道、压平高程换取整洁。

验收至少覆盖直线接缝、弯道、锐角路口、T 字口、分合流、主辅路、上下层和坡面；分别检查重复线、越界线、接头间隙、虚线相位及远景闪烁。缺少具体画面时只提出候选原因，不给全城缺陷数量。

## 5. 本轮验证边界

纽约既有 `tests/road-paint.test.cjs` 的 3 项测试通过、零跳过，覆盖分块、长条带连续相位/坡面高度和材质缓存/淡出代码约束。它们不是复杂路口几何或实际画面的完整验证。武汉复算直接导入 `runtime/city-config.js`，按 `road-paint.js` 的类型、节点退距和剩余长度规则计数，未重建数据；本地详细笔记在 `docs/qa/road-line-research/wuhan.md`。本轮没有新增游戏浏览器实走，没有改运行代码或正式数据。
