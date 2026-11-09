# APEC 城市元素：路侧大屏、巡逻机器人、围挡公益广告

2026-11-09／10。状态：模块与专项测试完成，**未接入 main.js**（由 Lead 统一接线），未做浏览器画面与碰撞实走。全部是展示示意（`heightSource = 'estimate'`），只使用文字、中国红和 APEC 紫，**不使用 APEC 官方会徽**，不加载任何外部素材。

## 身份和来源

对应 [docs/11-MVP.md](../11-MVP.md) 第 3.8 节 APEC 会场和城市元素表：

- 标语“相约深圳 见证奇迹”“共赴深圳之约 共创美好亚太”来自该文档第 199 行（公交站和楼宇外屏“万屏联动”）；英文副标 `APEC CHINA 2026 · SHENZHEN` 由本模块补足，只作文字排版，不是官方标识。
- 三处大屏位置以共享包 `GEO.landmarks` 的已核实地标中心为锚点：`civic-center`（市民中心，OSM 已核实）、`convention-center`（深圳会展中心）、`super-hq`（深圳湾超级总部基地）。偏移量是示意值，不是实测点位。
- 巡逻机器人位置用 `js/sz-landmarks/iec-xiangmihu.js` 导出的会场门廊/花海锚点（`gatePoint`、`gateYaw`、`gateDeckY`、`flowerSeaAnchor`、`flowerSeaDeckY`），由 main.js 通过 `anchors` 传入；没有锚点时退回会场地标中心加示意偏移。
- 西丽站围挡广告使用共享包 `GEO.sites['xili-station'].site`（OSM [`way/402048868`](https://www.openstreetmap.org/way/402048868)，在建场地 66,201 m²）的外环；围挡本体由 `js/sz-station-sites.js` 的 `buildXiliConstruction` 建，高 3 m、厚 0.25 m。
- 配色只用中国红 `#c8102e`、APEC 紫 `#5a2a66`、金色 `#d8b45a` 和白色；贴图全部在运行时用 canvas 2D 绘制。

## 数据口径：哪些是实测，哪些是示意

| 内容 | 来源 | 属性 |
| --- | --- | --- |
| 三个地标中心 | `data/source/landmarks.json` 已核实的 OSM 对象（`GEO.landmarks`） | 实测点位 |
| 西丽站场地外环 | OSM `way/402048868` | 实测轮廓 |
| 国际交流中心门廊、花海台面标高 | `js/sz-landmarks/iec-xiangmihu.js` 的 estimate 基准（OSM 几何 + DSM 均值，非设计图） | 显式估计 |
| 大屏位置偏移（40/466、74/175、30/-164 m） | 按 2026-11-09 OSM 路网人工检查选取：深南大道南侧、滨河大道北侧、白石四道北侧 | 示意，不是逐块屏实测 |
| 大屏朝向、8.4 × 4.6 m 屏面、2.6 m 离地、钢柱/基础尺寸 | 常见路侧 LED 屏的统一原型 | 外观示意 |
| 机器人椭圆巡逻（12 × 8 m、10 × 7 m）、速度、灯条亮度 | 展示参数 | 全部估计，无 AI/寻路 |
| 围挡广告面板 4.8 × 1.9 m、离地 1.55 m | 按 3 m 围挡比例示意 | 外观示意 |
| 标语文字 | docs/11-MVP.md 第 199 行 | 官方宣传标语（非会徽） |

所有 part 都带 `heightSource: 'estimate'`；本模块没有把任何估计值写成实测值。

## 模块 API（`js/sz-apec-city.js`）

```js
// 纯布点计划（不依赖 renderer，可在 node 测试）：返回 { screens, robots, hoardings, missing }
export function planApecCityElements({ landmarks = [], sites = null, anchors = null } = {});

export function buildApecCityElements(scene, {
  terrain = null,      // GEO.terrain，用 js/sz-terrain.js 的 terrainHeight 取地面；缺失回退 0
  landmarks = [],      // GEO.landmarks
  sites = null,        // GEO.sites（用到 sites['xili-station'].site）
  anchors = null       // main.js 传的 { iecGate:{x,z,yaw,baseY}, iecFlowerSea:{x,z,baseY} }
} = {}) -> {
  group,               // THREE.Group，name = 'shenzhen-apec-city-elements'，由 Lead 控制 visible
  statistics,
  screens, robots, hoardings,   // 实际生成的三组布点记录
  parts,               // 每个 part 都带 heightSource='estimate'
  update(dt, nightFactor),      // 机器人椭圆巡逻 + 大屏/灯条夜间自发光
  dispose()
};
```

其他导出常量：`SCREEN_SITE_DEFS`、`ROBOT_PATROL_DEFS`、`APEC_CITY_SLOGANS`、`APEC_CITY_COLORS`、`ROBOT_PATH_SAMPLES`、`XILI_HOARDING_HEIGHT_M`、`HOARDING_PANEL_*`。另有 `planApecScreens`、`planApecRobots`、`planXiliHoardings`、`summarizeApecCityPlan` 供测试和统计复用。

`group.visible` 默认 `true`，没有自己的会期判断：按 [docs/11-MVP.md](../11-MVP.md) 3.8，整组由 main.js 的 APEC 主题开关统一控制（会期内默认打开，见 `js/sz-apec.js` 的 `isApecEnabledAt` 与 localStorage 记忆）。

## 真实数据下的布点结果

`planApecCityElements({ landmarks: GEO.landmarks, sites: GEO.sites, anchors })` 在 2026-11-09 的共享包上得到：

| 类别 | 数量 | 关键数值 |
| --- | --- | --- |
| 大屏 | 3 | 市民中心南侧 `(42.1, 470.4)` 朝北；会展中心 `(99.7, 1590.2)` 朝南；超级总部基地 `(-8744.1, 2245.7)` 朝南 |
| 巡逻机器人 | 2 | 门廊 `(-2952.4, -180.7)` 台面 16.9 m，椭圆 12 × 8 m；花海 `(-2930.3, -72.0)` 台面 16.6 m，椭圆 10 × 7 m |
| 围挡广告 | 4 | 沿西丽站外环等分：南北长边各 2 块，避开最长边中点 9 m 大门 |
| 网格 / 三角 | 46 / 816 | 46 次绘制调用（3 屏 18、2 机器人 16、4 面板 8、其余共享实例化节点） |

构建后 `statistics.built` 与 plan 数量一致；`missing` 为空。若地标或场地数据缺失，对应条目进入 `missing` 并跳过，不硬配、不抛错。

## 接入 main.js（供 Lead 使用）

```js
// 1. 顶部 import
import { buildApecCityElements } from './sz-apec-city.js';

// 2. 创建：放在 buildXiliConstruction 之后（广告面板挂在西丽站围挡外侧线上，视觉上与围挡贴合）
const apecCity = buildApecCityElements(scene, {
  terrain: GEO.terrain,
  landmarks: GEO.landmarks,
  sites: GEO.sites,
  anchors: {
    iecGate: { x: gatePoint.x, z: gatePoint.z, yaw: gateYaw, baseY: gateDeckY },
    iecFlowerSea: { x: flowerSeaAnchor.x, z: flowerSeaAnchor.z, baseY: flowerSeaDeckY }
  }
});
// QA 调试暴露（可选）：window.__szApecCity = apecCity;

// 3. 场景剔除根列表：加到 setupSceneCulling(scene, [...]) 的 roots 里
setupSceneCulling(scene, [...cullingRoots, apecCity.group, ...], lightingSystem.sunShadow);

// 4. 每帧更新（放在 apecTheme.update 旁边）
apecCity.update(dt, lightingSystem.uNightFactor.value);

// 5. APEC 主题开关：在 setApecTheme() 里同步整组显隐
apecCity.group.visible = active;
```

机器人是 2 个小型 Group 加少量普通 Mesh，不满足 `scene-culling.js` 的实例分块阈值（count ≥ 32、三角 ≥ 8000），不会被拆块；面板和大屏是静态普通 Mesh。无需额外处理动态剔除。

## 测试

`tests/sz-apec-city.test.cjs`（11 条，全部通过）：

```sh
SZ_THREE_PACKAGE_DIR=/Users/holder/Documents/ChatGPT/slop-shenzhen/.agents/three-0.187.0 \
  node --test tests/sz-apec-city.test.cjs
```

覆盖：布点确定性、三块屏位置/标语/朝向、缺地标时跳过、机器人椭圆路径有限且确定性、锚点缺失回退、围挡面板贴外环线并朝外且避开大门、缺场地时返回空结果、统计口径、真实 THREE 构建（画布文字、网格数、夜景自发光、销毁后 `group.parent === null`）、无 canvas 时 1×1 贴图降级、空数据构建不抛错。未设置 `SZ_THREE_PACKAGE_DIR` 时 THREE 相关 3 条干净 skip，纯函数 8 条仍运行。

## 已知缺口

1. **未接线和未验收**：main.js 集成、APEC 开关同步、浏览器冷启动与画面截图都还没做（Lead 负责）；当前只到“生成器生成了 + 专项测试通过”。
2. **大屏位置/朝向**：偏移是按 2026-11-09 OSM 路网人工判断的固定示意值，没有逐块屏的影像、产权或灯屏尺寸资料；会展中心与超级总部基地实际楼体大屏位置需现场复核。
3. **机器人**：巡逻椭圆、速度、灯条闪烁都是展示参数，没有真实巡逻路线/排班依据；没有 AI、寻路、避障和碰撞体，玩家可以直接穿过机器人和大屏。
4. **西丽站围挡**：面板按 3 m 围挡线形和外环等分布置；若 `js/sz-station-sites.js` 以后调整围挡高度/内退线形，面板偏移需同步。面板与围挡外表面偏移 0.14 m，避免共面 z-fighting。APEC 期间围挡公益广告的实际版式和工期需 2026-11 之后重核。
5. **文字**：标语是模块内中文常量（按任务要求不写进 `js/sz-strings.js`），如果以后要支持多语言或统一文案管理，需要迁移。
6. **夜景**：大屏/灯条只提高 `emissiveIntensity`，没有独立灯组、光池或 bloom 之外的特殊处理；亮度不是实测亮度。
7. **无会徽校验**：模块不绘制任何会徽/标志，但正式验收仍需人工检查贴图中不出现 APEC 官方标识。
