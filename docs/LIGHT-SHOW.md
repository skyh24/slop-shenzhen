# 楼宇灯光秀

## 已有功能

`main.js` 已装配 `sz-light-show.js` 并在帧循环调用更新。当前在福田范围内筛选高楼布置竖向灯带与楼顶轮廓灯，另为平安金融中心专模巨柱布置贴合结构的灯带；随共享夜景状态显示，TSL驱动动态色彩。

这是已实现的楼宇灯效。色彩和节奏为展示估计，未还原真实灯光展节目或演出时刻表；无人机编队表演仍未实现。

## 方法与架构

| `sz-light-show.js` 方法 | 职责 |
| --- | --- |
| `planLightShow` | 按 `SHOW_AREA` 与150米楼高门槛选普通楼，排除专模替换对象，生成竖灯带/顶冠 |
| `planLandmarkBands` | 从专模巨柱分段实体提取灯带轴线，避免另猜楼体形状 |
| `buildSzLightShow` | 固定种子分色组、实例化网格与TSL材质，返回统计、更新和释放方法 |

夜景显隐使用共享uniform；灯带不投射/接收阴影，也不作为建筑碰撞体。`statistics.drawCallsEstimate` 是布局估计，真实GPU成本需实测。

普通窗光由 `sz-materials.js` 和 `city-lighting-materials.js` 管理，道路灯杆见 [街景](06-STREETSCAPE.md)，APEC道旗/大屏另有组件。它们共享场景光照，但各自维护对象与来源。

## 实现边界与验证

真实楼宇参与范围、灯带位置、节目内容和时段尚需逐项来源核实，不能把程序效果写成现实正在演出。优先复核地标替换是否重复、灯带是否穿模、昼夜显隐及近远画面。

定向测试为 `tests/sz-light-show.test.cjs`，可经 `python3 tools/qa/check.py --scope street --node tests/sz-light-show.test.cjs` 执行；共享材质变化按 [开发检查](25-FAST-CHECKS.md) 扩大范围。浏览器看完整颜色周期并采样夜景成本。后续仅在 [TASKS T12](TASKS.md#t12-低空apec) 与 [T10](TASKS.md#t10-性能与发布) 派工。
