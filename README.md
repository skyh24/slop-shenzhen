# Slop Shenzhen

浏览器里的 1:1 深圳城市漫游，支持步行、汽车、单车与四旋翼飞行。基于 three.js 0.187.0 WebGPU/TSL，原生 ES Modules 直接运行。

```sh
python3 tools/sz/serve.py --port 8080
```

在支持 WebGPU 的浏览器打开 <http://127.0.0.1:8080/>。当前功能已接入，正式版仍待完整验收；从 [交接](docs/HANDOFF.md) 和 [文档索引](docs/README.md) 开始。

派生自 [Slop New York](https://github.com/mrdoob/slop-newyork)，数据组织参考 [Slop Wuhan](https://github.com/LightYearZh/slop-wuhan)。代码保留 [MIT 许可](LICENSE) 与原作者署名；地理数据另遵守 [数据署名与许可](data/source/ATTRIBUTION.md)，包括 OSM/Overture、GloBFP、Copernicus 和 FABDEM 的各自限制。快照清单见 [sources.json](data/source/sources.json)。
