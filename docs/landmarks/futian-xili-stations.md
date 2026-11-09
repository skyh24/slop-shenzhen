# 地铁出入口、福田站地面部分与深圳西丽站在建工地

核实日期 2026-11-09。本文对应硬性要求 [3.4 地铁线路](../11-MVP.md) 的“每个出入口按真实位置建模”和 [3.5 高铁站](../11-MVP.md) 的两处地面设施。数据来自共享包 `js/sz-city.json.gz`：地铁出入口、车站和线路由 OSM 快照 `osm-guangdong`（`guangdong-261108`，2026-11-08T23:59Z，[sources.json](../../data/source/sources.json)）按 `network=深圳地铁` 过滤；福田站站体、西丽站场地来自 [landmarks.json](../../data/source/landmarks.json) 已核对的 OSM way。

- 福田站：OSM [`way/800275814`](https://www.openstreetmap.org/way/800275814)，广深港高铁地下站，足迹 135,173 平方米、周长 5,752 米。
- 西丽站：OSM [`way/402048868`](https://www.openstreetmap.org/way/402048868)，在建，场地 66,201 平方米、周长 1,190 米。竣工计划 2028-12 见 [21 世纪经济报道（2026-06-02）](https://www.21jingji.com/article/20260602/herald/668f8304ef37b1cb76f27cf3c612ef49.html)。

## 数据口径：哪些是实测，哪些是示意

| 部位 | 来源 | 属性 |
| --- | --- | --- |
| 382 个地铁出入口坐标 | OSM `railway=subway_entrance` 节点，`positionSource = osm-node` | 实测点位 |
| 出入口所属车站、中文站名、出口编号 | OSM 车站/线路关系与出入口 `ref`、`name`，按线路交集优先、距离次之关联 | OSM 关联结果，有缺站名的情况见“已知缺口” |
| 出入口线路与颜色 | OSM 线路 `colour` 标签（如 1 号线 `#00AB39`、4 号线 `#DC241F`） | 官方线路色，来自 OSM |
| 雨棚尺寸 4.5 × 2.8 米、高 2.6 米，石基座、玻璃顶、站名牌 | 深圳地铁出入口常见尺度的统一原型 | 外观示意，不是逐口设计 |
| 出入口朝向 | 面向最近车站方向；无车站时用实体 ID 哈希角 | 展示参数，不是实测朝向 |
| 福田站地面亭 6 座、采光天窗 2 座 | 沿真实站体足迹外环等距、内退 6 米布置 | 位置/朝向为示意；足迹本身是 OSM |
| 西丽站围挡、塔吊、基坑、临时道路 | 按足迹和“在建”状态程序化生成 | 全部 `heightSource = estimate` |

所有模块内几何都标 `heightSource = 'estimate'`；没有把估计值写成实测值。福田站为地下站，本模块**只建地面部分**：出入口亭、采光天窗和站名标识，不建站房、站台、轨道或列车。西丽站**不建假站房**，只按工地表达。

## 地铁出入口（`js/sz-metro-entrances.js`）

`planMetroEntrances(metro)` 把 382 个 OSM 出入口关联到 81 个车站中的最近车站：先按 `lineRefs` 是否有交集，再按距离，最后按 OSM id 排序，保证同一数据每次结果一致。站名优先取关联车站名，其次取出入口自身 `name` 去掉“A 出口”等后缀，最后取 `stationNames`；线路色只保留 OSM 线路表里能查到官方 `colour` 的线路。没有站名或没有可用线路色的入口进入 `unresolved`，不生成模型。

当前真实数据结果：

| 项目 | 数量 |
| --- | --- |
| OSM 出入口节点 | 382 |
| 成功关联并生成 | 377 |
| unresolved | 5（石厦站周边只写出口字母、OSM 无对应车站名的节点） |
| 覆盖站名 | 68 个 |
| 官方线路色 | 12 条线有出入口（1、2、3、4、5、7、8、9、10、11、13、14） |
| 站名牌贴图 | 2048×1024 图集，72 个中文站名格、40 个出口字母格，共 1 张 CanvasTexture |

`buildSzMetroEntrances(scene, metro, options)` 在每个实测节点中心放一座石基座加玻璃雨棚，并按 500 米分块实例化：

- 每条入口用中心加四角共 5 个探针取 `groundHeight`，任一点无效、落在 `roadHeight` 车行道、落在铺装 `pathAt`、落在水面 `isWater` 或与建筑 `colliders` 相交时跳过，并计入 `statistics.skipped`。
- `y` 取 5 个探针的最低值，和渲染地面共用同一个 sampler；站名牌的 LOD 用 TSL 按相机距离切换：小于约 450 米显示带文字站名牌，450–1200 米只显示纯色牌，超过 1200 米不画。
- 雨棚底座生成 `{ type: 'metro-entrance', polygon, minY, maxY }` 碰撞体，供玩家碰撞。
- 用全量道路面和 38,057 个建筑碰撞体预演：放置 286 个，跳过建筑 80 个、车行道 11 个。跳过的是真实节点落在 OSM 建筑轮廓或车行道内的位置，按规范不硬配。合成地面测试环境下 377 个全部放置。

站名牌是暗绿底、白色中文站名、底部官方线路色条和出口字母牌；不使用运营方标志。朝向、雨棚外形、玻璃分格都是统一的展示原型。

## 福田站地面部分（`buildFutianStation`）

站体足迹是 157 个顶点的长条形地下站轮廓，包围盒约 797 × 1,052 米。沿外环按周长等分布置 6 座地面亭（4.5 米开间尺度放大到 7 × 5 × 3.6 米的玻璃亭），全部四角在真实足迹内、退界至少 4.2 米；另在足迹内放 2 座 12 × 8 米低矮玻璃采光天窗。地面亭站名牌写“福田站 / 广深港高铁 · 地下站”，明确这是地下站地面部分。

| 项目 | 数值 |
| --- | --- |
| OSM 站体足迹面积 | 135,173 平方米 |
| 足迹周长 | 5,752 米 |
| 地面出入口亭 | 6（`statistics.entrances`，测试要求 4–8） |
| 采光天窗 | 2 |
| 碰撞体 | 8（6 座亭 + 2 座天窗） |
| 绘制调用 | 约 6 |

地面亭间距约 960 米，是沿真实足迹的展示布点，不是 6 个真实福田站出入口的实测位置；真实地面出入口的逐口位置和造型缺影像与设计资料。采光天窗位置同样为示意。

## 西丽站在建工地（`buildXiliConstruction`）

西丽站场地是一个约 449 × 149 米的四边形，场地内按在建工地表达：

| 项目 | 数值 | 属性 |
| --- | --- | --- |
| 场地面积 | 66,201 平方米 | OSM 足迹 |
| 场地周长 | 1,190 米 | OSM 足迹 |
| 围挡总长 | 1,174.4 米、76 段 | 沿足迹外环分段，留 9 米大门；尺寸为示意 |
| 围挡高/厚 | 3 米 / 0.25 米 | 示意 |
| 塔吊 | 2 台 | 布点按多边形内最大净距 + 确定性排序；示意 |
| 塔吊塔身/起重臂/平衡臂 | 64 m / 49 m / 14 m；63 m / 48 m / 16 m | 落在任务要求的 55–65 m、40–50 m 区间；示意 |
| 基坑 | 内缩 18 米，面积 46,080 平方米，深 6 米 | 内缩和深度按任务要求，不是施工图 |
| 桩基 | 16 个混凝土桩头 | 示意 |
| 临时道路 | 44.4 米 | 大门接基坑方向；示意 |
| 碰撞体 | 82（76 段围挡 + 2 台塔吊 + 4 段坑口钢板桩） | 供玩家碰撞 |

围挡板为白色板加蓝色底带，内侧用 CanvasTexture 画“深圳西丽站 在建”“施工重地 谢绝入内”，未使用 APEC 会徽或其他官方标志。场地内铺一层土色面，基坑口有一圈 1.8 米高钢板桩、深色开挖面和露出的桩头。

**基坑与地形的已知矛盾**：共享地形没有为西丽站场地裁洞，6 米深的坑底和坑壁会被现有地形网格盖住。模型仍按任务要求建了 6 米坑底和四周挡土墙，画面用坑口钢板桩、深色开挖面和桩头表达“开挖中”。要让 6 米坑壁真正露出，需要后续在地形管线（`tools/sz/build.py` 的地形排除流程，参考春茧的 terrain-exclusions 做法）为 `way/402048868` 裁出 46,080 平方米量级的基坑洞口（或整个 66,201 平方米场地），并重新生成共享包。在那之前不宣称基坑在浏览器里可见 6 米深。场地土色面因此取地形采样 +0.04 米并加 polygonOffset，而不是规范里“低于周边 0.05 米”：低于地形会被地形本身遮住。

## 绘制调用与碰撞

| 模块 | 绘制调用估算 |
| --- | --- |
| 全市出入口 | 102–116 个分块结构实例 + 1 个全市玻璃雨棚实例 + 2 个全市站名牌网格（近/远 LOD）≈ 105–119 |
| 福田站地面 | 6（亭基座、框架、玻璃、站名牌、天窗框架、天窗玻璃） |
| 西丽站工地 | 6（场地土色面、围挡、围挡文字、塔吊、基坑、临时道路） |
| 合计 | 约 117–131，低于本任务 < 150 的目标 |

出入口雨棚基座、玻璃和站名牌共用材质；全市站名牌只用一张 CanvasTexture（文字）加两个网格。塔吊、围挡、基坑各自合并成一个顶点色网格。全市出入口和福田站地面亭不投影（`castShadow = false`，只接收阴影），避免阴影级联额外绘制数百个出入口分块；西丽站的围挡和塔吊会投影。

碰撞体与显示使用同一份足迹/尺寸参数：出入口底座、福田亭和天窗、西丽围挡/塔吊底座/钢板桩都可以参与玩家碰撞；西丽基坑底是展示面，当前不做下沉地形接触，玩家不会真的掉进坑里。

## Lead 集成说明（`js/main.js`）

建议在 `streetscape` 之后、`trees` 之前创建，这样出入口碰撞体能参与树木避让；如果放在 `trees` 之后也能运行，只是树木不会避让入口。`createCitySpatial` 可选，用来做水面和范围判断。

```js
import { buildSzMetroEntrances } from './sz-metro-entrances.js';
import { buildFutianStation, buildXiliConstruction } from './sz-station-sites.js';
import { createCitySpatial } from './sz-spatial.js';

// 依赖已就绪：ground.groundHeight、roads.roadHeight、streetscape.pathAt、buildings colliders
const spatial = createCitySpatial(GEO);
const isWater = (x, z) => spatial.isWater(x, z) === true;
const metroEntrances = buildSzMetroEntrances(scene, GEO.metro, {
  groundHeight: ground.groundHeight,
  roadHeight: roads.roadHeight,
  pathAt: streetscape.pathAt,
  colliders: [...buildings, ...streetscape.colliders, ...roadFrontage.colliders],
  isWater
});
const futianStation = buildFutianStation(scene, GEO.sites?.['futian-station']?.station, {
  groundHeight: ground.groundHeight,
  colliders: buildings
});
const xiliConstruction = buildXiliConstruction(scene, GEO.sites?.['xili-station']?.site, {
  groundHeight: ground.groundHeight,
  isWater
});

// 与现有 colliders 合并
const colliders = [...buildings, ...streetscape.colliders, ...roadFrontage.colliders, ...trees.colliders,
  ...metroEntrances.colliders, ...futianStation.colliders, ...xiliConstruction.colliders];

// 静态几何参与场景分块剔除（各自是独立 group）
setupSceneCulling(scene, [...cullingRoots, landmarks.group, bridge.group, streetscape.group,
  roadFrontage.group, streetLamps.group, trees.group, apecTheme.group,
  metroEntrances.group, futianStation.group, xiliConstruction.group].filter(Boolean), lightingSystem.sunLight.shadow);

// 每帧更新：出入口按相机距离切换分块和站名牌 LOD；福田站只切站名牌；西丽站无需逐帧更新
metroEntrances.update(cameraSystem.camera.position);
futianStation.update(cameraSystem.camera.position);
xiliConstruction.update();
```

如果不想引入 `createCitySpatial`，也可以省略 `isWater`（OSM 出入口本身都在陆地上），或者用已有水面的 bbox 先做粗筛再 `polygonContains`。若把本模块放到 `trees` 之后，记得把三组碰撞体追加到 `colliders` 数组，并确认 `controllerManager` 在合并之后创建。

卸载时按创建顺序逆序调用各模块的 `dispose()`（会从 scene 移除 group 并释放几何、材质、CanvasTexture），再移除分块剔除引用。

## 已知缺口

- **出入口关联**：5 个石厦站周边节点（`node/5187499025`、`5187499038`、`5187499048`、`5187499062`、`5187499098`）只写出口字母，OSM 快照里没有同名车站节点，记 unresolved 不生成；需要后续核对 OSM 车站对象或人工补车站名。
- **出入口被跳过**：全量道路 + 建筑碰撞预演中 80 个节点落在 OSM 建筑轮廓内、11 个落在车行道内，按规范跳过。真实出入口很多位于商场或建筑内部，本模块只做街道级雨棚，室内出口需要建筑入口一体化建模。
- **逐口形态缺证据**：没有每个出入口的影像、顶棚形式、玻璃分格、灯箱样式；当前是统一原型。朝向取“面向最近车站”，不是实测。
- **站名牌资源**：一张 2048×1024 CanvasTexture，浏览器里文字随站点数和出口字母数变化；如果后续站点数超过 96 个站名格或 128 个出口字母格，需要扩展图集或换排布。
- **福田站**：地面亭沿 5,752 米足迹等距布置，间距约 960 米，是展示布点；缺少福田站真实地面出入口、采光井和下沉广场的逐座位置。地下站房、站台、广深港高铁线路走向不在本模块。
- **西丽站**：围挡长度、塔吊数量/型号/高度、基坑范围、桩基数量和临时道路都是示意；施工阶段与围挡样式会变化，竣工计划 2028-12 需要届期重核；APEC 期间（2026-11-11 至 21）工地围挡公益广告状态也需另行核实，本模块只画站点固定文字。
- **基坑地形**：共享地形未裁洞，6 米坑壁被地形遮住（详见上文）；需要地形排除管线配合，当前只是“开挖中”的外观表达。
- **接触**：出入口、福田亭、天窗、围挡、塔吊和钢板桩有碰撞体；基坑底和下沉面没有地形接触，玩家不会掉进坑里，也不应把它当可通行地下空间。

## 测试

```sh
node --test tests/sz-metro-entrances.test.cjs tests/sz-station-sites.test.cjs
SZ_THREE_PACKAGE_DIR=/Users/holder/Documents/ChatGPT/slop-shenzhen/.agents/three-0.187.0 \
  node --test tests/sz-metro-entrances.test.cjs tests/sz-station-sites.test.cjs
```

无 `SZ_THREE_PACKAGE_DIR` 时渲染几何测试干净跳过，规划/空结果测试仍然运行。测试覆盖：出入口关联数 > 250 且 unresolved < 80、确定性、线路色格式；放置后 `y` 等于 5 探针最低地面值、碰撞体数与放置数一致、分块与 LOD 行为、跳过原因；福田入口数在 4–8 且都在真实足迹内；西丽围挡总长 ≈ 周长 ±15%、2 台塔吊中心在场地内、基坑面积 > 0、无部件落水、缺 sites 时返回空结果不抛错。完整 `node --test tests/*.test.cjs` 共 384 个测试全部通过（2026-11-09，带真实 THREE）。
