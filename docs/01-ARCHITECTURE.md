# 架构与基本实体

## 运行路径

`index.html` 通过 import map 载入 three.js 0.187.0，使用 WebGPU、TSL 与原生 ES Modules。地理数据在离线构建时确定。

```text
data/raw + data/source → tools/sz/build.py → 城市包、区域资源、报告
城市包 → sz-geodata.js → GEO / REAL_BUILDINGS
main.js → sz-scene-site.js → 地面与路网 → 结构、场地、建筑与街具
        → 控制器、交通与人群 → 相机、地图、昼夜与帧循环
```

`GEO` 提供空间数据，`REAL_BUILDINGS` 提供解码的建筑记录，`site` 汇集场景使用的地面查询、路网与碰撞体。滨水、地铁口和配送的区域资源按距离挂载。组件通常先用 `plan*` 生成布局，再用 `build*` 创建场景对象，由拥有者更新和释放资源。

## 实体与共用规则

| 实体 | 跨组件约定 | 代码入口（相对 js/） |
| --- | --- | --- |
| 地面与活动表面 | 同一平面位置可以有多层。落位查询返回高度与出处，玩家按所在层选择脚下或轮下的支撑面。 | `sz-surface-atlas.js`、`sz-controller-surfaces.js` |
| 路段与断面 | 路段关联源节点与方向。断面给出车行范围和车道横位，供标线、车流和路侧布置共用。 | `sz-road-section.js`、`sz-section-frame.js` |
| 建筑与部件 | 稳定 ID 关联足迹、内院、基底及相对楼高。普通楼、近景与地标共享源对象的取舍。 | `sz-building-plan.js`、`sz-landmarks/layout.js` |
| 街块、场所、区域 | 道路围合街块（Block）。一个场所（Place）可跨街块。区域（Region）用有来源的边界表达用途，加载分块独立于这些边界。 | `sz-spatial.js`、`sz-scene-style.js` |
| 场地与街具 | 场地登记支撑面、步行预留范围与行人排除范围。街具落位共用地面和障碍探针，分块显隐与资源释放各有独立条件。 | `sz-place-assembly.js`、`sz-site-probe.js`、`sz-street-batch.js` |
| 玩家与环境交通 | 四种移动模式共用玩家。自动驾驶控制玩家车，环境车独立调度，两者共用路网和路口信号。 | `controllers.js`、`sz-auto-drive.js`、`sz-traffic.js` |
| 观察会话与昼夜 | 地标环绕、节目、配送跟拍和巡游由会话管理接管与退出。场景的灯具、窗光和节目读取共享昼夜状态。 | `sz-observation-session.js`、`sz-day-phase.js` |

重建、格式和字段来源见[数据管线](02-DATA-PIPELINE.md)。各实体的专用规则及入口见[组件索引](README.md)。
