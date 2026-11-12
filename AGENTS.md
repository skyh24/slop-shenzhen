# AGENTS.md

Slop Shenzhen：浏览器里的 1:1 深圳关内城市漫游（南山、福田，二期加蛇口、罗湖）。底座是 mrdoob 的 Slop New York（three.js `0.187.0` WebGPU 加 TSL，不打包，import map 直接运行），数据管线做法参考 Slop Wuhan。

## 开工时按范围读取

1. 首次进入任务读 [docs/HANDOFF.md](docs/HANDOFF.md) 当前状态、[docs/CONVENTIONS.md](docs/CONVENTIONS.md) 和 [docs/25-FAST-CHECKS.md](docs/25-FAST-CHECKS.md)。同一会话复用未变化的内容。
2. 只读 [docs/TASKS.md](docs/TASKS.md) 的任务条目及对应 00–10 号模块文档；后续精细化、优先次序和并行依赖见 [29 号](docs/29-SHENZHEN-REFINEMENT-PLAN.md)，派工使用 [30 号](docs/30-REFINEMENT-WORKTREE-PROMPTS.md)。22 号和 REVIEW-FOLLOWUP 供追溯审计证据。
3. 正式功能验收或大版本发布时读 [docs/11-MVP.md](docs/11-MVP.md) 九条硬性要求与 [docs/10-PERF-QA.md](docs/10-PERF-QA.md) 完整验收路线。

**日常开发、审查与提交按 [25 号](docs/25-FAST-CHECKS.md) 执行**：相关测试、一次差异审查、通过后提交；大版本全量。该仓库流程覆盖通用技能中固定全量、固定双代理和重复确认的默认步骤，用户明确指定的审查方式优先。

## 正式版硬性要求（摘要）

1. 建筑还原：地标单独程序化建模，标志性特征齐全；普通建筑分塔楼和裙房
2. 城市地貌：真实地形（莲花山、塘朗山等），红树林、河道；一期主要立交匝道可通行；深圳湾大桥、沿江高速做远景
3. 无人机航线只用有公开来源的真实站点，每条带来源和核实日期
4. 地铁线路、车站、出入口，按 `network=深圳地铁` 过滤；全图内地铁菜单，线路默认不显示，用官方线路色
5. 高铁站：福田站、西丽站（在建）
6. 交互和界面和纽约原版一一对应（`index.html` 结构、元素 ID、快捷键）
7. 深圳湾超级总部基地按建好形态建模，楼高标 `design`
8. APEC 会场（国际交流中心、会展中心新闻中心、深业上城国礼展）和城市元素，不用官方会徽
9. 观感和帧率达到 `docs/10-PERF-QA.md` 的预算

## 硬性规则

- **语言**：对话和文档用中文；新写的代码注释用中文；标识符、日志、报错、测试名、提交信息用英文；界面文字用中文，集中放在 `js/sz-strings.js`
- **`ref/` 只读**：三个参考仓库不改、不提交
- **坐标**：原点 `114.0545E, 22.5463N`（市民中心主楼），1 单位 = 1 米，x 向东、z 向南、y 向上，不旋转坐标轴；扩区不改原点
- **地标位置**：以 `data/source/landmarks.json`（OSM 对象 ID，已核实）为准，不用计划初稿里手写的坐标
- **数据**：原始数据放 `data/raw/`，不进 Git，哈希记在 `data/source/sources.json`；生成文件只能由 `tools/sz/build.py` 产出，不手改；每栋楼都要带 `heightSource`，估计值不能写成实测值
- **代码**：ES Module，import 写在文件顶部；两空格缩进、单引号、加分号；不加打包工具和 npm 运行时依赖；单个文件不超过约 1000 行；有限取值的 `switch` 在默认分支抛错；随机数用固定种子
- **建模**：全部程序化建模，不导入 glTF；车辆不画品牌标志、不写品牌名；不使用 APEC 官方会徽；显示和碰撞用同一份几何；架空层和连桥按分段实体建
- **安全**：不提交密钥、本机绝对路径、`data/raw/`、`.venv/`

## 常用命令

```sh
python3 tools/sz/serve.py --port 8080    # 打开 http://127.0.0.1:8080/，需常驻后台
python3 tools/qa/check.py --scope controls       # 日常按模块选择，可重复 --scope
python3 tools/qa/check.py --scope full           # 大版本/共享核心改动的全部自动测试
.venv/bin/pip install -r tools/sz/requirements.txt
.venv/bin/python tools/sz/build.py               # 生成正式共享包和报告；--no-cache 重新解析 PBF
```

正式入口：<http://127.0.0.1:8080/>，已运行深圳。MVP 预览页（`mvp.html`）已于 2026-11-10 删除，正式验收入口只有这一个。

WebGPU 需要安全上下文，只用 `127.0.0.1` 或 `localhost` 打开。本机没有 GDAL：读 PBF 用 `osmium`，读 Shapefile 用 `pyshp`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `js/` | 正式深圳运行时代码，保留纽约引擎；按 `docs/01-ARCHITECTURE.md` 的矩阵逐个替换 |
| `tools/sz/` | 深圳数据管线（Python） |
| `tools/ny/` | 纽约原版的数据工具，只作参考 |
| `data/source/` | 人工核对过的数据和快照清单，进 Git |
| `data/raw/` | 原始大文件，不进 Git |
| `tests/` | `node --test` 测试 |
| `docs/` | 规划、规范、调研、交接 |

## 怎样算做完

汇报时写清楚做到了哪一级：数据里有 → 生成器生成了 → 挂进了场景 → 浏览器画面里看得见 → 碰撞、通行和画面一致，并实际操作走通。

每个里程碑结束时：

- 测试全部通过
- 浏览器冷启动，控制台没有报错
- 按 `docs/10-PERF-QA.md` 的路线走一遍，截图存到 `docs/qa/<里程碑>/`（该目录只留本地，已在 `.gitignore` 里，不进 Git）
- 把页面恢复成普通游玩状态（不留固定机位、隐藏界面、调试参数）
- 勾选 `docs/TASKS.md`，更新 `docs/HANDOFF.md`
- 提交并推送，打标签 `baseline/m<N>`

## Git

- 本目录默认在 `main` 开发、测试、审查并直接提交，完成后保持在 `main`；仅用户明确要求时创建分支或工作树
- 提交信息用英文祈使句，一次提交只做一件事
- 推送前用 `git diff --cached` 查一遍大文件和本机路径

## 联网检索

Tavily 的 MCP 网关会返回 429，改为直接调 REST 接口 `https://api.tavily.com/search`；Perplexity 额度已用完；Overpass 请求必须带 User-Agent。详见 `docs/RESEARCH.md` 第 5 节。
