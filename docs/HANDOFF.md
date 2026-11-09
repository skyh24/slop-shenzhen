# 交接

更新：2026-11-09。仓库：<https://github.com/skyh24/slop-shenzhen>（公开，主分支 `main`）。

## 一句话现状

有一个能看的 MVP：`mvp.html` 用真实数据画出南山加福田（39,730 栋楼、2,674 公里道路、车流、无人机、飞行器），数据管线 `tools/sz/` 一条命令 12 秒跑完。但 MVP **很粗糙**：地标是棱柱、地面全平、无人机航线是编的、没有地铁、交互和纽约原版完全不同。**正式版的硬性要求写在 [11-MVP.md](11-MVP.md) 第 3 节**，接手后照它做。

## 阅读顺序

1. 本文件
2. [11-MVP.md](11-MVP.md)：MVP 做到哪里、哪里粗糙、**六条硬性要求和验收标准**
3. [CONVENTIONS.md](CONVENTIONS.md)：语言、代码风格、数据和验收规则，必须遵守
4. [RESEARCH.md](RESEARCH.md)：参考仓库的结论、武汉的教训、APEC 和地标核实、检索服务状况
5. [00-SCOPE.md](00-SCOPE.md)、[01-ARCHITECTURE.md](01-ARCHITECTURE.md)、[02-DATA-PIPELINE.md](02-DATA-PIPELINE.md)
6. [TASKS.md](TASKS.md)：按里程碑的勾选清单
7. 做到哪个模块再读对应的 03 到 10

## 里程碑状态

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 底座 | 完成 | 纽约原版在根目录，`ref/` 只读；纽约数据工具在 `tools/ny/`，只作参考 |
| MVP 预览 | 完成 | `mvp.html` 加 `js/sz-mvp/`，临时渲染器，正式版不保留 |
| M1 数据 | 进行中 | 投影、道路、陆地、建筑、一键生成已完成；地形、地铁、下载脚本、地标轮廓对位未做 |
| M1 打包 | 未开始 | MVP 用的是分米差分编码的 JSON 加 gzip；要不要换成二进制 `SZB1`，看正式版加载速度再定 |
| M2 到 M10 | 未开始 | |

## 下一步（按顺序做）

### 1. 准备环境

```sh
cd slop-shenzhen
python3 -m venv .venv            # 已存在可跳过
.venv/bin/pip install -r tools/sz/requirements.txt
.venv/bin/python tools/sz/build.py     # 首次运行解析 PBF 后写缓存
```

原始数据不在 Git 里。新机器上要按 `data/source/sources.json` 的地址重新下载到 `data/raw/`，再对一遍 SHA-256。这一步要写成 `tools/sz/fetch.py`。

### 2. 补完数据管线

| 文件 | 做什么 | 完成标准 |
| --- | --- | --- |
| `fetch.py` | 按 `sources.json` 下载、校验哈希 | 哈希不符就报错退出 |
| `terrain.py` | 用 `data/raw/terrain/*.hgt.gz` 生成高程网格 | 莲花山顶约 106 米，塘朗山、笔架山、银湖山都有起伏 |
| `metro.py` | `network=深圳地铁` 的线路、车站、出入口 | 车公庙站出入口和 OSM 一致，见 11-MVP 第 3.4 节 |
| `landmarks.py` | 7 个没绑上建筑的地标补绑定，地标轮廓对位 | `build-report.json` 的 `landmarksWithoutBuilding` 为空（公园类地标绑公园面） |
| `air.py` | 真实无人机站点和航线，带来源 | 见 11-MVP 第 3.3 节 |
| `geo.py` 测试 | 原点投影到 `(0, 0)`；平安金融中心约 `(-426, 1070)`，腾讯滨海大厦约 `(-12770, 2265)`，大疆天空之城约 `(-11985, -3774)`（误差 2 米内） | 写进 `tests/` |

### 3. 换上纽约引擎和界面（M2）

照 [01-ARCHITECTURE.md](01-ARCHITECTURE.md) 换掉 `city-config.js`、`city-grid.js`、`boroughs.js`，把 `tools/sz/` 的数据接进纽约的地面、路网、车辆、相机模块。界面和操作按 11-MVP 第 3.5 节**和纽约原版一一对应**。验收：从市民中心开车到深圳湾公园，不卡、不穿楼、路名正确；1 到 4 号移动方式、`V` 相机、`M` 地图都能用。

MVP 里能搬过去的：`js/sz-mvp/materials.js` 的立面着色器和夜景灯光、`traffic.js` 的出租车和绿牌、`air.js` 的飞行器和无人机模型。搬完删掉 `mvp.html` 和 `js/sz-mvp/`。

### 4. 之后

按 11-MVP 第 4 节的顺序：地标建模、地铁、真实无人机航线、观感和性能。

## 已知的坑

- **WGSL 保留字**：自定义顶点属性不能叫 `meta`（MVP 里改成了 `bmeta`），否则着色器编译失败、整批几何不显示，控制台只有一条警告
- **地铁数据混了广州和香港**：PBF 是全广东的，只按 `ref` 过滤会把广州 1 到 14 号线混进来，必须加 `network=深圳地铁`
- **范围外是海**：MVP 用一个外扩大框减去数据范围做远处陆地（`farLand`），正式版换成真实远景
- **建筑部件和外框**：有 `building:part` 时用部件替代外框，地标绑定要通过 `parentId` 传给部件，否则平安、春笋会丢绑定
- **计划初稿的坐标不能用**，以 `data/source/landmarks.json` 为准；原点已经改成市民中心主楼 `114.0545E, 22.5463N`
- **华强北在一期框内**，已从二期提前
- **世界之窗埃菲尔铁塔高度冲突**（OSM 170 米、公开资料 108 米），M4 之前要定
- **纽约数据管线测试已删除**（`tests/geodata.test.mjs`、`tests/overpass.test.mjs`），因为纽约原始数据没复制进来，这条管线也会被 `tools/sz/` 替换。M2 换掉纽约模块时，相关的纽约测试要一起换成深圳的
- **检索服务**：Tavily MCP 网关一直返回 429，但密钥正常，直接调 REST 接口能用；Perplexity 额度用完；Overpass 必须带 User-Agent。详见 [RESEARCH.md](RESEARCH.md) 第 5 节
- **本机没有 GDAL**（`ogr2ogr`），读 Shapefile 用 `pyshp`，读 PBF 用 `osmium`，不要引入 GDAL
- 静态服务器用 `python3 -m http.server 8080 --bind 127.0.0.1`，要常驻后台；跟着一次性命令启动会随命令退出
- WebGPU 需要安全上下文：用 `http://127.0.0.1` 或 `localhost` 打开，不要用局域网 IP

## 常用命令

```sh
python3 -m http.server 8080 --bind 127.0.0.1    # 打开 http://127.0.0.1:8080/
node --test tests/*.test.cjs                     # 当前 228 项
.venv/bin/python tools/sz/build.py               # 生成 MVP 数据，约 12 秒；--no-cache 重新解析 PBF
open http://127.0.0.1:8080/mvp.html              # MVP 预览，?time=night 看夜景
```

## 工作方式

上一轮写 MVP 时，大部分时间花在一次性生成大量代码上（41 次写文件、约 8 万字符），命令本身只跑了一两分钟，中间没有在浏览器里看效果，问题（`meta` 保留字导致建筑不显示）到最后才发现。接手时：

- 一次只做一个模块，写完马上在浏览器里看，截图对照实景
- 每个模块做完就提交，不要攒一大批改动
- 长时间运行的服务器要常驻后台，不要跟着一次性命令启动

## 给下一位执行者的启动提示

新开对话、切到主力模型后，可以直接粘贴：

> 你在 `slop-shenzhen` 仓库里继续做深圳城市漫游项目。先完整阅读 `docs/HANDOFF.md`、`docs/11-MVP.md`、`docs/CONVENTIONS.md`、`docs/RESEARCH.md`。`docs/11-MVP.md` 第 3 节的六条是硬性要求：还原建筑、还原地形地貌、真实无人机航线、地铁线路、交互和界面跟纽约原版一致、观感。按 `HANDOFF.md` 的“下一步”顺序做，每完成一项就勾选 `TASKS.md`、更新 `HANDOFF.md`，每个模块在浏览器里截图对照实景、跑测试、提交推送。和我对话用中文。

## 变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-11-09 | 完成 MVP 预览（`mvp.html`、`js/sz-mvp/`、`tools/sz/`）；新增 `11-MVP.md`，写明粗糙之处和六条硬性要求；调研真实无人机站点（美团）和地铁数据；改 08、09 号文档 |
| 2026-11-09 | 新增根目录 `AGENTS.md`，作为代理入口，汇总硬性规则和命令 |
| 2026-11-09 | 建立底座和全部规划文档；下载并锁定原始数据；核实 APEC 日期和会场（新增国际交流中心地标）；用 OSM 核实全部地标，改正坐标和原点；华强北提前到一期；删除依赖纽约原始数据的两份测试；新增 RESEARCH、CONVENTIONS、HANDOFF |
