# 地形数据来源与署名

正式共享数据包的地形默认取自 Copernicus GLO-30 的 AWS 2021 分发版本，保留源高程，做双线性重采样和分米量化。文件地址、下载日期和 SHA-256 记录在 `sources.json`。

按提供方要求保留修改数据的署名：

> produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved

[提供方产品与许可说明](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)、[AWS 数据分发说明](https://copernicus-dem-30m.s3.amazonaws.com/readme.html)。

该产品为 DSM，包含建筑、基础设施和植被表面，可能以其他旧 DEM 填补；不是现场测量的裸地 DTM，也不声称代表 2026 年城市地面的全部改造。旧 Mapzen/Tilezen HGT 保留为比较源，不能通过自行加高度偏移把它冒充新测绘数据。

## 派生路面覆盖层

城市包里的路面走廊高程另外取自 **FABDEM V1-2**（Bristol Research Initiative, 2023；由 Copernicus GLO-30 去除建筑和森林后建模，EGM2008 垂直基准）。道路由 `tools/sz/road_surface.py` 派生并标记为 `derived-road`。原深圳高尔夫球场局部另用 FABDEM 派生低频起伏和独立水位外观估计，以 GEDTM30 V1.2 对照。两者的范围、方法和差异写入 `data/source/build-report.json`。FABDEM 许可为 **CC BY-NC-SA 4.0**（仅限非商业使用）并附带 Copernicus 署名条款。

> FABDEM V1-2: Hawker, L., Neal, J., & Bates, P. (2023). FABDEM V1-2. University of Bristol. <https://doi.org/10.5523/bris.s5hqmjcdj8yo2ibzi9b4ew3sn> — Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International.

> FABDEM is produced from Copernicus GLO-30: produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.

FABDEM 为约 30 米格网的建模 DTM，不是现场测量；路面派生高差只能作为画面与通行连续性的工程估计，不能当作验收用工程标高。
