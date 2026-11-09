# Slop Shenzhen

一个在浏览器里漫游深圳关内（南山、福田，二期加蛇口和罗湖）的 1:1 城市模拟，基于 [three.js](https://threejs.org/) 的 WebGPURenderer 和 TSL。步行、开蓝色纯电出租车、坐四旋翼载人飞行器，看腾讯滨海大厦、春笋、人才公园、平安金融中心、深业上城和 APEC 2026 主会场香蜜湖。

> 当前状态：正式入口已运行深圳（three.js 0.187.0 WebGPU + TSL，原生 ES Module，不打包）。九条硬性要求尚未整体验收通过，进度和已知问题见 [docs/HANDOFF.md](docs/HANDOFF.md)。

## 运行

```sh
python3 tools/sz/serve.py --port 8080
```

打开 <http://127.0.0.1:8080/>，需要支持 WebGPU 的桌面浏览器（新版 Chrome 或 Edge）。

## 文档

从 [docs/HANDOFF.md](docs/HANDOFF.md) 开始，完整索引见 [docs/README.md](docs/README.md)。

## 来源

本项目派生自 mrdoob 的 [Slop New York](https://github.com/mrdoob/slop-newyork)（MIT），中国城市数据管线做法参考 [Slop Wuhan](https://github.com/LightYearZh/slop-wuhan)。更多社区城市见 [Slop Cities](https://github.com/zz85/slop-cities)。

## 许可与数据

代码沿用 [MIT License](LICENSE)，保留原作者署名。

地理数据：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)（ODbL）、[Overture Maps](https://overturemaps.org/) Buildings（ODbL）、3D-GloBFP（CC BY 4.0，Che, Y. et al., 2024, ESSD 16, 5357–5374）、Mapzen Terrain Tiles（USGS SRTM）。各快照版本见 `data/source/sources.json`。

地形：Copernicus GLO-30 DSM（© DLR / Airbus，见 [data/source/ATTRIBUTION.md](data/source/ATTRIBUTION.md)）；派生路面走廊的基线使用 FABDEM V1-2（University of Bristol，CC BY-NC-SA 4.0，非商业用途），只用于明确标注的派生路面，不替代全域地形，署名与限制见同一文件。

纽约原版附带的数据：NYC Open Data（[建筑轮廓和高度](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue)、[行道树](https://data.cityofnewyork.us/Environment/Forestry-Tree-Points/hn5i-inap)）、[MTA 地铁出入口](https://data.ny.gov/Transportation/MTA-Subway-Entrances-and-Exits-2024/i9wp-a4ja)。第三方数据和依赖保留各自的许可。
