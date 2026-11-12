# Slop Shenzhen

浏览器里的 1:1 深圳城市漫游。three.js 0.187.0、WebGPU/TSL、原生 ES Modules，无打包工具。当前覆盖与验收状态见 HANDOFF。

## 按任务读取

- 开工读 [HANDOFF](docs/HANDOFF.md)、[规范](docs/CONVENTIONS.md)、[开发检查](docs/25-FAST-CHECKS.md)，再读 [TASKS](docs/TASKS.md) 对应条目。
- 查调用关系读 [架构](docs/01-ARCHITECTURE.md)，再从 [组件索引](docs/README.md) 读任务对应模块；道路、建筑、街景、载具、无人机、界面、商圈和灯光秀各有独立说明。改数据读 [数据管线](docs/02-DATA-PIPELINE.md)，改地标读 [模型参考](docs/05-LANDMARKS.md)。
- 正式验收或发布读 [验收标准](docs/10-PERF-QA.md)。调研和历史问题按需读，不作为每次开工前置。
- 只做用户本轮授权的范围。调研/规划任务只改文档，把实施提示词放 TASKS，不启动实现 agent。

## 必须保持

- 对话、文档、新注释用中文；标识符、日志、报错、测试名、提交信息用英文。界面文字集中在 `js/sz-strings.js`。
- 原点 `114.0545E, 22.5463N`，1 单位=1米，x东、z南、y上；扩区不改原点。地标按 `data/source/landmarks.json` 的已核实对象绑定。
- 原始数据在 `data/raw/`，来源和哈希在 `data/source/sources.json`；生成包与报告只经 `tools/sz/build.py`。每栋楼保留 `heightSource`，估计、设计、实测分开。
- 全部程序化建模；显示、碰撞与通行面同源。架空层、连桥按实体分段。车辆无品牌标志/品牌名，不使用 APEC 官方会徽。
- `ref/` 只读。不提交密钥、本机绝对路径、原始大文件、`.venv/` 和 `docs/qa/`。
- 默认在 `main` 开发、测试、审查、提交并保持 `main`；仅用户明确要求时建分支或工作树。
- 日常执行相关检查、一次差异审查后提交；共享核心或大版本全量。仓库流程覆盖技能的固定全量、固定双代理与重复确认默认步骤。
- 仅更新 HANDOFF 当前结论与 TASKS 对应任务；完成的操作步骤移除，证据放本地 QA。验收分 L1–L5，不用局部通过代替全城通过。
