# 下一位 agent 执行计划

**当前执行顺序（2026-11-10 晚）**：

- 功能修复以 [REVIEW-FOLLOWUP 第 4 节](REVIEW-FOLLOWUP-2026-11-10.md#4-下一批按这个顺序执行) 为准，第一项是自动裙房占道。
- 架构精简、性能和画面优化以 [22-OPTIMIZATION-REVIEW.md](22-OPTIMIZATION-REVIEW.md) 第 5 节为准。两条线可以由不同执行组并行，文件冲突约束写在 22 号第 5 节。
- 具体待办在 [TASKS.md](TASKS.md)。

下文 E0–E6 是 2026-11-09 写的长期计划。它的执行原则、来源纪律、验收标准和并行分工仍然有效；其中的旧包哈希、测试数量和分支名已经过时，以 [HANDOFF](HANDOFF.md) 为准。

## worktree 并行计划（2026-11-10 晚）

### 先做什么：阻塞项

| 顺序 | 事项 | 为什么先做 | 谁做 |
| --- | --- | --- | --- |
| 0 | 把当前文档改动提交到 `main`，清理三个已合并的旧 worktree | worktree 从提交开出；不提交，新 worktree 里的 agent 会读到指向已删文档的旧版本 | 协调者 |
| 1 | P0 性能基线（22 号第 3 节） | 所有性能改动和近景树都要拿它对比。自动化浏览器被锁在 30 Hz，**必须由你在可见、聚焦的桌面窗口里跑**，跑的时候其他 worktree 不要开 WebGPU 页面 | 你加协调者，在主 checkout |
| 2 | 裙房占道（REVIEW 1.1） | 第一项功能缺陷；22 号 S2 里 `sz-buildings.js` 那部分要等它合入 | 第一批 A |
| 3 | 启动失败提示（REVIEW 1.3） | 第一批唯一允许改 `main.js` 的任务；S3、P1、S4 都要在它之后改 `main.js` | 第一批 B |
| 4 | 删除纽约残留（22 号 S1） | S2 依赖它；删掉之后，其他 agent 不会再读错文件 | 第一批 C |

### 三批任务

`main.js` 是冲突热点，每一批只允许一个任务改它。

| 批次 | worktree / 分支 | 任务 | 主要文件 | 前置 |
| --- | --- | --- | --- | --- |
| 第一批 | A `m3-podium-roof` | REVIEW 1.1 裙房占道，然后 1.2 屋顶设备越界 | `sz-buildings.js` 及其测试 | 步骤 0 |
| 第一批 | B `m9-startup-failure` | REVIEW 1.3 启动失败提示和重试，顺带 22 号 P4 城市包只校验一次 | `index.html`、`sz-geodata.js`、`sz-data-format.js`、`main.js` 末尾、`sz-strings.js`、`css/` | 步骤 0 |
| 第一批 | C `m9-prune-ny-runtime` | 22 号 S1 和 S1c | 删除纽约文件、17 个测试、`sz-materials.js` 里只给 MVP 用的函数、16 号和 01 号文档 | 步骤 0 |
| 第一批 | D `m6-drone-return` | REVIEW 1.4 无人机返航，然后 22 号 P10 无人机合批 | `sz-drone-routes.js` 及其测试 | 步骤 0 |
| 第一批 | E `m9-road-surface` | 22 号 V1 和 V6，路面和标线材质 | `sz-roads.js`、`sz-road-paint.js`、新建路面材质文件（不放进 `sz-materials.js`，避免和 C 冲突） | 步骤 0 |
| 第二批 | F `m9-shared-geometry-utils` | 22 号 S2 | 新建工具模块，改 `sz-station-sites`、`sz-apec-city`、`sz-metro-entrances` 等 | A、C 已合入 |
| 第二批 | G `m9-main-wiring` | 22 号 S3，完成后在同一 worktree 做 P1 实例 storage 缓冲 | `main.js`、新建 `sz-qa.js`、`sz-landmarks/layout.js` | B 已合入；P1 还要等 P0 |
| 第二批 | H `m5-elevated-driving` | REVIEW 第 4 节第 4 步：高架车辆路线、自动导航和环境车流 | `sz-traffic.js`、`sz-drive-route.js`、`sz-elevated-roads.js`、`sz-auto-drive.js` | 第一批全部合入 |
| 第二批 | I `m9-render-batching` | 22 号 P2 楼名牌合批、P3 地铁玻璃分块、P7 路灯光晕 | `sz-building-signs.js`、`sz-metro-entrances.js`、`sz-street-lamps.js` | P0；F 改 `sz-metro-entrances.js` 时串行 |
| 第三批 | J `m9-night-uniform`；K `m9-water`；L `m6-crew-transfer` | S4 统一日夜 uniform 加 V2 窗灯（J）；V3 水面（K，要改 `build.py`，遵守 HANDOFF 第 8 节数据包规则）；乘员上下车闭环（L）。已完成的 V4 近景树、S1b 删除 MVP 不再开新分支；M9 完整验收仍在主 checkout 由协调者和用户做 | J：`main.js`、`sz-materials.js` 等；K：`build.py`、海面/河面材质；L：`controllers.js`、`sz-vehicles.js` | 第二批 |

合并规则：
- 只有协调者往 `main` 合并。
- 每个分支先 rebase 到最新 `main`，跑全套测试，再合并。
- 同一时间只允许一个分支重建 `js/sz-city.json.gz`，第一批没有任务需要重建。
- worktree 里的 agent **不改** `HANDOFF.md`、`TASKS.md`，也不改 22 号和 REVIEW 的结论部分；交付报告写在提交说明和最后的回复里，由协调者合并时更新这些文档。

### 开 worktree

在主 checkout 里运行：

```sh
git worktree remove .agents/worktrees/dsh-4dbb5e5c-b267
git worktree remove .agents/worktrees/dsh-6f4cc9b0-6094
git worktree remove .agents/worktrees/dsh-8655d07d-d53d
for b in m3-podium-roof m9-startup-failure m9-prune-ny-runtime m6-drone-return m9-road-surface; do
  git worktree add .agents/worktrees/$b -b $b main
done
```

worktree 里没有这些被忽略的目录，统一从主 checkout 取（下文 `<MAIN>` 指主 checkout 路径，也就是 `git worktree list` 的第一行）：
- `ref/`：读 `<MAIN>/ref/`，不要在 worktree 里建符号链接。
- `.venv/`：用 `<MAIN>/.venv/bin/python`。
- Three 测试依赖：`SZ_THREE_PACKAGE_DIR=<MAIN>/.agents/three-0.187.0`。
- `data/raw/`：第一批不需要。

端口：主 checkout 用 8080，A 到 E 依次用 8081 到 8085，第二批的 worktree 接着往后排。

### 通用提示词前缀

每个 worktree 的提示词都以这段开头，`<...>` 换成实际值：

> 你在 Slop Shenzhen 的 worktree `<WT>` 上工作，分支 `<BRANCH>`。主 checkout 在 `<MAIN>`，只能读它的 `ref/`、`.venv/` 和 `.agents/three-0.187.0`，不能改主 checkout 里的文件。
>
> 开工前读这些文件：`AGENTS.md`、`docs/HANDOFF.md`、`docs/CONVENTIONS.md`、`docs/10-PERF-QA.md`，以及下面任务指定的文档章节。
>
> 规则：
> - 文档和注释用中文；标识符、日志和提交信息用英文；界面文字放进 `js/sz-strings.js`。
> - 只改任务列出的文件；需要动范围外的文件时，先停下来说明原因。
> - 不改 `docs/HANDOFF.md`、`docs/TASKS.md`；不重建 `js/sz-city.json.gz`；不 push，不合并到 `main`。
>
> 测试：
> - `SZ_THREE_PACKAGE_DIR=<MAIN>/.agents/three-0.187.0 node --test tests/*.test.cjs`，基线见 `docs/HANDOFF.md` 第 1 节（2026-11-11：Node 489 项通过、0 跳过）。
> - `<MAIN>/.venv/bin/python -m unittest discover -s tools/sz/tests`。
>
> 浏览器：
> - 用 `python3 tools/sz/serve.py --port <PORT>` 启动，打开 `http://127.0.0.1:<PORT>/`，只用自己的标签页。
> - 截图放 `docs/qa/<BRANCH>/`，这个目录只留本地。
> - 结束时恢复普通游玩状态。
>
> 子 agent：
> - 可以按“复现并写失败测试 → 实现 → 独立复核”拆给子 agent。
> - 同一时间只能有一个子 agent 改同一个文件。
> - 浏览器只由你本人操作。
> - 子 agent 报告的结果要你亲自复跑测试确认，不能直接转述。
>
> 交付：
> - 一个提交只做一件事，提交信息用英文祈使句。
> - 最后回复写清楚这几项：做到了哪一级（L1–L5）、改了哪些文件、测试数量、浏览器怎么验证的、截图位置、没做完的部分和原因。

### 各 worktree 的任务提示词

**A `m3-podium-roof`，端口 8081**

> 任务：修 `docs/REVIEW-FOLLOWUP-2026-11-10.md` 的 1.1（自动裙房占道），然后修 1.2（屋顶设备越界）。只改 `js/sz-buildings.js` 和对应测试，必要时可以新增纯函数模块。
>
> 步骤：
> 1. 子 agent 先把真实样本写成失败测试：裙房占道 `way/269974957` 对道路 `way/270044912`；屋顶越界 `way/135961006`、`relation/17457833`。再补凹形、斜向、带内院屋顶的构造用例。
> 2. 实现裙房约束：估计裙房只在检查过道路、入口、内院和邻楼后的可用范围内生成，放不下就保留原塔楼；显示和碰撞用同一份结果。
> 3. 实现屋顶设备约束：设备完整底面要落在屋顶有效多边形内（扣除内院）；放不下就缩小、换位置或跳过，保持源 ID 固定种子。
> 4. 浏览器复核：沿该道路驾驶并步行通过样本位置；屋顶用俯视和斜视各截一张。
>
> 不能用删除道路、放宽车辆碰撞阈值或调宽桥面来绕过问题。两项分两个提交。

**B `m9-startup-failure`，端口 8082**

> 任务：修 `docs/REVIEW-FOLLOWUP-2026-11-10.md` 的 1.3（模块和城市包加载失败时，没有提示也不能重试），顺带做 `docs/22-OPTIMIZATION-REVIEW.md` 的 P4（`sz-data-format.js` 里只校验一次）。可以改 `index.html`、`js/sz-geodata.js`、`js/sz-data-format.js`、`js/main.js`（只改启动和错误处理相关部分）、`js/sz-strings.js`、`css/`。
>
> 要求：
> - 在主模块求值之前建立错误展示入口，覆盖引擎模块下载失败、城市包 404、坏 gzip、数据版本错误和 `initApp` 抛错。
> - 提供重试，重试后不能出现重复画布或重复动画循环。
> - 保留原生 ES Module、import map 和顶部静态 import，界面文字放进 `sz-strings.js`。
>
> 子 agent 分工：一个写故障注入的浏览器验证步骤和单测，一个实现。
>
> 验收：
> - 用浏览器拦截请求，逐一触发四种失败，每种都能看到明确提示；恢复资源后点重试能进入场景。
> - 正常冷启动控制台没有报错，`[init]` 各阶段计时还在。

**C `m9-prune-ny-runtime`，端口 8083**

> 任务：按 `docs/22-OPTIMIZATION-REVIEW.md` 的 A1、A2 末条和第 5 节 S1、S1c 执行。
>
> 步骤：
> 1. 先新增 `tests/runtime-reachability.test.cjs`：从 `js/main.js` 遍历相对 import，断言 `js/` 下每个 `.js` 都可达（`js/sz-mvp/` 暂时除外）。确认它对当前代码失败。
> 2. 按 A1 的表处理 17 个测试：整份删除的，先 grep 它是否还读其他在用文件；只删用例的，删之前查 `sz-traffic.js` 有没有对应行为，有就迁移用例，没有就在最后回复里列为缺口。
> 3. 删除 27 个纽约文件、两份 `.bin.gz`，清掉两处 `'./landmarks.js': {}` mock。
> 4. 删除 `js/sz-materials.js` 里的 `createGroundMaterial`、`createRoadMaterial` 和 `showLandmarkLights` 分支，确认 `js/sz-mvp/` 不依赖它们。
> 5. 更新 `docs/16-NY-REFERENCE.md` 开头和 `docs/01-ARCHITECTURE.md`，说明纽约代码只在 `ref/` 里。
>
> 子 agent 分工：按测试文件分组并行处理，但删除 `js/` 文件这一步由你统一做。
>
> 验收：
> - 测试全绿，可达性测试通过。
> - 浏览器冷启动无报错，四个时段画面和改前一致。
> - `git diff --stat` 里没有运行时逻辑改动。

**D `m6-drone-return`，端口 8084**

> 任务：修 `docs/REVIEW-FOLLOWUP-2026-11-10.md` 的 1.4（无人机到端点瞬移），然后做 `docs/22-OPTIMIZATION-REVIEW.md` 的 P10（无人机合成实例网格）。只改 `js/sz-drone-routes.js` 和对应测试。
>
> 要求：
> - 改成连续往返：用上初始相位，到端点翻转方向和朝向。测试要跨过至少两个端点，断言单帧位移不跳变、两端都能到达。
> - 停运日期仍停在起降点。
> - 航迹和高度仍标示意，不能说成真实航迹。
> - P10 合批后，绘制次数和画面都要前后对比。两项分两个提交。

**E `m9-road-surface`，端口 8085**

> 任务：做 `docs/22-OPTIMIZATION-REVIEW.md` 的 V1 和 V6，给沥青和标线加磨损、补丁、湿润和凹凸，读 `cityUniforms.uRoadWetness`（来自 `js/city-lighting-materials.js`）。
>
> 参考：`<MAIN>/ref/slop-newyork/js/tsl-materials.js` 的 `createRoadSurfaceMaterial`（1913 行）、`roadPuddleField`（1775 行）、`createRoadPaintMaterial`（2113 行）。只移植着色做法，不搬纽约的井盖、绿色自行车道这类街道样式。
>
> 文件范围：
> - 新材质放新文件（例如 `js/sz-road-material.js`），并加进 `index.html` 的 `modulepreload`。
> - 只改 `js/sz-roads.js`、`js/sz-road-paint.js`，不碰 `js/sz-materials.js`。
>
> 子 agent 分工：一个读参考代码，整理要移植的节点清单；一个实现。
>
> 验收：
> - 四个时段，同一个深南大道机位，改前改后各截一张。
> - 着色器编译耗时（`[init]` 的 compile）前后都记录。
> - 不改路面几何和接触。

### 协调者提示词

在主 checkout 里运行协调会话：

> 你是 Slop Shenzhen 的协调者，工作在主 checkout 的 `main` 分支。先读 `docs/HANDOFF.md` 和 `docs/NEXT-AGENT-PLAN.md` 的 worktree 并行计划。
>
> 你的职责：
> 1. 完成步骤 0：提交文档改动，清理旧 worktree，按计划开第一批 worktree。
> 2. 和用户一起在可见窗口里做 P0 性能基线，写进 `docs/22-OPTIMIZATION-REVIEW.md` 第 7 节。跑基线时，确认其他 worktree 没有打开 WebGPU 页面。
> 3. 各分支报告完成后，逐个审查 diff。不要直接相信报告，自己复跑测试，并在 8080 上冷启动验证。
> 4. rebase 到最新 `main` 后再合并。合并后更新 `docs/HANDOFF.md`、`docs/TASKS.md`、22 号第 7 节和 REVIEW 第 5 节。
> 5. 第一批的前置条件满足后，按计划开第二批。
>
> 有冲突时先停下来，问用户。

## 执行原则

优先做一个可验收的街区闭环，避免继续堆模型数量。顺序为：锁定现场 → 收尾当前模型/包 → 地面P0 → 道路与入口闭环 → 街区细化 → 其余硬性目标 → 全面性能与发布。没有地面依据时交付缺口，推进不依赖该缺口的工作，不以“更平”作为真实证明。

用户已授权并行，偏好主agent GPT-6 Astra/high规划与审核，执行子agent GPT-6.1 Sol/max。实际可用模型与身份如不同须如实说明，不声称已切换。最多安排三个互不重叠的执行组；主agent唯一负责共享构建、公共接口、浏览器与最终验收。沿用当前工作树，先保护未提交/未跟踪文件；不要让多个agent重建同一包或操纵同一浏览器。

## E0 锁定可接手状态（第一步）

**输入**：HANDOFF、git status/diff、当前包、原始快照清单、测试环境。

**行动**：

1. 核对分支/HEAD和所有未跟踪文件；把本轮基线保存为可恢复的本地归档或逐主题检查点，不包含密钥/原始大文件。不得为“干净”丢弃用户规划。
2. 确认Three 0.187.0测试依赖，跑Node全套及Python，报告skip。参照本轮352/47，不把历史数量作为必须硬编码的断言。
3. 记录现有gzip哈希，核对最新双标签gate与春茧清单v2；主agent运行默认build.py，逐对象和分块比较。预期标签防护仅增加报告字段，当前运行包仍为HANDOFF的38ce…；有其他差异先解释，不能覆盖基线后才找原因。
4. 本地浏览器冷重载，定位NFC记录中的两条消息通道异常，保存执行上下文/脚本归属及重现条件。扩展来源须有证据，无法归因则标未决。
5. 恢复普通URL、追尾相机、显示界面。记录环境、窗口/CSS尺寸、DPR、渲染比例、缩放、数据/代码版本。

**交付/通过**：当前树可恢复，包与报告可重复生成，全部回归无未说明失败；浏览器异常归因清楚。未解决的异常不得被写成冷启动验收通过。此项不等于M1/M2整体完成。

## E1 收尾中国有色大厦（与P0资料核验并行）

**范围**：`nonferrous-tower.js`及既有接入，源3部件；不扩大全城用途规则。

**行动**：补[模型卡](landmarks/nonferrous-tower.md)，用原照片2/3/4检查曲面朝向、弧阳台数量/退台、石材与玻璃比例、裙房柱廊。保留源总高/足迹，未知尺寸为外观估计。检查48实体是否相交、源界外占用、柱廊地面是否仍受DSM覆盖；渲染与碰撞共用部件。

**验收**：日/夜、地面/斜视至少四图；比较当前西南同机位前后；实际沿公共路侧到柱廊可达边界，无法到入口记录原因，不能传送到终点代替。缺源回退通用楼，不误删父/邻楼。误差和性能按10号；不得把照片拟合说成精确测绘。现有白天图是L4，L5未完成。

## E2 P0 地面与建筑接壤（最高优先级）

**首批仅选一个可取得充分依据的样区**：车公庙北侧街道/D1邻宗，或春茧封闭场馆边缘；不要同时改五处基础表面。

1. 完成`audit_chegongmiao_frontage_elevations.py`审核及QA卡：源PDF页码、纸面点、点的现状/设计类别、平面配准、独立校核残差、垂直基准、年代和所属地块。不得把深铁图纸点借给有色大厦。
2. 列缺口和公开来源尝试。官方目录不等于已获成果；不重复全量下载已审全球DEM。需要身份材料/申请/采购时只准备具体范围与字段，不自行提交。
3. 有可靠约束后才在管线增加派生工程面：控制点、坐标转换、影响边界、插值/拟合方法、不确定性、原DSM高差全记录。替换旧表面，保留原数据；共享边界顶点和同面接触。无可靠约束则停留在“候选/待取得”，可继续E1、来源审计和加载测量。
4. 闭合实体内部裁除须核围护、源足迹漂移、路径/入口冲突；不得将春茧内接方法全城泛化，不能挖开放广场/桥下或生成未知室内地板。

**通过**：限定样区满足QA-G01/G02/B01；实走“人行道—前场—真实入口”，实际合法方向驾驶跨接缝，检查脚/轮、路缘、裙房与绿地。数据误差、几何接触误差分开。没有真实入口证据或控制点，只能部分完成。

## E3 道路、信号与立交闭环

**范围**：复用深南红树林路口双向和北环新洲西向，不重复从头生成路网。审计源拓扑→转换图→显示路面→接触/控制四层。

- 北环东向先定位轮距横坡/姿态原因；高度缺证不能通过限制相机或拉平掩盖。
- 地图起终点验证可达/不可达、红灯等待、两方向交替、手动接管、到达后停止；每组绿3/黄1/红4秒为用户指定**模拟配时**，非深圳实测。
- 保留环境车，连续至少5分钟，记录数量、队尾、等待原因/持续时间、视锥外回收；不能删除可见车掩盖死锁。沿已核车道连接，未知桥隧标明不可达。
- 完整立交只有取得接入主线、上桥/桥面/下桥剖面与桥下关系后才做。无高程来源先交拓扑断点表，不统一桥高。

**通过**：QA-R01/R02；两向分别验（单向匝道只合法方向），显示/碰撞同面，桥上桥下不串层。实际自动驾驶和人工驾驶分开记录，窗口缺口不伪装连续耗时。

## E4 普通街区与公园样板

按13数据计划延伸已有车公庙办公、东海花园住宅候选、春茧/深圳湾公园样区。先各选1组，不直接整城扩。

- 保留OSM部件/父子关系、min_height和用途冲突。最低楼层换算单独标估计；来源空缺不推成城中村或别墅。
- 依据实景做塔裙/屋顶/窗墙/阳台/设备与真实入口。Overture同源数据不算第二独立证据；CMAB本轮无增量，先复用审计脚本而非强行接入。
- 公园仅使用源步道/树点/设施，15–30个对象/200–400m实际路径目标；球场需真实身份/边界/入口，没有就不造。树种、冠幅和模拟人流明确区分实测与估计。

**通过**：QA-B01/P01；无误删邻楼/内院填死/草穿楼/树挡路，真实输入走通入口与内部主路径，同配置图与性能对比通过后才扩范围。

## E5 补齐仍未实现的硬性目标

按依赖做，不能把“有规划”勾成完成：

| 目标 | 最小交付与验收 |
| --- | --- |
| 国际交流中心/APEC | 主体身份、屋面/院落、香蜜湖与入口；活动状态核实后主题开关及会场元素；不用官方会徽，QA-B01/UI01 |
| 无人机配送 | 逐站核坐标/日期，端点与路径证据分开；真实资料不足时仅展示站点/明确示意，不伪造运营线；物流机细模、停运条件、QA-A01 |
| 人才公园表演/福田灯光秀 | 独立核地点/场地/朝向与时间；表演复现或艺术模拟标明，不能称实时；夜景图、开关、帧时 |
| 地铁/高铁 | 地图线路与出口复核，补福田地面出入口/西丽工地；地下深度缺数据不造实测，QA-M01 |
| 超级总部 | 用户要求建好形态，设计与现状明确分开；C塔定位/连廊尺寸来源、碰撞/通道、多机位对照 |
| 车辆/乘员 | 本土体型无商标，坐姿/安全上下车与净空；自行车/四旋翼落点走通，QA-V01 |
| 14号探索体验 | E2/E3样板稳定后按F1→F2→F3→F4→F5/F6做地点索引/高亮、路线、安全切换、示意地铁、区域扩展；默认点选不直接传送 |

## E6 性能和可移交发布

加载/测量可与P0并行。压缩格式、分块流式、后处理等结构变更等表面契约稳定，按13网站计划小步做，保留原生模块开发入口。10号统一1440p预算、冷热各5次、固定地面/飞行路线、20分钟往返、缓存/资源释放必须完成。未通过的项列出实际数值与原因，不以局部HUD60FPS替代。

每批更新TASKS、HANDOFF、QA证据，再按主题审核diff和提交。只有完整里程碑全部通过才推送并标`baseline/m<N>`；当前不具备该条件。交接时恢复普通游玩状态。

## 并行任务所有权建议

| 执行者 | 可独立写入 | 避免同时写入 |
| --- | --- | --- |
| 来源/地面组 | 独立audit脚本、来源候选、P0卡 | 共享gzip、build.py、总来源清单由主agent合并 |
| 模型组 | 单个模型模块、专项测试、模型卡 | layout/materials/index/strings接入由主agent串行安排 |
| 交通/QA组 | 交通问题复现、定向测试、样段卡 | 控制器/共用接触接口先协调，浏览器只由主agent操作 |
| 主agent | 包/报告、公共接口、浏览器、跨模块审查和发布 | 不以子agent“完成”代替最终画面/实走审核 |

## 可直接给下一位的指令

把下面这段发给新的编码会话即可接续（取代已删除的 `NEXT-SESSION-PROMPT.md`）：

> 继续 Slop Shenzhen（正式入口 <http://127.0.0.1:8080/>，用 `python3 tools/sz/serve.py --port 8080` 常驻）。先读 `docs/HANDOFF.md`、`docs/CONVENTIONS.md`、`docs/10-PERF-QA.md`，保护未提交和未跟踪的工作。
>
> 功能修复按 `docs/REVIEW-FOLLOWUP-2026-11-10.md` 第 4 节，从自动裙房占道开始；优化按 `docs/22-OPTIMIZATION-REVIEW.md` 第 5 节，从 S1 删除纽约残留和 P0 性能基线开始。
>
> 约束：
> - 中文文档和注释，英文标识符和提交信息。
> - `ref/` 只读；生成文件只由 `build.py` 产出；不提交 `data/raw/` 和 `docs/qa/`。
> - 不能用 DSM 屋顶当道路，不全城压平，不按层级虚构桥高；估计值不写成实测。
> - 每次按 L1–L5 报告等级，实走、截图、来源和性能齐备才勾完成。
> - 每轮结束跑 Node 和 Python 测试，恢复普通游玩页面。
