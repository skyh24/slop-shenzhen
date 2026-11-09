# 交接

更新：2026-11-09。仓库：<https://github.com/skyh24/slop-shenzhen>（公开，主分支 `main`）。

## 一句话现状

规划、调研、规范都写完了；纽约原版已复制成底座，本地能跑，测试 228 项全过；原始数据下载完并锁定了哈希；地标 OSM 绑定已核实。**还没写任何深圳运行代码**，下一步从 M1 的 `tools/sz/` 导入器开始。

## 阅读顺序

1. 本文件
2. [CONVENTIONS.md](CONVENTIONS.md)：语言、代码风格、数据和验收规则，必须遵守
3. [RESEARCH.md](RESEARCH.md)：参考仓库的结论、武汉的教训、APEC 和地标核实、检索服务状况
4. [00-SCOPE.md](00-SCOPE.md)、[01-ARCHITECTURE.md](01-ARCHITECTURE.md)、[02-DATA-PIPELINE.md](02-DATA-PIPELINE.md)
5. [TASKS.md](TASKS.md)：按里程碑的勾选清单
6. 做到哪个模块再读对应的 03 到 10

## 里程碑状态

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 底座 | 完成 | 纽约原版在根目录，`ref/` 只读；纽约数据工具在 `tools/ny/`，只作参考 |
| M1 数据 | 进行中 | 原始快照和 `sources.json` 完成；`landmarks.json` 绑定完成，剩几项楼高；导入器未开始 |
| M1 打包 | 未开始 | `SZB1` |
| M2 到 M10 | 未开始 | |

## 下一步（按顺序做）

### 1. 准备环境

```sh
cd slop-shenzhen
python3 -m venv .venv            # 已存在可跳过
.venv/bin/pip install -r tools/sz/requirements.txt   # 现缺 pyshp
```

原始数据不在 Git 里。新机器上要按 `data/source/sources.json` 的地址重新下载到 `data/raw/`，再对一遍 SHA-256。这一步应写成 `tools/sz/fetch.py`。

### 2. 写 `tools/sz/`（M1 数据）

按 [02-DATA-PIPELINE.md](02-DATA-PIPELINE.md) 的步骤，建议文件和顺序：

| 文件 | 做什么 | 完成标准 |
| --- | --- | --- |
| `fetch.py` | 按 `sources.json` 下载、校验哈希 | 哈希不符就报错退出 |
| `geo.py` | 局部切平面投影，范围框裁切，多边形工具 | 单元测试：原点投影到 `(0, 0)`；平安金融中心约 `(-426, 1070)`，腾讯滨海大厦约 `(-12770, 2265)`，大疆天空之城约 `(-11985, -3774)`（误差 2 米内） |
| `roads.py` | OSM highway 转纽约 `roadGraph` 格式 | 最大强连通部分占可驾驶总长 90% 以上 |
| `land.py` | 海岸线闭合成陆地，水体、公园、街区 | 深圳湾海面、香蜜湖、人才公园湖面都在 |
| `buildings.py` | OSM 加 Overture 合并去重，GloBFP 匹配，楼高六级来源 | 每栋都有 `heightSource`；`landmarks.json` 里的对象全部命中 |
| `terrain.py` | 莲花山、塘朗山等山体掩膜内抬高 | 莲花山顶约 100 米上下 |
| `build.py` | 串起以上步骤，写 `data/source/build-report.json` | 一条命令从原始数据跑到输出 |

可以照着抄的武汉代码：`ref/slop-wuhan/tools/build-wuhan.py`（投影、道路宽度）、`building_attributes.py`（属性）、`core_geometry.py` 里的 `HeightMatcher`（GloBFP 匹配阈值）。

### 3. SZB1 打包和浏览器加载（M1 打包）

在纽约 `js/building-geodata.js` 的 `NYB1` 解码器基础上加三个字节字段（用途、立面类型、高度来源）。验收：浏览器里能把 `REAL_BUILDINGS` 读出来，楼栋数和 `build-report.json` 一致。

### 4. M2 第一个能开车的空城

照 [01-ARCHITECTURE.md](01-ARCHITECTURE.md) 换掉 `city-config.js`、`city-grid.js`、`boroughs.js`。验收：从市民中心开车到深圳湾公园，不卡、不穿楼、路名正确。

## 已知的坑

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
.venv/bin/python tools/sz/build.py               # M1 完成后可用
```

## 给下一位执行者的启动提示

新开对话、切到主力模型后，可以直接粘贴：

> 你在 `slop-shenzhen` 仓库里继续做深圳城市漫游项目。先完整阅读 `docs/HANDOFF.md`、`docs/CONVENTIONS.md`、`docs/RESEARCH.md`，再按 `docs/TASKS.md` 从 M1 数据开始做。每完成一项就勾选 `TASKS.md`、更新 `HANDOFF.md`，每个里程碑跑测试、在浏览器里验收并提交推送。和我对话用中文。

## 变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-11-09 | 新增根目录 `AGENTS.md`，作为代理入口，汇总硬性规则和命令 |
| 2026-11-09 | 建立底座和全部规划文档；下载并锁定原始数据；核实 APEC 日期和会场（新增国际交流中心地标）；用 OSM 核实全部地标，改正坐标和原点；华强北提前到一期；删除依赖纽约原始数据的两份测试；新增 RESEARCH、CONVENTIONS、HANDOFF |
