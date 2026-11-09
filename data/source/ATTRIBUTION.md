# 地形数据来源与署名

正式共享数据包的地形默认取自 Copernicus GLO-30 的 AWS 2021 分发版本，保留源高程，做双线性重采样和分米量化。文件地址、下载日期和 SHA-256 记录在 `sources.json`。

按提供方要求保留修改数据的署名：

> produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved

[提供方产品与许可说明](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)、[AWS 数据分发说明](https://copernicus-dem-30m.s3.amazonaws.com/readme.html)。

该产品为 DSM，包含建筑、基础设施和植被表面，可能以其他旧 DEM 填补；不是现场测量的裸地 DTM，也不声称代表 2026 年城市地面的全部改造。旧 Mapzen/Tilezen HGT 保留为比较源，不能通过自行加高度偏移把它冒充新测绘数据。
