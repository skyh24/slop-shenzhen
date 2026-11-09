# 车公庙立交桥面

核实于 2026-11-10。这里记录车公庙立交范围内的桥面与匝道补充模块，解决 `js/sz-roads.js` 只生成地面道路、桥面与跨层匝道在 3D 世界里缺失的问题。

## 身份

- 位置：福田区车公庙，香蜜湖路与深南大道、滨河大道交会一带。默认覆盖矩形 `x -3800..-2500`、`z 500..1300`（米，原点为市民中心主楼）。
- 范围：只补齐矩形内与地面道路不重复的桥面/跨层 link；不是全市立交总成。
- 模块：`js/sz-elevated-roads.js`。导出 `planElevatedRoads`、`buildSzElevatedRoads`；不修改 `js/sz-roads.js`。
- 可靠性标记：所有桥面 `heightSource` 为 `estimate`，统计与接触面都带这个字段，不冒充实测。

## 数据里有什么

- `GEO.roadGraph` 的节点是平铺 `x,z` 对；link 为 `[startNode, endNode, nameIndex, width, lanes, direction, innerPoints]`；`roadGraph.metadata[i]` 给出 `bridge`、`tunnel`、`layer`、`heightSource`、`osmId`。
- 当前共享包 `js/sz-city.json.gz` 有 11,238 条 link；`bridge === true` 498 条，`Math.abs(layer) > 0` 654 条。默认矩形按线段与矩形相交选路，共 37 条桥面/跨层 link、29 个 OSM way。
- 来源：OSM 锁定快照 `osm-guangdong` 的 link 平面几何、`width`、`lanes`、`direction`、道路名和 `osmId`。模块不重新拟合中心线，`roadLinkPoints` 与地面道路共用同一套节点和 inner points。
- 去重：与地面道路中心线完全一致的 link 会被跳过，避免同一段路在地面和桥面各画一层。

## 什么是估计的

- 桥面高度：没有实测纵断面。端点节点若同时属于地面道路，按该点地形高程落地（匝道接地）；否则按 `地面高程 + 4.8 × max(0, layer)`。两个端点之间按长度线性插值；地形在 link 中部抬升时以地形为下限，避免桥面埋入地下。
- 梁体：桥面顶面按 link 宽度生成带状三角面，两侧各加 0.35 米梁腹板，端部封口。
- 桥墩：沿中心线约每 28 米取一个位置，桥面净空大于 2 米才设方形墩；墩位、截面和基础均未按地勘核实。
- 渲染：无纹理，`MeshStandardNodeMaterial` 沥青色、`polygonOffset`；按空间分块合并，最多 12 个网格。
- 接触面：每条 link 一个 `{ id, heightSource: 'estimate', triangles: [[p, p, p], ...] }`，顶面三角形与渲染几何同源，可直接交给 `createSurfaceResolver`。
- 统计中的 `maxDeckHeightM` 是桥面顶相对中心线地形的最大净高，不是绝对高程。

## 接进 `main.js`

在 import 区加入：

```js
import { buildSzElevatedRoads } from './sz-elevated-roads.js';
```

在 `buildSzRoads` 之后创建：

```js
const roads = buildSzRoads(scene, GEO.roadGraph, GEO.terrainSurface);
const elevatedRoads = buildSzElevatedRoads(scene, {
  graph: GEO.roadGraph,
  terrainSurface: GEO.terrainSurface
  // area 可省略，默认 { minX: -3800, maxX: -2500, minZ: 500, maxZ: 1300 }
});
```

控制器接收桥面接触面：

```js
const controllerManager = new ThirdPersonControllerManager(scene, colliders, {
  groundHeight: (x, z) => roadFrontage.contactHeight(x, z) ?? ground.groundHeight(x, z),
  surfaces: [...landmarks.surfaces, ...elevatedRoads.surfaces],
  nearTraffic: traffic.nearColliders
});
```

加进剔除根节点：

```js
const cullingRoots = [ground.group, roads.group, elevatedRoads.group, cityBlocks.group];
```

销毁时调用：

```js
elevatedRoads.dispose(); // 从场景移除 group，释放分块 geometry 和共享材质
```

## 验证级别

- 数据里有：`roadGraph.metadata` 的 `bridge/layer` 与 `heightSource: 'unresolved'` 已在共享包。
- 生成器生成了：`planElevatedRoads` 在真实共享包上得到 37 条桥面/跨层 link、6,018.55 米桥面、47,261.03 平方米、37 个接触面、10,876 个渲染三角面、147 个桥墩，`maxDeckHeightM` 18.95 米。
- 挂进场景：本轮按约束未改 `main.js`；上面的接线片段是待执行步骤。
- 浏览器画面：未验收。真实 three.js `0.187.0` 构建测试已通过：12 个分块网格、材质、射线命中桥面顶、`dispose` 后 `group.parent === null`。
- 通行：`createSurfaceResolver` 集成已在测试中验证；没有在浏览器里实际开车或步行通过车公庙匝道。

## 已知缺口

- 没有车公庙立交的实测桥面纵断面或设计线形。4.8 米/层只是按 OSM `layer` 的估算，不能当测量值使用。
- OSM 的 `bridge` 高度全部是 `unresolved`，共享节点处的落地判断也依赖地形，不是桥梁设计图。
- 没有把桥面接入车辆路径规划或交通流；车辆目前只在 `js/sz-roads.js` 的地面路网上行驶。
- 只覆盖车公庙默认矩形。矩形外的桥、隧道和全市其他立交不在本模块范围内。
- 两端都接地面道路的 link 会被压到地形上，可能读不出跨线净空；这是当前估算规则的局限，需要设计纵断面资料才能修正。
- 桥墩数量、位置和基础形式均为视觉估计，未做结构或地勘核实。
