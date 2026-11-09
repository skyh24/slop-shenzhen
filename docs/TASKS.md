# 任务拆分

每个里程碑结束时必须能在浏览器里跑起来。状态：`[ ]` 未开始、`[~]` 进行中、`[x]` 完成。

## M0 底座

- [x] 把 `ref/slop-newyork/` 复制到仓库根目录（`ref/` 保留只读）
- [x] `git init`，加 `.gitignore`（`data/raw/`、`.venv/`、`node_modules/`）
- [x] 保留纽约原版 `LICENSE` 和作者署名，README 写明派生关系
- [x] 本地 `python3 -m http.server 8080` 跑起纽约原版，确认能进入

## M1 数据

- [ ] `tools/sz/fetch.py`：下载并记录哈希到 `data/source/sources.json`
- [ ] `tools/sz/geo.py`：投影、多边形工具
- [ ] `tools/sz/roads.py`：可驾驶路网图、路面多边形、信号路口
- [ ] `tools/sz/land.py`：海岸、水系、公园、街区
- [ ] `tools/sz/buildings.py`：OSM 加 Overture 合并、GloBFP 匹配、楼高、用途、立面类型
- [ ] `tools/sz/terrain.py`：山体掩膜地形
- [ ] `tools/sz/landmarks.py`：地标轮廓对位
- [ ] `tools/sz/build.py`：一键生成，输出 `build-report.json`
- [~] `data/source/landmarks.json`：地标 OSM 绑定已核实，剩余楼高冲突和缺口见文件里的 `status`
- [x] 核实 APEC 2026 深圳的日期和会场（11 月 18 至 19 日，福田香蜜湖深圳国际交流中心）
- [x] `data/source/sources.json`：会前快照的地址、日期、SHA-256
- [ ] 会后（11 月 20 日之后）重新下载 OSM 快照，对比差异

## M1 打包

- [ ] `SZB1` 编码器（Python）
- [ ] `js/sz-buildings-data.js` 解码器，导出 `REAL_BUILDINGS`
- [ ] `js/sz-geodata.js`，导出 `GEO`

## M2 地面

- [ ] `js/city-config.js` 深圳版（同名导出）
- [ ] `js/sz-ground.js`：海、陆地、路面、街区、公园、山体
- [ ] `road-network.js` 陆地判断改为多边形
- [ ] `controllers.js`：出生点、范围、海面、山体高度
- [ ] `main.js`：换掉纽约模块，暂时去掉纽约地标和远景
- [ ] 验收：能开车跑遍一期范围

## M3 建筑

- [ ] `buildings.js` 去掉纽约专属细节
- [ ] 六种深圳立面材质
- [ ] 中文店招、空调外机、楼顶障碍灯
- [ ] 地标让位

## M4 一期地标

- [ ] `js/landmarks/index.js` 对位框架
- [ ] 腾讯滨海大厦
- [ ] 华润春笋
- [ ] 人才公园
- [ ] 大疆天空之城
- [ ] 世界之窗
- [ ] 深圳湾公园（含春茧）
- [ ] 车公庙片区
- [ ] 深圳国际交流中心和香蜜湖（APEC 主会场）
- [ ] 市民中心
- [ ] 平安国际金融中心
- [ ] 会展中心
- [ ] 深业上城
- [ ] 华强北（电子科技大厦、赛格广场、步行街），已确认在一期范围内

## M5 地面交通

- [ ] 车牌图集 `plates.js`
- [ ] 蓝色出租车涂装
- [ ] 国产车调色板和配比
- [ ] 公交涂装和线路牌
- [ ] 电动车声音

## M6 空中

- [ ] `evtol.js` 模型
- [ ] 控制器调参、起降点
- [ ] `drones.js` 和航线数据
- [ ] 地图上显示航线

## M7 街景

- [ ] 深圳树种
- [ ] 路灯、信号灯
- [ ] 地铁出入口
- [ ] 人行天桥
- [ ] 红树林和滩涂
- [ ] 远景天际线
- [ ] 夜景灯光秀
- [ ] APEC 周主题：道旗、公交涂装、地标灯光动画、会场标识（开关 `theme.apec`）

## M8 界面与玩法

- [ ] 中文界面和地名
- [ ] `sz-map.js` 地图、搜索、传送
- [ ] 景点相机
- [ ] 出租车接单

## M9 性能与验收

- [ ] 性能测量，对照预算
- [ ] 数据审计报告
- [ ] 按验收路线截图

## M10 二期

- [ ] 扩数据范围到蛇口、罗湖
- [ ] 海上世界（明华轮）
- [ ] 京基 100
- [ ] 高架桥面可以通行
