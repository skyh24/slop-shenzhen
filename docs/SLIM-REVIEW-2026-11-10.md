# 代码精简审查与执行计划

日期：2026-11-10。审查基线：`main` 的 `cea0d99`，并包含当时工作树里已暂存的车辆和行人合并改动。

本次只审查和写计划，没有改运行时代码，也没有跑浏览器。下面的行数和行号按当时的工作树统计，执行前要用第 4 节的命令重新核对。

参照对象是纽约原版的模块边界，模块地图见 [16-NY-REFERENCE.md](16-NY-REFERENCE.md)。这份计划只处理臃肿、重复和入口连线，不改变画面和玩法。功能缺陷仍按 [REVIEW-FOLLOWUP-2026-11-10.md](REVIEW-FOLLOWUP-2026-11-10.md) 的顺序处理，那边的 P1 裙房占道仍是第一项实现任务。

## 1. 结论

1. `js/` 里有 27 个纽约文件、23,805 行，从正式入口 `js/main.js` 出发一个都加载不到。正式入口实际加载 76 个文件、27,766 行。另有两份纽约数据包 `js/building-geodata.bin.gz`（441 KB）和 `js/tree-geodata.bin.gz`（123 KB）也没有使用。
2. 深圳模块之间有成组复制粘贴的工具函数。例如 `mergeParts` 有两份逐行相同的实现，一整组环形几何函数在两个文件里各有一份。
3. `js/main.js` 有 1210 行，纽约版是 796 行，超过 AGENTS.md 约 1000 行的上限。多出来的主要是 QA 钩子、场地接管逻辑和逐个模块重复传参。
4. 日夜状态有两套全局 uniform，靠入口手工同步。
5. `js/sz-station-sites.js` 有 1008 行，同样超限。

## 2. 发现

### F1 纽约残留代码

`index.html` 没有预加载这些文件，`main.js` 的 import 链也不会走到：

| 规模 | 文件 |
| --- | --- |
| 3,000 行以上 | `city-grid.js` 3544、`tsl-materials.js` 3454、`boroughs.js` 3367 |
| 1,000–2,500 行 | `traffic.js` 2468、`nyc-map.js` 1266、`trees.js` 1238、`road-network.js` 1183、`street-details.js` 1137、`landmarks.js` 1070 |
| 更小 | `buildings.js`、`city-config.js`、`pedestrian-system.js`、`bus.js`、`helicopter.js`、`fire-escapes.js`、`road-paint.js`、`pedestrian-routes.js`、`street-props.js`、`building-details.js`、`subway-entrances.js`、`building-footprints.js`、`tree-placements.js`、`building-geodata.js`、`tree-geodata.js`、`nyc-geodata.js`、`subway-geodata.js`、`sz-buildings-data.js` |

问题不只是体积。仓库里同时有纽约的 `traffic.js` 和深圳的 `sz-traffic.js`，也同时有 `trees.js` 和 `sz-trees.js`，读代码的人很难分清哪份在运行。纽约原样副本保存在只读的 `ref/slop-newyork/`，删掉 `js/` 下这份不会丢失参考。

仍在使用、必须保留的纽约来源文件：音频五个文件、`building-collision.js`、`cameras.js`、`cars.js`、`city-lighting-materials.js`、`controllers.js`、`gamepad-controls.js`、`lighting.js`、`pedestrians.js`、`post-processing.js`、`scene-culling.js`、`touch-controls.js`、`vehicle-lights.js`、`vehicle-physics.js`、`vehicles.js`。

有 17 个测试按路径读这些死文件，删除前必须先处理：

| 处理 | 测试 | 读的死文件 |
| --- | --- | --- |
| 整份删除 | `building-details`、`building-footprints`、`building-geodata`、`fire-escapes`、`nyc-map`、`pedestrian-routes`、`pedestrian-signals`、`tree-geodata`、`tree-placements`、`trees`、`road-paint`、`smoke-texture`、`water-material`、`facade-projection` | 只测纽约模块 |
| 只删相关用例 | `building-collision.test.cjs` 133–149 行 | `road-network.js` |
| 只删相关用例 | `car-wheels.test.cjs` 277 行起的 `renderCar` 用例 | `traffic.js` |
| 只删相关用例 | `vehicle-physics.test.cjs` 181 行起的 `trafficHarness` 及依赖它的用例 | `traffic.js` |

两个测试里还有指向死模块的过时 mock：`controllers.test.cjs` 54 行和 `pedestrians.test.cjs` 658 行的 `'./landmarks.js': {}`。

`car-wheels` 和 `vehicle-physics` 被删的用例测的是纽约车流里的车轮样式写入、玩家碰撞冲量和动量守恒。删之前要查 `sz-traffic.js` 有没有对应行为：有的话就把用例迁到深圳实现上；没有就在本文第 5 节记一条缺口。不能为了保留测试而保留死代码。

### F2 临时 MVP

`js/sz-mvp/`（543 行）和 `mvp.html` 是历史预览。AGENTS.md 写的是正式版接管后删除，但同一文件也把 `mvp.html` 写成“历史参考”。删除前需要用户确认。确认删除时，以下几处要一起处理：

- `tests/sz-air-evidence.test.cjs` 33 行读 `js/sz-mvp/air.js`。要迁到正式的 `sz-drone-routes.js`，或改为直接校验 `data/source/air-routes.json`。
- `tools/sz/build.py` 174 行删除旧的 MVP 数据文件。整个目录删掉后，这一行可以去掉。
- `tools/sz/buildings.py` 40 行、`tools/sz/roads.py` 9 行的注释说编号“和 `js/sz-mvp/...` 一一对应”。立面编号的正式对照在 `js/sz-materials.js` 27 行；道路等级要先在正式运行时代码里找到对应表，再改注释。
- AGENTS.md、`docs/README.md`、`docs/HANDOFF.md`、`docs/TASKS.md`、`docs/09-UI-GAMEPLAY.md`、`docs/11-MVP.md` 里提到 `mvp.html` 的地方要同步。

### F3 深圳模块之间的重复工具函数

| 函数 | 份数 | 位置 |
| --- | --- | --- |
| `mergeParts` | 2，逐行相同 | `sz-station-sites.js` 137，`sz-metro-entrances.js` 280 |
| `ringArea` | 4 | `sz-buildings.js` 26，`sz-light-show.js` 15，`sz-apec-city.js` 86，`sz-station-sites.js` 38 |
| `ringPerimeter`、`ringCentroid`、`sampleRing`、`distanceToRing`、`largestRing`、`outerRings` | 各 2 | `sz-apec-city.js` 86–158、`sz-station-sites.js` 27–264，整组重复 |
| `canvasTexture` | 3 | `sz-apec-city.js` 407，`sz-metro-entrances.js` 163，`sz-station-sites.js` 119 |
| `finitePoint` | 3 | `sz-street-lamps.js` 17，`sz-apec-city.js` 82，`sz-metro-entrances.js` 43 |
| `landmarkCenter` | 2 | `sz-apec.js` 223，`sz-apec-city.js` 76 |
| `polygonContains` | 3 | `building-collision.js` 1，`sz-spatial.js` 18，`sz-trees.js` 67；另有 `sz-pedestrians.js` 113 的 `pointInPolygon` 和 84 的 `polygonArea` |

`polygonContains` 有两种语义，不能互换：

- `building-collision.js` 用奇偶规则，点正好落在边上时结果不确定。
- `sz-spatial.js` 的 `ringContains` 把落在边上的点算作在内。

合并时要保留这两种语义，并用不同的函数名区分。逐个调用点确认原来用的是哪一种。

纽约没有这一层工具，因为它的数据是方格网。深圳几乎每个模块都在处理真实多边形，所以值得有一个共享的纯函数模块。

空间分桶也有很多份：`sz-trees.js`、`sz-traffic.js`、`sz-pedestrian-tracks.js`、`sz-pedestrians.js`、`sz-controller-surfaces.js`、`sz-apec.js`、`controllers.js` 各写了一套，格子键有字符串和数值两种。`sz-spatial.js` 只被 `sz-city-config.js` 使用。这一项先不合并，原因见 S5。

### F4 `main.js` 的连线

| 位置 | 现状 | 方向 |
| --- | --- | --- |
| 180–190 行 | 入口里用三层循环，把超级总部、西丽工地范围内的普通楼加进 `skipIds` | 并到 `sz-landmarks/layout.js` 的接管逻辑里，和地标接管放在一起 |
| 196–240 行 | `groundHeight`、`roadHeight`、`colliders`、`pathAt`、`isWater` 分别传给七八个构建函数 | 建一个场地上下文对象，构建函数从中取用 |
| 212–215、220–223 行 | IEC 门廊和花海锚点对象写了两遍 | 只构造一次 |
| 243–248、786–827、1123–1151 行 | 47 处 `qa` 判断：十个模块挂到 `window`，六个 `__sz*` 调试函数，帧采样 | 移到 `js/sz-qa.js` |
| 1062–1088 行 | 帧循环里逐个模块调用 `update`，三个模块各传一次夜间系数，灯光秀的显隐写在入口里 | 夜间系数改由 uniform 读取，见 F5 |

`sz-qa.js` 要在 `main.js` 顶部静态 import，只在 `qa` 成立时调用安装函数。仓库规则禁止在函数体内动态 import。

### F5 两套日夜 uniform

- 纽约的 `cityUniforms` 在 `city-lighting-materials.js`，由 `lighting.js` 297–303 行在切换时段时写入。
- 深圳的 `sceneUniforms.night` 在 `sz-materials.js`，由 `main.js` 542 行在 `selectTime` 里从 `lightingSystem.uNightFactor` 抄过去。
- 路灯、APEC 主题和城市元素又在每帧拿 `uNightFactor.value` 当参数。

`cityUniforms.uRoadWetness` 每次切换都会写入，但深圳的路面材质没有读它。这不是错误，只是不要把它当成深圳已经有路面湿度。

### F6 超长文件

| 文件 | 行数 | 处理 |
| --- | --- | --- |
| `js/main.js` | 1210 | 见 F4 |
| `js/sz-station-sites.js` | 1008 | 抽走 F3 的环形工具和 `mergeParts` 后预计降到约 800 行，不用另外拆分 |
| `js/sz-map.js` | 941 | 接近上限，本轮不动 |
| `controllers.js` 1355、`cars.js` 2110、`pedestrians.js` 2213 | — | 纽约原样保留、正在使用的引擎，[01-ARCHITECTURE.md](01-ARCHITECTURE.md) 要求少改或不改。本计划不拆 |

## 3. 执行计划

总规则：

- 每个任务一个分支，提交信息用英文祈使句。
- 这是纯整理，不改画面和玩法，不重建 `js/sz-city.json.gz`。
- 不动 `ref/`。
- 每个任务都要跑 Node 全套测试和 Python 测试；改了启动流程的任务还要在浏览器冷启动。

### 开工前

1. 先跑 `git status`。审查时 `js/main.js`、`js/cars.js`、`js/sz-traffic.js`、`js/sz-vehicles.js`、`tests/car-wheels.test.cjs` 等文件上有别人已暂存、未提交的车辆和行人合并改动，`docs/` 里也有未提交的文档。这些改动要先由负责人提交，不要混进本计划的分支，也不要为了“干净”丢弃。
2. 用第 4 节的脚本重新统计可达文件。数字和本文不同时，以重新统计的结果为准，并在交付说明里写明差异。

### S1 删除纽约残留（分支 `m9-prune-ny-runtime`）

**依赖**：开工前第 1 步完成。不碰 P1 裙房修复涉及的文件，可以和 P1 并行。

**步骤**：

1. 新增 `tests/runtime-reachability.test.cjs`：从 `js/main.js` 沿相对 import 遍历，断言 `js/` 下（`js/sz-mvp/` 除外，直到 S1b 完成）每个 `.js` 都能到达。这样以后再有死文件会被测试拦下来。
2. 按 F1 的表处理 17 个测试。每份测试整份删除前，先 grep 它是否还读了其他 `../js/` 文件。如果有，就只删相关用例。
3. 删除 F1 列出的 27 个文件和两份 `.bin.gz`。
4. 清理两处过时 mock。
5. `tests/boot.test.cjs` 33 行断言入口不加载 `nyc-geodata.js`，保留。
6. 更新 [16-NY-REFERENCE.md](16-NY-REFERENCE.md) 开头：说明纽约代码只在 `ref/slop-newyork/`。更新 [01-ARCHITECTURE.md](01-ARCHITECTURE.md) 的模块矩阵，把“替换”的纽约文件标成“已从 `js/` 删除”。

**通过条件**：

- 可达性测试通过，Node 全套和 Python 测试全部通过。
- 交付说明列出删除的测试用例及原因，以及 `sz-traffic.js` 没有对应行为的缺口。
- 浏览器冷启动 <http://127.0.0.1:8080/>，控制台没有报错。
- `git diff --stat` 只有删除和上述测试、文档改动，没有运行时逻辑改动。

### S1b 删除 MVP（分支 `m9-remove-mvp`）

**依赖**：S1 完成，并且用户确认可以删 `mvp.html`。没有确认就跳过，在交接里标“待确认”。

**步骤**：按 F2 的清单迁移 `sz-air-evidence` 测试，删除 `js/sz-mvp/` 和 `mvp.html`，修正 Python 注释和 `build.py` 174 行，同步各处文档。可达性测试去掉 `sz-mvp` 的例外。

**通过条件**：Node 和 Python 测试通过。`.venv/bin/python tools/sz/build.py` 的输出哈希和删除前一致；只改注释和清理语句，不应改变数据。

### S2 合并重复工具函数（分支 `m9-shared-geometry-utils`）

**依赖**：S1 完成。`sz-buildings.js` 的 `ringArea` 要等 REVIEW-FOLLOWUP 的 P1 裙房修复合入之后再改，或者交给 P1 的负责人顺手改，避免两边冲突。

**步骤**：

1. 新建一个不依赖 three.js 的纯函数模块（建议 `js/sz-polygon.js`），放 F3 里的环形和多边形函数。
2. 新建一个网格工具模块（建议 `js/sz-mesh-utils.js`），放 `mergeParts` 和 `canvasTexture`。
3. `polygonContains` 按 F3 的两种语义分别命名并保留，逐个调用点确认语义后改成导入。
4. 各模块删除本地副本，改成导入。
5. 新模块加入 `index.html` 的 `modulepreload`。

**通过条件**：

- 新模块有单元测试，覆盖凹多边形、带洞多边形、点落在边上、空环和退化环。
- 原有测试全部通过。
- `sz-station-sites.js` 降到 1000 行以内。
- 浏览器冷启动无报错。抽查地铁出入口、福田站、西丽围挡和 APEC 大屏，各截一张图，和改前同机位对比无差异。截图放 `docs/qa/slim/`（只留本地）。

### S3 收窄 `main.js`（分支 `m9-main-wiring`）

**依赖**：S2 完成，`main.js` 上的他人改动已提交。和任何正在改 `main.js` 的任务串行。

**步骤**：

1. 新建 `js/sz-qa.js`，承接 F4 列出的 QA 代码。在 `main.js` 顶部静态 import，只在 `?qa=1` 且主机是 `127.0.0.1` 或 `localhost` 时调用。
2. 180–190 行的场地接管并入 `sz-landmarks/layout.js`，由 `buildSzLandmarks` 一起返回 `skipIds`。
3. 引入场地上下文对象，替换 196–240 行的重复传参；IEC 锚点只构造一次。
4. 启动阶段名、加载进度和 `[init]` 计时日志保持不变。

**通过条件**：

- `main.js` 低于 1000 行。
- 浏览器冷启动无报错，`[init]` 各阶段仍在。
- 普通地址下 `window` 上没有 `__sz*`。
- `?qa=1` 下以下函数仍然可用：`__szTeleport`、`__szNearTraffic`、`__szSurfaceAt`、`__szTeleportRoad`、`__szTeleportNear`、`__szNearColliders`，以及原来挂出的十个模块对象。
- 超级总部和西丽场地内没有旧普通楼重叠，截图对比。
- 结束时恢复普通游玩页面。

### S4 统一日夜 uniform（分支 `m9-night-uniform`）

**依赖**：S3 完成。

**目标**：时段切换时只写一处，模块直接读 uniform，入口不再转手，帧循环不再给模块传夜间系数。`lighting.js` 是纽约引擎文件，改动只限于让它写入深圳的夜间 uniform；具体做法由执行者选，交付说明里写清楚。

**通过条件**：

- 四个时段逐一切换，路灯、灯光秀、APEC 大屏和城市元素的夜间表现和改前一致。每个时段至少一张同机位对比图。
- 测试通过，浏览器无报错。

### S5 空间分桶（暂缓）

先按 [10-PERF-QA.md](10-PERF-QA.md) 在可见、聚焦的窗口测出帧时基线，证明某个分桶确实是瓶颈再动。只为了“统一写法”不值得改：这些分桶的格子大小和键格式各有理由，改错会影响交通、行人和接触。

## 4. 复核命令

可达性统计（在仓库根目录运行）：

```sh
python3 - <<'PY'
import os, re
imp = re.compile(r"""(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]""", re.S)
seen, stack = set(), ['js/main.js']
while stack:
    f = stack.pop()
    if f in seen or not os.path.exists(f): continue
    seen.add(f)
    for m in imp.finditer(open(f).read()):
        stack.append(os.path.normpath(os.path.join(os.path.dirname(f), m.group(1) or m.group(2))))
allf = {os.path.join(d, x) for d, _, fs in os.walk('js') for x in fs if x.endswith('.js')}
for f in sorted(allf - seen): print(f)
PY
```

审查时这段脚本输出 35 个文件：F1 的 27 个，加 `js/sz-mvp/` 下的 8 个。

测试：

```sh
node --test tests/*.test.cjs
.venv/bin/python -m unittest discover -s tools/sz/tests
```

浏览器：先 `python3 tools/sz/serve.py --port 8080`，再打开 <http://127.0.0.1:8080/> 和 <http://127.0.0.1:8080/?qa=1>。

## 5. 交付记录

执行者在这里追加：分支、提交、删除和迁移的测试、新发现的缺口、截图位置。不要改写上面的审查结论。
