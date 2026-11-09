# 中国华润大厦（春笋）

核实日期 2026-11-09。建成总高 392.5 米，和当前 OSM 塔尖一致。塔身用当前生成包 `way/1270310100` 对位，它是原始轮廓 `way/529272473` 的中心部件。与外圈一起共 73 个 OSM 分块，运行模型替换这 73 个已核实对象。对位中心约 `(-11612.15, 3157.60)`，轴向沿源圈。当前 Copernicus DSM 锚点 Y≈−7.704 米，塔顶约 Y=384.796 米。地面值保留原 DEM，不视作建筑基础测绘值。[原始 OSM 外轮廓](https://www.openstreetmap.org/way/529272473) · [CTBUH 建成高度](https://www.skyscrapercenter.com/building/china-resources-tower/14589) · [Arup 项目记录第 48 页](https://www.arup.com/globalassets/downloads/insights/a/arups-innovation-legacy/arup-innovation-legacy-chinese.pdf)

## 曲面与斜交钢肋

- KPF 参数图给出的设计半径在地面、127.5 米腰部、258 米肩部依次为 31、33.75、28 米。下段用保形曲线穿过三个控制点，上段按图上 638.979967 米半径的圆弧向尖顶收拢。首层、腰部、冠部尺寸均为根据公开设计图派生的外形，整体纵向从图示 400 米换算至建成 392.5 米。OSM 外圈分块只用于绑定和包络对照。连续环截面逐段生成，物理接触在相同顶点的凸体上按身体高度切片。[原设计参与者公开的 KPF 参数图](https://www.charlesportelli.com/china-resources-hq)
- 中段 56 根银色竖肋，低段以 28 组支点斜交分叉，冠部再次归并成 28 条收尖。玻璃在低段向内退约 2.8 米，柱间保留真实外部空带。各斜肋节点、退界和门位按形态派生。塔身玻璃门保留封闭，馆内楼层和出入口不作通行承诺。夜间稳亮钢肋和冠部，窗光密度为显示参数。[KPF 建成照片和地面展厅](https://www.kpf.com/project/china-resources-tower) · [KPF 幕墙工程说明](https://www.kpf.com/news/florence-chan-presents-china-resources-tower-at-daf-shenzhen)

## 周边范围

以人才公园湖岸和后海街区作为对照。源图上保留东侧瑞府 `way/529272469`、西侧万家大厦 `way/529272471`、西南深圳湾文化广场 `way/1441599159`、北侧深圳湾体育中心。只替换塔身的已核实对象，周边各楼仍用当前源足迹与原有楼高。小玻璃亭、下沉广场、展馆和滨水过街的具体尺寸及动线待单独核对。现有入口方向处的 DSM 起伏明显，首层接地及铺装需实景和独立高程资料，地貌保持源值。[CTBUH 对北侧公园、玻璃亭和下沉广场的介绍](https://www.skyscrapercenter.com/building/china-resources-tower/14589)

## 画面与通行

- 已有数据、程序几何和正式场景接入。模型 6 个材质批次、631 个分段碰撞体和 10,692 个三角形。几何测试核对负 DSM 基准、总高、关键截面、入口环带和冠部收分。
- 浏览器达到可见级。从人才公园方向约 `(-11379.5, 145, 3695.3)`、视场 52° 观察，正午可辨认圆曲收分和两段斜交钢肋。[正午截图](../qa/m2-ground/chunsun-model-day.png)
- 午夜冠部可辨，塔身亮度偏低，整塔灯光和沿岸联动待实景对照。[午夜截图](../qa/m2-ground/chunsun-model-night.png)
- 东侧街面候选为 `(-11555, 7.5, 3157)` 向 `(-11612, 14, 3157)`。入口接地、沿街行进和实际步行抵达仍待游玩验收。
