# 界面、地图与漫游

## 已有功能

正式入口已有全图/小地图、地点搜索与传送、地铁/高铁/无人机图层、驾驶选点、HUD、模式菜单、相机、日夜切换和声音控制。地铁选择已持久化，首次默认不显示线路。当前玩法以城市漫游为主，正式接单任务和完整场所探索系统仍待开发。

## 方法与架构

| 入口（相对 `js/`） | 职责 |
| --- | --- |
| `sz-map.js::SZMapSystem`、`sz-map-layers.js` | 地图绘制、图层与地点/路线交互 |
| `sz-ui.js`、`sz-strings.js::STR` | 界面状态与集中中文文案 |
| `sz-city-config.js::createCityConfig`、`sz-spatial.js::createCitySpatial` | 地点、出生/传送与空间索引 |
| `cameras.js::CameraSystem`、`sz-camera-presets.js` | 追尾、环绕与景点机位 |
| `touch-controls.js`、`gamepad-controls.js` | 触屏与手柄输入适配 |
| `lighting.js::LightingSystem` | 四时段光照、天空与阴影；后处理在 `post-processing.js` |
| `audio-system.js::CityAudioSystem` | 事件、环境声、程序合成与建筑遮挡近似 |
| `sz-startup.js::waitForFirstFrame`、`sz-qa.js::createQaSession` | 首帧/重试与本机QA采样；入口由 `main.js` 装配 |

键位：`1/2/3/4` 步行/汽车/单车/飞行；`M` 地图，`V` 循环相机，`5` 追尾回中，`N` 声音，`H` 隐藏界面。保留纽约原版元素ID与快捷键，中文提示以STR为准。玩家存档键为 `sz-player-state`，载具行为见 [07号](07-VEHICLES.md)。

## 实现边界与验证

现有地点搜索不等于统一的楼栋/小区/场所身份和几何高亮；名称命中也不证明可通行落点。四时段不是连续真实演出时刻表。触屏/手柄存在适配代码，但完整操作验收仍缺；启动错误及证据边界见 [HANDOFF](HANDOFF.md)。

检查用 `ui`，驾驶联动加 `controls`。浏览器检查首帧、真实输入、失败重试、图层初始值/刷新持久化与退出恢复。后续集中在 [TASKS T1](TASKS.md#t1-启动)、[T6](TASKS.md#t6-轨道交通)、[T11](TASKS.md#t11-地点与探索)。
