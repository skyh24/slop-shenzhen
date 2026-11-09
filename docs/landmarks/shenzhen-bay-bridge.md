# 深圳湾公路大桥

核实于 2026-11-09。桥从深圳湾口岸跨向香港蠔壳石，主体在一期地图南界以外，属于滨海视线中的远景。地名志给出全长 5,545 米，其中深圳段 2,040 米、香港段 3,505 米。路政署竣工资料记录双向各三车道、两座相向倾斜的独塔和两组混凝土引桥。[深圳市地名志](https://pnr.sz.gov.cn/attachment/1/1442/1442495/10537363.pdf) · [香港路政署竣工资料](https://www.hyd.gov.hk/en/information_corner/hyd_factsheets/doc/e_Shenzhen_Bay_Bridge.pdf)

## 平面来源与周边

- 使用 `osm-guangdong` 锁定快照。`relation/9184867` 的 23 个成员包含口岸支线，取其中按同一 OSM 节点连通的 7 条南向和 9 条北向主线。南向源全长 5,549.99 米，北向源全长 5,282.25 米。模型保留实际双幅 S 形与源车道数，不按工程总长拉伸。桩号 0 取南向 OSM 界线节点 `5468670298`。[桥梁 OSM 关系](https://www.openstreetmap.org/relation/9184867) · [快照及校验值](../../data/source/sources.json)
- 北向与南向线在口岸约 −1,786.25 米桩号处换侧交叉。该段上下层缺少标高，北向远景起于 −1,745 米，南向保留完整源线。口岸各支线与桥头接地留待工程资料核实。
- 观察范围包括人才公园东南湖岸、深圳湾公园南端海岸与相连步道。岸线、步道及其植被由场景使用各自的来源。桥生成器只提供跨湾结构，香港端岸坡、口岸建筑和近岸道路衔接待另行核实。[深圳湾市级湿地公园](https://pnr.sz.gov.cn/xxgk/ztzl/rdzt/hsl/szsdbh/content/post_10909709.html)

| 桥塔 | OSM 塔位经纬度 | 斜拉跨径（北至南） | 塔高与倾角 | 拉索 |
| --- | --- | --- | --- | --- |
| 深圳侧 | 113.9483260E, 22.4853677N | 180 + 90 + 75 米 | 承台以上 139.053 米，偏离竖直 10° | 12 对 |
| 香港侧 | 113.9559307E, 22.4759204N | 74.585 + 74.585 + 99 + 210 米 | 承台以上 155 米，水平偏移与竖向高度之比 1:5 | 13 对 |

- 两个塔位为带 `bridge:support=pylon` 和 `bridge:structure=cable_stayed` 的 OSM 源节点。以节点固定塔身在桥面处的平面位置，以桥线的局部切线决定塔轴朝向。模型桩号分别为 −1,071.844 和 237.496 米。[深圳侧塔位](https://www.openstreetmap.org/node/6048306333) · [香港侧塔位](https://www.openstreetmap.org/node/6048306332)
- 深圳侧箱梁采用工程资料的 38.6 米宽、4.12 米深。塔底横向 6 米、纵向 11 米，塔顶横向 4 米、纵向 6 米。桥面以上的 115.874 米与承台以上的 139.053 米共同给出模型桥面相对承台 23.179 米。[望海路涉海工程评估 §5.1.2](https://pnr.sz.gov.cn/attachment/1/1551/1551105/12048526.pdf) · [深圳侧结构论文 §1](https://pubs.cstam.org.cn/data/article/jdc/preview/pdf/dlxykzxb201001012.pdf)
- 香港侧采用 Arup 详设的钢箱梁宽 38.6 米、中心深 4.1 米，以及塔底 15×20 米、塔顶 4×6 米。施工论文另列箱梁 37.6×3.9 米，模型取详设整体断面。桥面距水约 37 米取施工论文。承台平面约 26.6×27.8 米、厚 3 米取施工总结。两侧梁上主跨和后跨拉索标准间距分别为 12 米和 3 米，首个锚点、塔上锚点及索径仍为估计。[Arup 详设 §4.1](https://www.researchgate.net/publication/281033909_DESIGN_OF_HONG_KONG-SHENZHEN_WESTERN_CORRIDOR) · [T.Y. Lin 施工工程论文](https://www.aisc.org/media/katkr1ky/jang-2005-wsbs-final.pdf) · [香港发展局施工总结](https://www.devb.gov.hk/filemanager/en/content_592/8_high_perfor_concrete_hkswc_ii_mr_sy_chan_dr_herber.pdf)

## 高程与可见细节

- 世界 Y=0 是远景使用的名义水线参考。模型假设深圳塔承台顶 Y=0，将香港侧 3 米厚承台放在 Y=0 至 3 米。两端桥面 Y=8、12 米及斜拉段端部坡形为标注估计，用连续曲线接入两个有工程依据的塔处桥面值。统一高程基准、实际桥头与引桥纵断面和水下基础待核实。
- 深圳海事局公布北通航孔净空 17 米。这个数值属于水上通航口径，模型桥底绝对高程与可航净空未作测绘校准。[深圳海事局附表 2](https://www.sz.msa.gov.cn/u/cms/portal_wai/202103/129890.pdf)
- 普通引桥按设计资料画双幅梯形混凝土箱梁，典型桥墩间距约 75 米。主跨区按公布跨径布置支承，在两个航道跨度内保留开敞空间。灯杆高度约 12 米、间距约 15 米取公开设计，实际单灯点位待核。塔身弱泛光参考 2006 年施工总结夜景，使用同一昼夜参数，无额外实时光源。[环评 §§13.8–13.9](https://www.epd.gov.hk/eia/files/applications/en/pp_81/eia_1552/progress/action_3324/section13.htm) · [香港路政署桥面结构调查](https://www.hyd.gov.hk/en/our_services/structures/doc/SBB_HK_Investigation_2019.pdf) · [香港发展局夜景照片](https://www.devb.gov.hk/filemanager/en/content_592/8_high_perfor_concrete_hkswc_ii_mr_sy_chan_dr_herber.pdf)

## 验收范围

`tools/sz/build.py` 已从锁定快照生成 782 个断面。真实 Three.js r187 几何测试检查桥面及梁底三角面、四处钢箱梁和引桥交界、两个主跨下方净空以及渲染与碰撞输入是否共享缓冲。地标在一期是远景，运行时未将该几何注册为玩家或车流的通行面。人才公园与深圳湾公园的昼夜视线、整体岸边接景和性能由正式场景验收。
