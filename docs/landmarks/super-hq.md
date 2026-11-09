# 深圳湾超级总部基地：C 塔双塔、招银塔、展馆、车站与十字双轴

2026-11-09。状态：模型、测试和文档完成；registry / materials / 相机接线由 Lead 负责，浏览器 L4 画面验收未做。

这是全项目唯一一处有意按「建好形态」而不是按现状建模的片区：OSM 里 C 塔还没有几何，场地是 `landuse=construction`。模型不冒充实测，所有尺寸只标 `design`（公开设计值）或 `estimate`（按效果图比例拟合）。

## 身份和来源

| 角色 | OSM 对象 | 用途 |
| --- | --- | --- |
| 场地 `site` | `way/336349626` | 153,144 m² 的施工场地，长轴约 613 m（东西）、短轴约 266 m（南北） |
| 招银环球金融中心 `cmbTower` | `way/1443942674` | 真实建筑足迹，387 m / 75 层（`height: 387`、`building:levels: 75`，`building=commercial`） |
| 规划展览馆 `exhibitionHall` | `way/555593808` | `landuse=commercial` 院落地块，10,067 m² |
| 超级总部站 `metroStation` | `way/1349162932` | 地下二层车站轮廓（`location=underground`、`layer=-1`），只在地面做出入口 |

设计值来自 [`data/source/landmarks.json`](../../data/source/landmarks.json) 的 `super-hq.design` 段（核实日期 2026-11-09）：

- C 塔东塔 400 m / 73 层、西塔 336 m / 66 层，两塔在 119.15 m 高处由连廊相连，连廊下挂 33 m 倒三角结构，主体已封顶、幕墙施工中（Zaha Hadid Architects）。来源：
  - 广东省科技厅转《科技日报》2025-11-18《6000 吨连廊百米高空“牵手”》：<http://gdstc.gd.gov.cn/kjzx_n/gdkj_n/content/post_4801250.html>
  - 中建五局 2025-10-28 连廊合龙通稿：<https://5bur.cscec.com/5bur/oa/dtxw/202510/3911196.html>
- 连廊最大跨度 78 m、最大提升重量约 6000 t、整体提升高度约 120 m（同上两篇，11-MVP §3.7）。
- 招银：387 m / 75 层（OSM 登记值，不是测绘）；Foster + Partners 设计、折纸式三角玻璃、主塔加四栋副塔、地块 35,576 m²、总建面约 47 万 m²。媒体口径为 388 m（2025-07-19 亮灯报道）：<https://finance.sina.cn/2025-07-19/detail-inffzcmt0086775.d.html?vt=4>
- 深超总片区的「一心双核，十字生境」结构、中央绿轴为南北轴线：深圳新闻网 2021-11-23《最新设计公布！深圳湾超级总部基地“超级校园”长这样》<https://www.sznews.com/news/content/2021-11/23/content_24762588_0.htm>

以上链接只是设计/报道来源，不是测绘资料；照片未记录拍摄日期，拟合尺寸不宣称与实景一致。

## 模型口径：哪些是设计值，哪些是估计

| 内容 | 口径 | 说明 |
| --- | --- | --- |
| 东塔 400 m、西塔 336 m | `design` | 塔顶段（400/336 m 封顶件）标 `heightSource: design` |
| 连廊结构底 119.15 m、净跨 78 m、下挂 33 m | `design` | 下弦梁、玻璃体、倒三角折板标 `design` |
| 招银 387 m、75 层 | `design` | 顶冠件标 `design`；340/300 m 台肩按 OSM `building:part` 高度拟合，标 `estimate` |
| 塔平面 62 m × 54 m（半轴 31/27）、平放角、收分、塔顶外倾 | `estimate` | 无公开施工图，按效果图比例拟合 |
| 连廊宽 22 m、上部玻璃体 8.6 m、吊杆位置 | `estimate` | 只 119.15/78/33 是设计值 |
| 十字双轴宽度 40/34 m、绿化带 8.4 m、排水缝 0.5 m | `estimate` | 公共空间尺度按设计文本和效果图拟合 |
| 展馆 19.7 m 高、两层加屋面 | `estimate` | 院落只给出体量，无建筑图 |
| 车站地面出入口 3 个、雨棚 4.95 m | `estimate` | OSM 没有出入口对象，位置是模型建议 |
| 招银入口雨棚、展馆入口雨棚 | `estimate` | 纯外观拟合 |

`sourceHeight` 语义沿用 `parts.js`：对真实 OSM 建筑取登记高度，对场地/车站这类无建筑高度的对象取模型部件包络（0 或雨棚高度），不是另一个实测值。

## 定位方法

不手写绝对坐标，全部由场地多边形推导：

1. `siteFrame()` 取场地外环的面积质心（-8774.5, 2409.5）和最小面积包围矩形方向，得到长轴（≈东西，方位角偏差 0.3°）和短轴。
2. `twinTowerPlan()` 把双塔放在质心两侧、沿长轴各退 70 m；塔面因此落在质心两侧各 39 m，正好给出连廊 78 m 净跨。东塔在长轴正向（东侧）。
3. 南北绿轴沿短轴穿过双塔之间（连廊正下方），东西铺装轴沿长轴在塔前广场处收束；交叉点是场地质心。
4. 塔基、连廊起步标高、双轴铺装高程都取 `terrainHeight`（Copernicus DSM 派生面），不另造绝对标高。塔基取塔脚环线的最低地面，不悬空。

误差：场地轮廓来自 OSM 数字化，位置误差按 OSM 常态约 ±1–2 m；平面拟合尺寸相对误差约 ±10–15%；高度按公开设计值取整，模型高度与设计值差 < 0.7 m（DEM 锚点与塔心高程差）。

## 程序化形态

`js/sz-landmarks/super-hq.js`，部件全部走 `parts.js` 的 `footprintParts / loftPart / spanPart / roofPanelPart`，显示和碰撞共用同一份 parts。

- **C 塔双塔**：每塔 9 段 loft 叠出裙摆—大堂—幕墙主体—连廊标高楼板环—三次收分—金属顶冠；平面是 16 边圆角矩形环，各段等比缩放 + 平移，所以每段对应边平行，满足 `loftPart` 的凸性/平面约束。塔顶向交叉点外倾 9.5 m，形成「一对舞者」的剪影。中上部 78% 高度处有外挑的高空大堂环带，朝双轴一侧有 6 m 出挑的无柱入口雨棚。
- **连廊**：下弦梁底面即 119.15 m（设计值），上承 8.6 m 高的玻璃体与屋面；桥下挂两块 33 m 深的折板构成倒三角，底部有两片外翻「裙摆」小翼和 4 根吊杆。桥端各嵌入塔体 1.5 m，桥下净空 > 100 m，中央绿轴从桥正下方穿过。
- **招银环球金融中心**：足迹按 OSM 88 点多边形挤出，缺省退进 2.5%；顶冠按 OSM 三个 `building:part` 的 x 向分段做成 300/340/387 m 三级台肩 + 7 m 金属冠，入口侧有 6 m 雨棚。不是盒子。
- **规划展览馆**：院落地块上做 1.1 m 台基 + 14.7 m 玻璃展馆 + 2.4 m 屋面 + 局部采光天窗，总高约 19.7 m；东侧入口雨棚。
- **超级总部站**：地下站轮廓只用于定出入口位置。程序在多边形内部按 x 分三组，各取靠 C 塔场地一侧、距边界 ≥ 8 m 的可用点，做 3 个地面出入口（台基 + 玻璃厅 + 雨棚 + 灯带标识），不做地下空间、不写站名文字。
- **十字双轴**：南北绿轴 40 m 宽（22.2 m 步行面 + 两侧 8.4 m 绿化带 + 0.5 m 排水缝），东西铺装轴 34 m 宽；交叉处两跨做成 40 m 宽的整幅广场。所有铺装段用三角面按角点取真实地形高程，绿化带/排水缝同样逐角点贴地，实测顶点高程与地形差 ≤ 0.22 m（要求 ±0.3 m）。铺装段登记为可行走接触面（`roofContact`）。

统计（真实共享包 `js/sz-city.json.gz`，2026-11-09）：

- 部件 245 个：双塔 22、连廊 13、双轴及塔前广场 186（绿轴 104 + 东西铺装轴 78 + 塔前广场 4）、招银 7、展馆 5、车站 12。
- 三角 4,540（上限 200k）、材质 7 种（上限 8）、部件上限 400；55 个铺装/桥面部件登记为可行走接触面。
- 塔顶相对塔心地面：东塔 399.88 m、西塔 335.58 m（DEM 锚点与塔心差 0.1–0.6 m，容差 ±2 m）。
- 连廊底 = 地面 + 119.15 m，屋面 = +128.45 m，倒三角最低点 = +86.15 m；下弦梁结构跨 81 m（78 m 净跨 + 两侧各 1.5 m 嵌入塔体）。
- 招银塔顶 = 基底 + 387.00 m。

## 接入方式（Lead 负责）

```js
// js/sz-landmarks/layout.js
import { sourceIds as superHqIds, optionalSkipIds as superHqSkips, build as buildSuperHq } from './super-hq.js';
// definitions 数组里加：
{ id: 'super-hq', site: 'super-hq', sourceIds: superHqIds, optionalSkipIds: superHqSkips, build: buildSuperHq }

// js/sz-landmarks/materials.js
import { createSuperHqMaterial } from './super-hq.js';
// dispatch 里加：
if (name.startsWith('superHq')) return createSuperHqMaterial(name);

// js/cameras.js + js/sz-camera-presets.js + js/sz-strings.js
{ id: 'superHq', name: STR.cameraNames.superHq, category: 'scenic', fov: 44 }
case 'superHq': return { position: anchor('super-hq', 90, 205, 900), target: anchor('super-hq', 0, 175, 0) };
// STR.cameraNames.superHq = '深圳湾看超级总部双塔'
```

`layout.js` 传的 `context.sites` 就是 `GEO.sites['super-hq']`（`site` 角色缺失时模型返回空数组，不抛错、不回退成通用楼）。`optionalSkipIds` 必须一起接：通用包把招银拆成 5 个 `building:part` 盒子，展馆院落里有既有建筑轮廓，施工场地里还有 20 个压到塔基/双轴/出入口的过时 Overture 足迹；不让位就会和本模型重叠。整片「施工场地内的所有旧轮廓都让位」属于数据管线策略，不在本任务写范围，本模型只列了与自身几何冲突的对象。

## 测试

```sh
SZ_THREE_PACKAGE_DIR=/Users/holder/Documents/ChatGPT/slop-shenzhen/.agents/three-0.187.0 \
  node --test tests/sz-superhq.test.cjs        # 13 pass / 0 fail
node --test tests/sz-superhq.test.cjs          # 12 pass / 1 skip（无 THREE 时干净跳过渲染测试）
node --test tests/*.test.cjs                   # 全套 398 项，0 fail
```

覆盖：设计值锁定、场地主轴/双塔定位纯函数、缺场地数据返回空数组、部件上限与碰撞一致、塔顶 400/336、连廊 119.15/78/33、招银 387、展馆低层体量、车站 2–4 个出入口、双轴顶点贴地 ±0.3 m、所有部件在各自 OSM 多边形外扩 10 m 内、不侵水体、确定性、真实 THREE 渲染三角/材质预算、显示与碰撞高程一致（射线命中塔顶/连廊顶）。

## 画面证据与已知缺口

- **浏览器画面待补**：本任务不跑浏览器，L4「画面里看得见」和 L5「碰撞/通行一致」未做。相机建议 `superHq`（深圳湾侧、场地正南 900 m、高 205 m、FOV 44°），应能同时看到东西双塔、119 m 连廊和倒三角。
- **无施工图**：塔平面、收分曲线、双塔错位角度、连廊非对称造型都是效果图比例拟合；平面的「舞者式」旋转（两塔相互扭一个角度）没有实现——`loftPart` 只支持等比缩放 + 平移，实现方式见 `FIT` 常量注释。若后续拿到图纸，应以图纸替换 `FIT`，高度的 `design` 标注不变。
- **连廊**：只建了 22 m 宽的单幅桥面（对应 11-MVP「一座连廊」的口径），施工通稿提到南北两侧分次提升，若按两幅桥建模需要改。连廊可行走性、桥下净空和塔前广场的公共通行未实走验收。
- **幕墙**：C 塔幕墙在施工，模型按建好形态满铺玻璃；材质是窗格 + 夜景灯光近似，没有 C 塔幕墙分格详图、招银折纸三角板的确切分格。
- **车站**：OSM 只有地下站轮廓，3 个地面出入口是模型建议位置，不是已核实出入口；站名只用色带灯光，没有文字（界面文字统一由 `sz-strings.js` 管）。
- **展馆**：院落里原本有 OSM 展馆建筑（`relation/18564923`，通用包估 30.8 m），本模型在该院落按「两层展馆 + 屋面」重建，高 19.7 m；两者形态差异未核实照片。
- **双轴**：南北绿轴按片区「中央绿轴为南北轴线」的方向建，但场内这条轴的实际位置、宽度和种植设计没有图纸来源，属外观估计；东西轴在双塔处收束为塔前广场，不是穿塔通道。
