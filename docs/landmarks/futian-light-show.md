# 福田中心区夜景灯光秀（LED 轮廓灯带）

## 身份与来源

- 依据：福田中心区（市民中心、深南、益田路、滨河一带）真实高层建筑群；共享包 `REAL_BUILDINGS` 里的已建成普通高层。
- 点亮范围：中心点在 `x ∈ [-3000, 3000]`、`z ∈ [-1500, 2500]` 且高度 ≥150 m 的普通建筑；当前 137 座。
- 高度：直接取共享包建筑高度（`heightSource` 保留原值；灯带垂直范围按地标放置结果，`estimate` 的是灯带样式不是楼高）。
- 颜色/节奏：展示参数（青、品红、暖金循环 + 呼吸脉冲），**不是**任何官方灯光秀节目单，也不含官方会徽/图案。

## 实现

- `js/sz-light-show.js`：纯计划 `planLightShow(buildings, terrain)` + 渲染 `buildSzLightShow(scene, { buildings, terrain })`。
- 每座楼沿足迹均分最多 6 条竖向灯带（外立面外 0.3 m），再在塔顶包围盒四边加水平轮廓灯带。
- 6 个材质桶（按建筑 id 固定种子分桶）→ 6 个 `InstancedMesh`，当前 628 竖向 + 548 塔顶 + 6 网格；白天（`night ≤ 0.25`）整组隐藏、不占 draw call。
- 只做显示，不加碰撞体、不改建筑体量；TSL `time` 驱动颜色，无需每帧 JS。

## 接入

```js
import { buildSzLightShow } from './sz-light-show.js';
const lightShow = buildSzLightShow(scene, { buildings: REAL_BUILDINGS, terrain: GEO.terrain });
// setupSceneCulling(..., lightShow.group, ...)
// 每帧：lightShow.group.visible = lightingSystem.uNightFactor.value > 0.25;
```

## 验证等级

- L3：生成器 + 单元测试（确定性、灯带在足迹边缘、短楼/区外过滤、真实 THREE 实例化构建）。
- L4：浏览器午夜画面可见（`docs/qa/round5/light-show-civic-night.png`）。
- 未做：逐楼实际灯具位置、节目单/颜色审核、L5 夜景观赏路线；FPS 在自动化浏览器 30 Hz 基准下无实测差异（day 30 / night 30，drawCalls 413→416）。

## 已知缺口

- 灯带是“边缘勾边”效果，不是真实楼体媒体立面像素动画；真实深圳灯光秀的楼体 LED 屏内容不可得。
- 137 座楼只按共享包体量勾边，没有逐楼核准；超总/后海地标不在此模块（各自模型负责）。
- 颜色/节奏是展示估计，APEC 期间是否开启需按官方安排另行核实。
