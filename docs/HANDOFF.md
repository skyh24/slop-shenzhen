# 当前交接：Slop Shenzhen

更新：2026-11-10 晚。这份文件只写“现在是什么状态、下一步做什么”。轮次记录在 [HANDOFF-HISTORY-2026-11-10.md](HANDOFF-HISTORY-2026-11-10.md) 和 [HANDOFF-HISTORY-2026-11-09.md](HANDOFF-HISTORY-2026-11-09.md)，只作历史证据。

## 1. 当前状态

- **代码**：分支 `main`，HEAD `c687ba0`。正式入口 <http://127.0.0.1:8080/> 运行深圳，`index.html` 加载 `js/main.js`，可达 80 个文件、约 3 万行。`mvp.html` 只作历史参考。
- **共享包**：`js/sz-city.json.gz` 6,916,984 字节，SHA-256 `690c6d1e99fa642e9cefb756eaadd1f80b0dc7f612f7a486148c83f099bcce75`，由 `tools/sz/build.py` 生成。
- **数据**：36,064 栋普通楼，来源是 OSM 12,692、Overture 16,022、GloBFP 7,350，没有随机放置的楼，见 [21 号](21-FOOTPRINT-AND-STREET-AUDIT.md)。其中 4 栋楼高按公开资料修正，见 [20 号](20-BUILDING-HEIGHT-AUDIT.md)。另有约 5.9 万棵树（OSM 点位加标注为模拟的补种）。
- **测试**：2026-11-10 晚，Node 451 项通过、37 项跳过。跳过的是需要真实 Three 的用例，设置 `SZ_THREE_PACKAGE_DIR` 指向 Three 0.187.0 后会运行。Python 101 项通过。
- **验收**：九条硬性要求还没有一条整体通过；M9 性能未通过，所以没有 baseline 标签。逐条证据和缺口见 [ACCEPTANCE-STATUS.md](ACCEPTANCE-STATUS.md)。

## 2. 已经挂进场景的主要内容

| 方面 | 内容 | 等级 |
| --- | --- | --- |
| 地面和道路 | 派生路面（规则见 [03 号](03-ROADS-GROUND.md)）、路面标线、路口两相位模拟信号、车公庙立交 37 条桥面（可走；局部可驾驶） | L4；步行 Q8 局部 L5 |
| 建筑 | 1 km 合批普通楼、塔楼加裙房、屋顶设备、立面材质、近景阳台/空调/雨棚、楼名和小区门牌 | L4 |
| 地标 | `js/sz-landmarks/` 下 13 个专模，包括超级总部、国际交流中心、深圳湾大桥 | L3–L4 |
| 交通和人 | 30 辆环境车（纽约 loft 车身，深圳出租涂装和车牌）、按地点密度 40–140 人的环境人群（模拟步行带）、地图规划驾车、四旋翼座舱乘员 | L4 |
| 街景和夜景 | 主干道路灯、行道树 LOD、地铁出入口、福田站地面部分、西丽在建工地、福田灯光秀 | L4 |
| APEC 和低空 | 道旗、标识、花坛、大屏、机器人、围挡广告；无人机示意航线，管控期停在站点 | L4 |
| 界面 | 纽约原版 94 个元素 ID 全部保留，地图内地铁菜单、高铁和无人机图层 | L4；触屏和视觉逐项对照未做 |

## 3. 下一步

两条线可以并行，由不同的人做：

1. **功能修复**，按 [REVIEW-FOLLOWUP-2026-11-10.md](REVIEW-FOLLOWUP-2026-11-10.md) 第 4 节的顺序：
   1. 自动裙房占道（第一项）。
   2. 启动失败提示和重试。
   3. 屋顶设备越界、无人机端点瞬移。
   4. 高架车辆路线和同一角色上下车。
   5. M9 基线。
2. **优化**，按 [22-OPTIMIZATION-REVIEW.md](22-OPTIMIZATION-REVIEW.md) 第 5 节：
   - 架构：S1 删除纽约残留，然后合并重复函数、收窄 `main.js`、统一日夜 uniform。
   - 性能：先测 P0 基线，再改实例 storage 缓冲、楼名牌批次等。
   - 画面：路面材质、窗灯随黄昏变化、水面、近景树样板。

其余里程碑待办在 [TASKS.md](TASKS.md)；街区、地面 P0 和数据样区的长期规划在 [12](12-URBAN-FABRIC-PLAN.md)、[13](13-DATA-DETAIL-PILOT.md)、[14](14-CITY-EXPLORATION-PLAN.md)、[18](18-ROAD-BUILDING-CLEARANCE-PLAN.md)、[19](19-WEBSITE-OPTIMIZATION-PLAN.md) 号。

## 4. 已知风险

- 派生路面、立交层高（4.8 m/层）、超级总部和国际交流中心的平面与收分、灯光秀颜色、APEC 大屏位置都是估计，不能写成实测。
- 地面 DSM 隆起和白色大面（12 号 P0）仍在，影响街景真实感。
- 自动化浏览器的 WebGPU 帧率被固定在 30 Hz，不能作为 M9 证据；要在可见、聚焦的桌面窗口用 `tools/qa/perf-sample.mjs` 测。
- 偶发首帧卡在“等待图形引擎完成第一帧”，重载后正常，根因未定位。
- 内河水面在画面里没有画出来（`geo.water` 只进了空间索引），和 [ACCEPTANCE-STATUS.md](ACCEPTANCE-STATUS.md) 第 2 条写的“河道”口径不一致，需要在浏览器里确认，见 22 号 V3。
- `ref/` 只读；`data/raw/`、`docs/qa/` 只留本地。

## 5. 常用命令

```sh
python3 tools/sz/serve.py --port 8080
SZ_THREE_PACKAGE_DIR=<three-0.187.0 目录> node --test tests/*.test.cjs
.venv/bin/python -m unittest discover -s tools/sz/tests
.venv/bin/python tools/sz/build.py                    # 生成共享包和报告
```

## 6. 首读顺序

本文件 → [REVIEW-FOLLOWUP](REVIEW-FOLLOWUP-2026-11-10.md) 或 [22 号优化审查](22-OPTIMIZATION-REVIEW.md)（看你做哪条线）→ [规范](CONVENTIONS.md) → [验收标准](10-PERF-QA.md) → [架构](01-ARCHITECTURE.md) → 对应模块文档。
