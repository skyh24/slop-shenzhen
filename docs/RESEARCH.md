# 调研摘要与资料取舍

整理2026-11-12；以下归纳仓库既有调查，不代表本轮重新联网核实。版本/许可/来源地址以源清单为准；执行任务统一在TASKS，已失效的研究步骤不保留。

## 参考项目

| 参考 | 保留方法 | 深圳使用边界 |
| --- | --- | --- |
| `ref/slop-newyork` | `cars.js`连续车身、`pedestrians.js`骨架、`trees.js`实例/LOD、建筑局部窗格、输入/相机/音频 | 替换地理、体量与本地外观；原版模拟人数、街宽、灯时不是深圳事实 |
| `ref/slop-wuhan` | 现行入口`js/runtime/main.js`；离线来源融合、部件组织、桥/隧表面与出租车网络分层 | 显示与接触同面值得复用；掩膜外压平、固定基准扣减、估计桥高不能作为真实标高 |
| `ref/slop-cities` | 城市项目索引 | 仅作查找参考 |

只读副本不修改；按问题定位函数，不再维护整仓行号表。深圳当前实现入口见01号。

## 数据研究结论

| 资料 | 保留判断 | 后续条件 |
| --- | --- | --- |
| [Overture署名](https://docs.overturemaps.org/attribution/) / [CLSM](https://zenodo.org/records/8174931) / [GloBFP论文](https://essd.copernicus.org/articles/16/5357/2024/) | 深圳遥感补集大量同源，不能把Overture与GloBFP算成独立复核；GloBFP参考年2020 | 先审对象身份、轮廓与高度匹配，再考虑换源；旧高宽比/占道候选复用 |
| [深圳公开成果目录](https://pnr.sz.gov.cn/xxgk/gggs/content/post_12759228.html) | 已有目录线索含2025地形图/0.5m DOM、2024高精影像/LiDAR/LOD1.3；详细成果未取得 | 只准备申请/公开下载缺口，目录不等于可用成果 |
| Esri Wayback 43291 局部影像 | 已登记天空之城、福中三路、车公庙、北环小片；元数据采集日2026-01-25、绝对精度8.47m | 仅局部判读，不按像素当精测，不外推全城；地址与哈希在sources.json |
| [CMAB论文](https://www.nature.com/articles/s41597-025-04730-5) | 既有样区审核未采用；预测属性不能当实测用途/年代 | 只有新增字段价值和可靠几何匹配时重评 |
| [GlobalBuildingAtlas论文](https://essd.copernicus.org/articles/17/6647/2025/) / [代码](https://github.com/zhu-xlab/GlobalBuildingAtlas) | 未下载实测；上游重叠、2019影像与非商业许可限制，不列默认新增源 | 若后续评估，先确认许可和小区块样本，不能沿用全球精度当深圳精度 |
| [Overture交通](https://docs.overturemaps.org/guides/transportation/segments-and-connectors/) | segment/connector语义可对照，但大量来源为OSM | 须证明相对现有路图的实际增量，不把几何交叉当连接 |
| 官方总图 | [后海沄玺](https://pnr.sz.gov.cn/ns/tzgg/content/post_12649907.html)、[光峰总部](https://pnr.sz.gov.cn/xxgk/gggs/content/post_11520241.html)、[中兴总部](https://pnr.sz.gov.cn/gkmlpt/content/12/12291/post_12291649.html)可作塔裙/入口/竖向候选 | 先核版本、现状与设计差别，不能把在建方案当成熟样板 |

只用免费公开资料，目标2025–2026；现有旧资料仍注明年代。公开影像仅作核验，不自动加入发布包。数据署名和限制保留在 [ATTRIBUTION](../data/source/ATTRIBUTION.md)。

## 可复用的审计

| 对象 | 入口与方法 | 已有结果的限度 |
| --- | --- | --- |
| 高程/道路 | `tools/sz/audit_terrain.py`、`audit_terrain_candidates.py`、`audit_road_elevations.py`、`audit_chegongmiao_frontage_elevations.py` | DSM/FABDEM/控制点及纵横断面对比；未知垂直基准不硬拼 |
| 建筑父子/用途 | `audit_overture_chegongmiao.py`、`audit_cmab_chegongmiao.py`、`data/source/chegongmiao-parent-review.json` | 已审父子与用途，不等于逐层用途或真实入口核验 |
| 建筑来源八样本 | 本地`docs/qa/building-source-samples/`脚本、指标与叠图 | best-IoU为有向非一对一；不同年代/裁切边缘影响结果。深南—香蜜湖不等于滨河—香蜜湖车公庙节点；白石洲南区不在深南以北旧改范围，留仙洞不等于科苑科技园 |
| 商圈铺装 | `audit_commercial_paving.py`及`audit_commercial_paving_roads.cjs` | 统计源范围、kind=3地形三角面、生产沥青与楼足迹在XZ平面的并/交集；平面叠置不证明能步行，也未扣架空层 |
| 购物公园 | `audit_shopping_park.py`、`shopping-park-road-surface.mjs`、`data/source/shopping-park-audit.json` | 已留街块/场所/连接候选，公共开放和运行时接入仍待确认 |
| 莲花山 | `parks.py`与`data/source/streetscape-pilot.json`、构建报告 | 锁定快照4段约350.24m路线；入口净宽、台阶和桥头高程仍缺，非完整公园步行网络 |
| 明通 | [首层源卡](../data/source/mingtong-frontage-evidence.md) | POI落南侧足迹，旧门头照片不等于当前可进入；墙段/门心/净距未知 |
| 无人机 | [证据摘要](research/drone-routes.md)、`air-evidence.json`/`air-routes.json` | 航线端点、配对、轨迹、高度、运营日期分别判断 |

商圈只读复跑示例：

```sh
.venv/bin/python tools/sz/audit_commercial_paving.py
.venv/bin/python tools/sz/audit_commercial_paving.py --package current.json.gz --baseline previous.json.gz
```

用同一来源清单和同版生产几何逻辑比较两包；报告保存输入哈希、面积口径和未知项。历史工具按`urbanDatum.pilots`统计核心样区，当前包已扩为`coverage=phase1-dry-land`；先核统计口径适配，不能把缺pilots返回0解释为没有铺装。旧109,688m²、183,763m²等数值不作为当前面积事实。

## 临时资料怎样处理

- **保留**：原始出处、核实身份/尺寸、许可、不确定性、可复现脚本与有意义失败样本；机器事实归data/source，参考入口归本文/05号。
- **待优化**：区域模板、数据流式、地点探索、入口/步道/交通完善集中到TASKS，标明依赖；不再各写一份专项计划。
- **归档**：已修缺陷、试验回滚、坐标误判和测量教训浓缩到LESSONS；不让旧决策继续指导当前实现。
- **删除**：轮次/分支合并流水、重复测试数字、已完成操作步骤、旧MVP、旧范围/固定平面高度、失效工作树派工、完整导出行号表。原文保留在Git历史。

## 网站体积与启动成本核查（2026-11-12）

保留同时新增的调研提交`7ecdf7e`结论，原始详表可从该提交查阅。源码基线深圳`3c72f66`、纽约`536a907`、武汉`7a62402`；MB=1,000,000字节。本轮未测浏览器性能；执行归 [T10/S0–S4](TASKS.md#网站体积与启动专项)。

| 口径 | 已核文件值 | 限制 |
| --- | ---: | --- |
| 正式城市gzip / 解压JSON | 11.30 / 51.43 MB | 解压文本不是JS堆或显存 |
| 正式入口可达本地JS | 90文件，1.65 MB | 只按静态相对依赖去重，模块多不等于代码更多 |
| 本地运行资源合计 | 13.03 MB | 正式包+JS+HTML/CSS，不含CDN引擎/字体 |
| 加同版引擎源文件 | 约17.14 MB | 非网络实传；文本逐文件gzip估算约12.69 MB+字体/协议 |
| terrainSurface | JSON 27.08 MB，占52.65% | positions/indices/cellRanges/kinds；单字段gzip不能相加当整包分摊 |
| 其他主要字段 | buildings 9.53、roadGraph 6.61、terrain 2.43、roads 2.23、trees 1.65、metro 0.68 MB | 原始格网与活动地面有不同消费者，不能直接删一份 |
| SZC1相对JSON gzip | 多33,406字节，约0.30% | 不能凭“二进制”认定更快 |
| 同口径本地运行资源：纽约/武汉 | 3.32 / 5.34 MB | 深圳约3.93/2.44倍；排除引擎、字体、发布打包差异 |
| 运行建筑记录：纽约/武汉 | 37,353 / 23,819 | 不是现实独立楼栋数；深圳76,024 |

预编译进度的“1900+”来自`main.js::precompileShaders()`的`jobs.length`，是应用任务批次。普通网格按材质对象分组，实例/多材质网格单列，`sharesPipelineWith`复用代表对象，阴影替身不列入；任务可能多次compileAsync。它不是独立GPU管线数、下载量、楼数或draw calls；本轮未重现确切1900。纽约有同类计数，武汉显示百分比，不能凭显示不同判断少了编译。

预编译遍历当时可见层级并暂关视锥剔除；各组件成本待归因。相同材质名不保证属性、节点、阴影/透明/MRT配置等价；取消预编译可能把卡顿移到首次转头或切时段。行为以锁定r187源码为准，参考[Renderer文档](https://threejs.org/docs/pages/Renderer.html)。

开发服务本地响应no-store，刷新不是完整生产热缓存。HTML固定预取JSON，SZC1对照须检查额外JSON下载。网络应区分传输/HTTP解码/应用gzip解压；跨域Timing-Allow-Origin限制可能使transferSize为0，不能全判缓存命中。[资源计时](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming/transferSize)

当前完整首访、冷/热可操作时间、稳定FPS、CPU、JS堆、进程RSS和总显存均未测。raw与decoded部分共享引用，不能按全数据翻倍估内存；Canvas纹理虽不下载仍占资源。旧范围性能数字不再用于当前承诺。开发目录含raw/ref/QA/Git，删除这些不会降低当前页面下载。

取舍：先测量，再移出无消费者的启动审计、复用真正等价预编译、试一个地表无损表达、做独立发布白名单/文本压缩/内容版本缓存。现有图集、分块、树LOD、细节卸载和日夜uniform保留，不重复实现。Worker、新打包工具、默认SZC1、全城流式与降画质均非默认方案。

复现：锁定提交/包哈希，stat+gzip计字节；从正式入口递归静态import/export并去重，不计注释示例；按import map核本地同版Three依赖；顶层字段紧凑序列化后单独测量。网络与运行成本另做HAR、前台稳定段和内存生命周期测量，不能由文件量推速度。
