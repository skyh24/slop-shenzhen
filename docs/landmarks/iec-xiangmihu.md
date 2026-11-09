# 深圳国际交流中心（香蜜湖）：当前模型与待验收项

2026-11-09。状态：程序化体量、材料、专项测试完成；**未接入 registry/materials/相机/apec 对齐**（由 Lead 统一接线），未做浏览器与碰撞实走。不是已复原的地标；全部是显式估计。

## 身份和来源

APEC 2026 领导人非正式会议主会场，据报道工商领导人峰会也在此举行，场地含五洲酒店。身份与用途来自 `data/source/landmarks.json` 的 `iec-xiangmihu` 条目（`apec.role`、`apec.sources`，核实日期 2026-11-09）：

- <https://www.shenzhen-guide.com/guides/apec-2026-shenzhen-visitor-guide>
- <https://hao.cnyes.com/post/277089>
- <https://news.mingpao.com/pns/%E4%B8%AD%E5%9C%8B/article/20261109/s00013/1794155294115/>

OSM 没有该会场已建成的建筑轮廓，只有院落与水面，因此几何全部程序化：

| 对象 | OSM | 用途 |
| --- | --- | --- |
| 场地 | `way/1080860977` | commercial 院落 135,649 m²，中心约 (-3120,-84) |
| 香蜜湖 | `way/25482483` | 湖面 221,166 m² |
| 香蜜湖公园 | `way/1361069232` | 湖畔公园 507,952 m² |

场地、湖面、公园轮廓来自共享包 `sites` 段（`sz-data-format.js` 解码为 `GEO.sites['iec-xiangmihu']` 的 `site` / `lake` / `lakePark` 三个 role）。**建筑体量、层高、场地分级没有任何设计图、总包图或竣工资料依据**，`heightSource` 一律 `estimate`，`sourceId` 为合成 id `site:iec-xiangmihu`，不能当实测或竣工尺寸引用。

## 程序化形态

`js/sz-landmarks/iec-xiangmihu.js` 用场地东北边界（离湖最近的边界顶点 (-2929.9,-195.0)）建立沿湖岸的局部坐标系：`u` 为向场地内的法向、`v` 为沿湖岸向东南的切向。全部体量用 `js/sz-landmarks/parts.js` 的 `footprintParts` / `loftPart` / `roofPanelPart` / `spanPart` 生成，显示与碰撞共用同一份几何。

| 体量 | 位置（frame u/v） | 估计高度 | 说明 |
| --- | --- | --- | --- |
| 入口平台 + 观湖台地 | u 4–112，v -48–20 | 台面 16.9→20.7 m | 3 级台地 + 2 组台阶（5 级/3 级） |
| 入口门廊 | u 8–20，v -26–18 | 30.9 m（柱顶） | 两片石柱 + 横梁 + 薄雨棚；门洞朝湖 |
| 旗杆阵列 | u 5.5，v -22–14 | 34.9 m（杆顶） | 9 根，杆顶挂纯红国旗面（无图案） |
| 主会议厅 | 足迹 u 112–222、v -104–86 | 檐口 46.7 m、屋脊 60.7 m | 大跨石材基座 + 玻璃幕墙 + 抛物线大屋盖（檐口相对台面 26 m、屋脊 40 m） |
| 宴会厅/多功能厅 | 足迹 u 118–202、v -178–-118 | 檐口 38.7 m、屋脊 43.5 m | 低于主厅，二层连廊与主厅相接 |
| 五洲酒店 A | u 240–286、v -164–-122 | 82.5 m（相对台面 66 m） | 三段收分 + 金属顶冠 |
| 五洲酒店 B | u 244–284、v -100–-62 | 67.1 m（相对台面 52 m） | 同上 |
| 五洲酒店 C | u 286–322、v -32–4 | 59.0 m（相对台面 42 m） | 同上；均在主厅之后，不挡入口轴线 |
| 酒店公共裙房 | u 236–292、v -122–-100 | 25.0 m | 低层连接体 |
| 香蜜湖花海台地 | u 72–104、v 70–102 | 台面 16.6 m | 草坪 + 石质围边，具体花丛由 APEC 模块实例覆盖 |

体量占比：场地内建筑体量约占场地 30%，主厅长轴平行湖岸，湖侧留出入口前场。所有体量顶点都在 `way/1080860977` 外环内（专项测试断言外扩 10 m 内、且不进入香蜜湖）。

专项结果：**97 个实体、7 种材质、1,072 个三角**（门洞、连廊、台地分 3 个部件，没有把架空/连桥填成整块）；整体绝对高程 11.1–82.5 m，最高体量相对本地地面约 66 m。

## 入口、花海与 APEC 主题对齐

以下常量供 `js/sz-apec.js` 的会场标识/花田与相机对齐（`js/sz-landmarks/iec-xiangmihu.js` 导出）：

| 导出 | 值 | 用途 |
| --- | --- | --- |
| `gatePoint` | `{x:-2942.59, z:-190.66}` | 入口门洞中心；APEC 立体字应放这里 |
| `gateYaw` | `2.3646` rad | 标识板朝向（板面法线朝湖） |
| `gateDeckY` | `16.9` | 入口台面标高；标识按地形落地会被埋 0.3 m，接线时应改用该高度 |
| `flowerSeaAnchor` | `{x:-2930.34, z:-71.95}` | 花海台地中心，离湖岸约 29 m |
| `flowerSeaDeckY` | `16.6` | 花海台面标高；`apecFlowerBeds` 的 bed 实例应按它落地 |

**注意方向问题**：任务描述写湖在“场地南/东南侧”，但共享包坐标以 z 向南为正，湖实际在场地**北/东北侧**（湖中心约 (-2785,-402)），场地离湖最近的边界在东北边。模型入口按“朝湖”优先，朝东北湖面布置；Lead 调整 `js/sz-apec.js` 时不要把立体字/花海放到场地南侧空地（那里是场地内部，看不到湖）。现有 APEC 模块的示意偏移（地标中心 +z 70 m / +z 55 m）落在主厅与酒店体量内，必须改用上面的锚点。

配色遵循 3.8：只用文字和中国红 / APEC 紫，**不画 APEC 官方会徽**；本模型不生成任何文字，只提供门架、旗杆、台地与草坪边界。旗面为纯红（无五星图案、无文字），APEC 道旗/立体字/花田由 `js/sz-apec.js` 负责。

## 集成

`js/sz-landmarks/layout.js` 增加一条定义（模块导出 `sourceIds = []`，场地经 `site` 键传入）：

```js
import { sourceIds as iecIds, optionalSkipIds as iecDuplicates, build as buildIec } from './iec-xiangmihu.js';

// definitions 里：
{ id: 'iec-xiangmihu', site: 'iec-xiangmihu', sourceIds: iecIds,
  optionalSkipIds: iecDuplicates, build: buildIec }
```

`site` 键会从 `sites['iec-xiangmihu']` 取到 `{ site, lake, lakePark }` 三个 role。**必须同时接 `optionalSkipIds`**：场地内仍有 34 栋既有通用楼（Overture/Globfp，最高 67.2 m）在运行包里渲染，不让位会与新体量穿模（ids 由当前共享包质心落在场地内的建筑导出，共 34 个）。

`js/sz-landmarks/materials.js` 的 `createLandmarkMaterial` 增加分派：

```js
import { createIecMaterial } from './iec-xiangmihu.js';
if (name.startsWith('iec')) return createIecMaterial(name);
```

未知 `iec*` 名称会抛错；7 种样式为 `iecRoof`、`iecGlass`、`iecStone`、`iecPlaza`、`iecHotel`、`iecGreen`、`iecFlag`。

建议相机（`FOV 58`，正午，北岸看会场）：

- `iecXiangmihu`：位置约 (-2892, 32, -330)，目标 (-2945, 24, -175)；在香蜜湖水面北岸向场地入口看。
- 全景机位：位置约 (-2800, 58, -430)，目标 (-3045, 26, -120)；从湖面西北侧看主厅大屋面 + 酒店群 + 湖岸线。

## 已知缺口

- **无设计图/竣工资料**：体量、层高、台地标高、酒店层数均为外观估计，不能作为测绘/验收依据；真实方案的大屋面形态、幕墙分格、酒店塔楼位置需等公开图纸后重核。
- **DSM 是表面模型**：场地内台地标高按各台地 DSM 均值取整（16.9/19.4/20.7/16.6 m），既有建筑与树木的残留在台地边缘会造成局部地形覆盖/穿插，未做场地平整。
- **场地内既有通用楼未清理**：34 栋 Overture/Globfp 通用楼仍在运行包内，必须靠 `optionalSkipIds` 让位；若 Lead 不接，新体量会与旧楼互相穿模。
- **未做浏览器验证**：按任务约束不使用浏览器，未确认画面、昼夜材质、阴影与碰撞实走；模型卡只到“生成器生成 + 单测通过”。
- **APEC 会期后状态**（2026-11-21 之后）与临时设施（安检、交通管制、转播）未建模，需按运营方公告重核。
- **水面/岸线**：水面由 `sz-sea.js` 渲染，模型只保证不侵入湖面；湖畔公园铺装、驳岸、亲水步道未建。
