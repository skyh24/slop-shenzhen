# 数据管线

## 1. 输入与输出

权威登记在 [sources.json](../data/source/sources.json)，许可见 [ATTRIBUTION](../data/source/ATTRIBUTION.md)。以下是仓库锁定输入，不是联网核实的最新版本。

| 来源 | 现用资料与用途 | 限制 |
| --- | --- | --- |
| OSM / Geofabrik | 广东 2026-11-08 快照；道路、建筑、地铁、水陆、公园、名称 | 标签完整度不一，编辑日期不等于观测日期 |
| Overture Buildings | 2026-10-21.0；补充足迹与部分属性 | 现有提取包络未随全图扩区；遥感补集与 GloBFP 有共同上游 |
| 3D-GloBFP | 参考年2020；补充足迹和预测高度 | 超出2025–2026目标窗口，不能当近期实测 |
| Copernicus GLO-30 | 当前 DSM 底座，25米重采样、分米编码 | EGM2008；有屋顶/树冠回波，采样密度不等于测绘精度 |
| FABDEM V1-2 | 道路派生面与城区基准样本 | 派生估计，CC BY-NC-SA 4.0 限制保留 |
| Terrain Tiles HGT | 旧地形对照 | 通过 `--terrain-source hgt` 对照，不是默认源 |
| 人工核对表 | 地标、楼高覆盖、道路前场、地坪、出入口与低空证据 | 每个字段保留身份、出处、日期与状态 |

```text
sources.json 校验文件 → OSM/建筑/地形处理 → 共享载荷 JSON v2
  → sz-city.json.gz（默认） + sz-city.szc.gz（本机对照） + 构建/校验报告
  → sz-geodata.js 单次读取 → GEO / REAL_BUILDINGS → 场景消费者
```

## 2. 生成与读取

```sh
python3 -m venv .venv
.venv/bin/pip install -r tools/sz/requirements.txt
.venv/bin/python tools/sz/build.py
```

原始文件按清单准备到 `data/raw/`；尚无统一 `fetch.py`。PBF 用 osmium，Shapefile 用 pyshp，不依赖 GDAL。OSM/GloBFP 缓存按内容哈希和处理版本失效；`--no-cache` 重解析。`--rebuild-ground` 复用经校验的包重建地面；`--repack-existing` 校验现有 JSON 载荷/来源后仅重编码 SZC1，不能借此更新地理事实。

常规构建同时产出两个包及报告，单执行者串行处理；冲突回到最新代码重建。对比对象属性、几何、数量、源摘要与范围外差异，保留前后哈希。报告并不自动包含全部对象差异。浏览器默认 JSON；仅回环地址 `?qa=1&data=szc` 使用 SZC1。读包检查 gzip 魔数，兼容服务器已解压响应。

滨水、地铁和配送的区域索引随城市包保存，分为三个带输入指纹的 `sz-regional/<fingerprint>/{waterfront,metro,drone}.json.gz` 资源，总压缩体积上限为 1,000,000 字节。区域挂载和接触准备仍按距离调度。堤岸、栏杆与步行路线引用城市包已有来源，重复网格和碰撞在运行时由共享函数展开。

### 运行时格式

JSON v2 与 SZC1 共用校验和解码入口。世界坐标沿用 `114.0545E, 22.5463N`，x 东、z 南、y 上，位置和高度用米，角度用弧度。楼体高度相对基底，表面高度是世界标高；道路 `layer` 表示上下关系。

建筑记录保留 `id`、`sourceId`、带孔足迹、相对高度和 `heightSource`，原始多面对象可以对应多个楼体部件。区域在解码时统一为 `id`、`kind`、`sourceIds` 和带孔的 `polygons`，地图与表现配置共用同一边界。旧 v2 包缺少区域时沿用场景默认；缺失的建筑分项可信度仍为 `null`。

道路紧凑数组保留原有拓扑。运行时检查节点与边身份、道路层级、桥隧字段和高宽来源，边身份以源道路 ID 加起终点节点 ID 校验。路段宽度、标线估计和活动表面之间的映射见 [道路](03-ROADS-GROUND.md)。表现配置有独立版本，读包后校验。 [参数规则](REGIONS-PLACES.md#场景参数)

## 3. 道路、地形与地铁

- `geo.py` 做固定原点投影与覆盖裁切；按香港 OSM 行政边界排除陆地，覆盖边缘保留采样邻点。准确范围读源码与包的 `coverage`。
- `roadgraph.py` 以共享 OSM 节点建有向图，保留单行、转向限制、桥隧层级、道路宽度及来源；平面相交不自动连通。条件通行仍需补核。
- `road_surface.py` 用 FABDEM/DSM 派生道路走廊，`terrain_surface.py` 生成裁切三角面；显示与接触采样同面。`urban-datum.json` 指定8米估计城区地坪、自然保留区、工程面和过渡带；不能宣称全域道路标高真实。
- 陆地裁出内河不代表已有水面；海面单独由 `sea_surface.py` 生成。桥面由运行时结构模块生成，layer 只提供上下关系。
- `metro.py` 按 `network=深圳地铁`、relation 成员和出入口归属提取，歧义隔离。关系数、物理线路数、站点数分别统计；颜色和站口另核运营方资料。

## 4. 建筑来源与过滤

`buildings.py` 保留真实外环、内院和部件。普通顺序为地标覆盖 → OSM高度 → OSM层数×3.2 → Overture高度/层数 → 严格同楼的GloBFP → 用途/体量估计；最后应用带出处的 `building-height-overrides.json`（`published`），报告原值和未命中项。设计模型高度单独标 `design`，不混入建成实测。

- 每楼保留 `heightSource`、部件角色、上游族及轮廓/高度/年代各自可信度；未知不强配。名称/层数仅供显示参考，不反推替代已知楼高。
- GloBFP 同楼匹配要求 IoU≥0.6、面积比≥0.65、中心距≤12米；没有宽松重叠回填。
- 补充轮廓按广场/绿地/水体/道路重叠及面积筛查。OSM 已标楼不因占路自动删除；道路宽度估计只能产生冲突候选。
- 占道暂缓只用于补充轮廓：中心线穿入超过0.5米或估算车行道占比≥50%；记录道路ID、宽度来源、影像是否核对，不能等同现实中无楼。全部阈值与具体顺序以生成器为准。
- 地标按已核源 ID / 父子关系替换；补充楼可能与高架存在合法竖向重叠，需另核净空。`--footprint-source osm` 仅作对照。

## 5. 报告与审计

[build-report.json](../data/source/build-report.json) 记录数量、来源、隔离项、地形处理与样区审计；[data-validation-report.json](../data/source/data-validation-report.json) 区分编码有效与真实性完成。检索用建筑 ID，不复制易过期的全城数量到各模块说明。

现有离线工具可检查道路高程、建筑来源、商圈铺装、购物公园与莲花山入口；方法和取舍见 [RESEARCH](RESEARCH.md)。只在相关来源或生成逻辑变化时重建，文档整理不重建。
