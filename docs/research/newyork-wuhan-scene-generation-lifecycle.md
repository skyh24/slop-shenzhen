# 纽约与武汉：场景位置来源、生成时机与运行成本

2026-11-13，只读源码研究。参考纽约上游 `2813185434ec4f11e105fff7fb87665fab81b558`（本地 `536a907` 的 JS 已核一致）与武汉 `7a62402a81f3cb50b38e664323f2cf7e4e132eac` 正式 runtime。本轮未改运行代码、未重建城市包、未做帧率实测。深圳工作区存在并行改动，本文只记录读取到的接口，不替其他任务更新性能或验收结论。

## 1. 两者都是混合方式，需要拆开三个问题

1. **位置来源：** 地图提供真实点、轮廓/边界，或者程序从道路/区域内生成模拟点。地图里有边界不等于每棵树、每盏灯都有真实坐标。
2. **模型创建：** 即使位置早已确定，浏览器仍需生成程序化几何、创建实例缓冲并上传 GPU。位置预定不等于完整模型预烘焙。
3. **运行阶段：** 静态物品通常不再重算位置，但仍有可见性、LOD、光照和 GPU 绘制；人群的位置、姿态和行为持续更新。

“按程序算出来”和“位置固定”可以同时成立：固定输入与种子能生成稳定布局，然后只维护显示状态。顺序随机生成还依赖输入顺序；不等于换数据、换轻量模式后仍逐树保持身份。

## 2. 各类对象对照

| 对象 | 纽约的位置/形态来源 | 武汉的位置/形态来源 | 主要创建时机 |
| --- | --- | --- | --- |
| 行道树 | `REAL_TREES` 读取纽约公园部门树点快照；启动时贴合模型路缘、去重/避障，树种和尺寸用表现规则 | 一般路侧树沿道路按间距生成，中央带按道路间空间判断，经过占位和碰撞筛选；不是逐树测绘表 | 两者主要在启动生成树位结果和实例；移动时通常不重新种树 |
| 公园/林地植被 | 公园边界、人工布局、排植和固定 hash 网格散点，避开草坪、道路、水体等；外围街区另有程序植被 | 从 `GEO.park/forest` 多边形按密度和固定随机种子散点，另有重点街景配置 | 启动布局；不是每帧全园重算分布 |
| 普通建筑 | 曼哈顿有源轮廓/高度，立面和设备程序生成；外围街区含模板生成楼，不能说全纽约逐栋来自真实足迹 | `BUILDINGS` 提供足迹和高度等字段，含源值与估计；浏览器挤出墙/屋顶并加入类型细节 | 主体主要启动构造，之后剔除和绘制 |
| 建筑近景 | 启动准备各楼细节描述，使用四叉树查询附近楼，把细节写入预建实例池 | 正式 `buildCityBlocks` 在启动构造楼体、屋顶及相应细节，其返回的 `update()` 为空 | 纽约移动时换活跃实例；武汉这一路径没有同等建筑细节流式创建 |
| 路灯/一般设施 | 大量灯杆按街块路缘、路口和规则放置，部分特殊设施为人工配置 | 灯杆和特色街具主要在启动沿道路推导；商铺招牌的贴墙坐标已离线派生入包 | 两者大量在启动创建模型，之后更新灯光/信号与可见性 |
| 行人 | 启动建固定人物池；在附近可用道路和缓存路径上生成，持续移动、选路和回收 | 启动建固定人物池和候选路段网格；附近随机出生，沿所选路段运动、折返和回收 | 动态模拟，不是地图上提前固定的一群人物 |

来源：[纽约树点数据](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tree-geodata.js#L1-L5)、[树点适配](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/tree-placements.js#L8-L88)、[公园树布局](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/street-details.js#L816-L940)、[武汉树布局](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/street-props.js#L91-L160)。建筑生成的具体真实性边界另见[纽约场景调研](slop-newyork-scene-techniques.md)。

武汉重点江汉路街景也不是预存整份花箱树点：`placementData` 提供道路、地标和空间限制，启动时沿江汉路按间距计算 `focusTrees` 并并入树实例。另一方面，商铺招牌坐标确实由离线工具关联附近墙面后写入数据。这两类固定位置的产生阶段不同，且都不能自动称为实测设施。[特色街景](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/wuhan-streetscape.js#L17-L58) · [招牌离线生成](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/tools/runtime_signs.py#L54-L92)

## 3. 树木：双方都预建三档 LOD，区别在查询与更新粒度

纽约 `createTreeField` 启动生成树种×变体×三档 LOD 的共享几何，建立树位及 200 米分块，并为对应实例批次分配容量。相机位移不足 4 米跳过 LOD 重算；达到阈值后仍遍历全部树块，先用块包围球判断整块所属层级，只有跨层级边界的块才逐树算距离。仅变化块重排和上传活跃实例范围，固定池容量不随移动反复创建。[资源创建](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/trees.js#L865-L970) · [实例与更新](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/trees.js#L1014-L1220)

武汉也预建三档 LOD，位移阈值同为 4 米，但正式树模块达到阈值后遍历全部 `N` 棵树；只要 LOD 有变化便重组整体实例集合。它不是按新区重新生成树位，却可能产生 CPU 距离计算和实例上传成本。[武汉树更新](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/trees.js#L839-L970)

两者都有最远退出距离：近/中档分界约 105/420 米，按树位层级给出 3000/1600/950 米最远距离；相机低于 40 米时还限制到最多 1150 米，并带滞回。实际使用哪些层级取决于调用方；这些是项目参数，不是统一性能最优值。退出这里主要是隐藏/减少活跃实例，**不等于销毁全部预分配资源或卸载数据**。[纽约阈值](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/trees.js#L808-L815) · [武汉阈值](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/trees.js#L811-L817)

## 4. 行人：不是固定人口点，两边也并非同一查询方式

纽约默认 340 人池，人物外观部分由固定 hash 确定，出生和选路含动态随机。附近交通边和信号候选由 `traffic.refreshNear()` 提供：水平移动约 40 米后，仍遍历交通系统的全部 edges/nodes 筛选约 350 米内候选。步行轨道、路口和连接另外按需缓存；常规每帧最多尝试补 6 人，跳跃/传送情形可放宽到全池。固定池限制活跃数量，不代表路网查询自动局部化。[候选扫描](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/traffic.js#L624-L643) · [人物池/补充](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-system.js#L623-L658) · [路径缓存](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/pedestrian-routes.js#L1-L76)

武汉默认 260 人、轻量模式 80 人。启动时一次遍历路网构造候选，把每条路段按中点放进 100 米网格；出生时在玩家附近随机取格、取路段，每次最多 6 次尝试。人物远于约 300 米回收。这个局部索引比反复全路网筛选更直接，但只按中点登记长路段可能遗漏“中点很远、端部很近”的候选；它也不代表完整的面内导航或全城人流模拟。[武汉候选与出生](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/traffic.js#L472-L515) · [运动与回收](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/traffic.js#L807-L830)

## 5. 建筑和设施：移动时“换实例”与“造模型”不同

纽约曼哈顿主体在启动生成；细节布局描述也在启动计算并插入四叉树。檐口、水箱、空调、雨棚等预建有容量上限的共享实例池，移动至少 18 米后查询约 560 米内建筑，排序并更新池中的实例变换与有效上传范围。它主要把重布局和基础资源创建放在启动，移动时更新有限实例；仍可能产生查询、排序和上传尖峰，不能说零成本。[细节预计算](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L343-L380) · [固定池](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L494-L651) · [附近更新](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/buildings.js#L685-L810)

武汉正式楼体模块启动遍历 `BUILDINGS`，生成合批墙面、屋顶和类型细节，最后返回空的 `update/updateLights`。一般街具也在 `buildStreetProps` 中集中创建；少了移动时造这些模型的工作，代价转向启动时间与常驻内存，不代表更省总资源。[武汉楼体](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/buildings.js#L130-L279) · [武汉设施创建](https://github.com/LightYearZh/slop-wuhan/blob/7a62402a81f3cb50b38e664323f2cf7e4e132eac/js/runtime/street-props.js#L545-L575)

纽约灯杆位置/模型大多启动计算，其实际附近光源用 128 米网格查询，最多复用 36 个聚光灯与 48 个点光源。要把“灯杆网格”和“会照亮物体的光源”分开：前者仍参与普通场景剔除，后者不必全岛扫描。纽约通用 `updateSceneCulling` 本身仍每帧遍历登记的全部剔除条目，所以不能笼统说纽约没有全分块扫描。[路缘灯杆](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/street-details.js#L337-L370) · [光源池与查询](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/street-details.js#L995-L1078) · [通用剔除](https://github.com/mrdoob/slop-newyork/blob/2813185434ec4f11e105fff7fb87665fab81b558/js/scene-culling.js#L352-L361)

## 6. 对深圳所列四项成本的判断

| 当前关注点 | 对照所得结论 | 可采用的方向，尚未实施 |
| --- | --- | --- |
| 树灯遍历全部分块 | 纽约也存在全块粗查，武汉树还逐树检查；地图坐标提前确定不会消除此成本 | 建分块空间索引，维护附近候选与上次活跃集合；移动阈值、块级快速判定、变化项更新配合使用 |
| 三档 LOD 预建、远景无退出上限 | 双方也预建三档；差别在资源共享、固定池、更新范围和明确的最远退出 | 共享树种几何；按植物尺度/用途配置退出距离与滞回；区分停止绘制与释放内存 |
| 每移动约 100 米全路网筛选行人候选 | 纽约有类似全扫描，只是阈值约 40 米；武汉已建立局部网格 | 启动或构建期按路段包围盒/经过网格建索引，查询附近路段后精筛，缓存可用静态轨道；不只登记中点 |
| 有任务预算但单次建模仍尖峰 | 纽约建筑细节更多是预算布局＋共享模型＋实例更新；武汉更多在启动做完 | 将规划、几何构造和实例上传分成有界步骤；复用现有资源；预算须能在批次间让出，单个同步任务无法靠外层计时中断 |

本轮读取的深圳 `sz-vegetation.js` 为树批次设置 `maxDistance = Infinity`，`sz-street-lamps.js` 遍历灯块，`sz-pedestrian-tracks.js` 仍遍历 graph.links 筛选，`sz-building-details.js` 在同步 `buildChunk` 之间检查时间预算，与用户提出的方向相符。这里没有测量它们各占多少帧时，不能仅凭循环规模排序最终瓶颈。[新增植被](../../js/sz-vegetation.js) · [路灯](../../js/sz-street-lamps.js) · [行人轨道](../../js/sz-pedestrian-tracks.js) · [建筑细节](../../js/sz-building-details.js)

静态布局若离线生成，应保存稳定实例 ID、源对象/来源、预设、位置/朝向/尺度、所属分块与表面引用；保留模拟属性。浏览器加载附近实例并共享资源，实际人物状态仍运行时模拟。模型首次创建、GPU 上传和材质编译是不同阶段，不能把固定坐标或预建 JavaScript 对象等同于所有 GPU 工作已完成。

关键取舍是把工作安排在合适阶段：真实数据与稳定模拟布局可预处理，静态共享模型可复用，移动时尽量局部查询和更新实例，每帧只推进活跃状态及必要渲染。是否改为离线布局或扩大常驻池，要以深圳启动、内存和移动帧时对照决定，不能仅凭纽约/武汉的组织方式宣称性能更优。
