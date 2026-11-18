# 界面、地图与漫游

## 已有功能

正式入口已有全图/小地图、地点搜索与传送、地铁/高铁/无人机图层、驾驶选点、HUD、模式菜单、相机、日夜切换和声音控制。当前玩法以城市漫游为主，正式接单任务和完整场所探索系统仍待开发。

## 方法与架构

| 入口（相对 `js/`） | 职责 |
| --- | --- |
| `sz-map.js::SZMapSystem`、`sz-map-layers.js` | 地图绘制、图层与地点/路线交互 |
| `sz-ui.js`、`sz-strings.js::STR` | 界面状态与集中中文文案 |
| `sz-observation-session.js::createObservationSessions` | 节目、地标环绕、配送跟拍和空中巡游共用的观察会话 |
| `sz-city-config.js::createCityConfig`、`sz-spatial.js::createCitySpatial` | 地点、出生/传送与空间索引 |
| `cameras.js::CameraSystem`、`sz-camera-presets.js` | 追尾、环绕与景点机位 |
| `touch-controls.js`、`gamepad-controls.js` | 触屏与手柄输入适配 |
| `lighting.js::LightingSystem` | 四时段光照、天空与阴影；后处理在 `post-processing.js` |
| `audio-system.js::CityAudioSystem` | 事件、环境声、程序合成与建筑遮挡近似 |
| `sz-startup.js::waitForFirstFrame`、`sz-qa.js::createQaSession` | 首帧/重试与本机QA采样；入口由 `main.js` 装配 |

单击地图查看对象，双击或双触同一位置请求安全落点。驾车规划独立选择起终点与道路层级，预览路线后发车。地铁线路首次全关，选择状态可持久化。传送菜单支持按地点类别组合筛选。

`1/2/3/4` 对应步行、骑行、开车、飞行，`M` 打开地图，`V` 切换相机，`5` 追尾回中，`N` 切换声音，`H` 隐藏界面。移动与定速规则见[载具](07-VEHICLES.md)。

## 观察会话

节目、地标环绕、配送跟拍和空中巡游共用互斥的观察会话。先验证目标、可用性和落点，再接管相机或玩家输入。启动失败保留当前会话。节目退出恢复原相机和时段，空中巡游退出后玩家留在当前位置悬停。地图标记、观察机位、公共入口和安全落点分别校验。
