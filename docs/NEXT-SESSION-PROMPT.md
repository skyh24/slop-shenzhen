# 新会话接续提示（2026-11-10 round 49 生成）

把下面这段直接发给新的编码会话即可接续：

> 继续 Slop Shenzhen 项目（工作目录 `/Users/holder/Documents/ChatGPT/slop-shenzhen`，正式入口 http://127.0.0.1:8080/ 需常驻）。先读 `docs/HANDOFF.md`、`docs/ACCEPTANCE-STATUS.md`、`docs/TASKS.md`、`docs/CONVENTIONS.md`，再按下列优先级推进：
>
> 1. **M9 性能实测**：本机自动化浏览器 WebGPU swapchain 被固定 30 Hz（与分辨率无关，round 38 已确认），需在可见聚焦的桌面窗口用 `tools/qa/perf-sample.mjs` 跑 2560×1440、冷/热各 5 次、≥60 s/段、20 分钟稳定性；预算见 `docs/10-PERF-QA.md`。
> 2. **Q8 驾驶**：车公庙高架桥面可走（步行 Q8 已通，round 20/21），但车辆在 z≈1074 卡住——不是碰撞/交通，疑似桥面缎带偏离车辆行驶线、支撑高差超 1.5 m；下一步用派生道路中心线重建高架缎带或加车辆中心线引导。
> 3. **3.6 视觉层**：结构/ID/快捷键已核对通过（原版 94 ID 全保留），未做面板样式与触屏布局逐像素对照。
> 4. **APEC 剩余**：公交涂装、候车亭海报、会展媒体中心细部；其他立交/沿江高速远景。
>
> 约束不变：中文文档/注释、英文标识符与提交、`ref/` 只读、生成文件只由 build.py 产出、不提交 `data/raw` 与 `docs/qa`；每轮结束跑 `node --test tests/*.test.cjs` 与 Python 单测，保持 8080 可验收。
