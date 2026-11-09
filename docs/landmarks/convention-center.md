# 深圳会展中心（福田）

核实日期 2026-11-09。运营方给出长 540 米、宽 282 米、最高处 60 米。gmp 项目图和实景显示两侧展厅在同一层平铺，银灰色屋面由钢肋托起并夹布采光带，中央另有东西向架空的玻璃会议体。sbp 记录展厅跨度 125 米、30 米柱网和 45 米标高的悬臂平台，同时列最大展厅高 38 米及总高 65 米的工程口径。运行模型采用 OSM 两个体量标签 35 米和 60 米，与运营方总高一致。屋盖细部截面与材料为图照拟合，保留相异口径。[运营方概况](https://www.szcec.com/szcec/cn-brief/about/index.html) · [gmp 原图、实景与设计说明](https://www.gmp.de/cn/projects/481/shenzhen-convention-exhibition-center) · [sbp 结构资料](https://www.sbp.de/en/project/shenzhen-convention-exhibition-center/)

| 部位 | 源对象与模型 |
| --- | --- |
| 南北展厅及弧面 | [`way/146862823`](https://www.openstreetmap.org/way/146862823) 的真实外廓，按运营方一层图组织为南侧从西至东 2、1、9 号馆，北侧 3、4、5 号馆、入口凹口、6、7、8 号馆。保留消防通道并分离上方两座架空连接廊 |
| 中央高架会议体 | [`way/780197214`](https://www.openstreetmap.org/way/780197214) 的旋转矩形足迹，约 361×56 米。底部平台高 45 米，玻璃会议体、弧形顶面、30 米节距支柱及斜托分段建模。轴向跨度约 360 米及设计宽 60 米参见 gmp、sbp |
| 北广场和入口 | 从展厅外廓的凹口提取中轴。运营方二层图给出 +7.5 米入口平台和三段楼梯，模型使用三段共 42 级和中间休息平台。台阶具体尺寸为图面比例估计。现有源水池 `way/692087652`、`way/692087653` 位于中央步道两侧 |
| 东西侧雨棚 | [西 `way/781193993`](https://www.openstreetmap.org/way/781193993) 与 [东 `way/781193995`](https://www.openstreetmap.org/way/781193995) 的源足迹保留，按侧门雨棚做成高架体，净空和厚度为照片估计 |

[运营方一层平面图](https://www.szcec.com/thinkitcmsresource/image/20241119/1043460802889121792.jpg) · [运营方二层平面图](https://www.szcec.com/thinkitcmsresource/image/20241119/1043460610878078976.jpg) · [展厅跨度与面积](https://www.szcec.com/szcec/cn-brief/exhibition/index.html)

建筑放置参考北广场露天中轴点 `(21.44, 1282.67)` 的 Copernicus DSM 样本 Y≈9.13 米，盖顶 Y≈44.1 米、会议体顶 Y≈69.1 米。两个源建筑包围盒中心的 DSM 约 35.9、35.8 米，落在屋顶回波上。当前北凹口后部的 DSM 也高于推定入口平台，台阶、近地玻璃和架空连接廊会被显示及接触地形局部遮住。首层绝对标高和入口及地下连接待测绘资料。

采光带沿两侧弧面横跨展厅，每 30 米钢肋跨间内约宽 7.4 米，位置和宽度为建成照片拟合。银灰金属盖板设细缝，玻璃采光带沿同一组盖顶三角面生成。当前为 6 个材质批次、3,360 个分段碰撞实体和 29,968 个渲染三角形。专项测试同时核对同一跨内采光带连续及沿曲面高差。[gmp 屋顶与结构照片](https://www.gmp.de/cn/projects/481/shenzhen-convention-exhibition-center)

## 新闻中心与周边

新华社 2026-11-08 确认 APEC 领导人会议周实体新闻中心位于 2 号馆，11 月 11 日开放。运营方图确定该厅在西南，靠益田路和滨河大道辅道，厅内北侧连东西向廊道。专项媒体入口、临时导视和活动设施的准确摆位待核实。[新华社公告](https://paper.people.com.cn/rmrbhwb/pc/content/202611/09/content_30190105.html) · [运营方一层平面图](https://www.szcec.com/thinkitcmsresource/image/20241119/1043460802889121792.jpg)

范围向北到福华三路、向南到滨河大道辅道，东西到益田路和金田路。首轮东侧机位约 `(520, 165, 1428)`，邻楼遮挡部分展厅。调整后的北侧机位观察两侧低盖和架空会议体。源对象、分段生成及正式场景注册已核对。专项测试覆盖九厅朝向、两级屋盖、北入口台阶和消防道净空。北门接地和真实通行仍待实走。

### root 浏览器复核（2026-11-09）

首轮从正式入口相机菜单选取会展中心机位，正午和午夜可见展厅屋面及会议体一端，邻楼挡住部分展馆。[首轮正午](../qa/m2-ground/convention-center-model-day.png) · [首轮午夜](../qa/m2-ground/convention-center-model-night.png)

北侧新机位实际截图 `../qa/m2-ground/convention-center-north-day.png` 已可见连续采光带、架空会议体和北侧展厅，左右两翼有裁边。现据同模型投影将机位移向北偏西并拉远，待下一次浏览器重载复核；没有通过隐藏邻楼解决遮挡。

西北侧最终机位已在正式相机菜单实际打开并复拍[正午](../qa/m2-ground/convention-center-refined-day.png)和[午夜](../qa/m2-ground/convention-center-refined-night.png)。两侧弧形屋盖、连续采光带与中央架空会议体可见；北入口通行和源DSM遮挡仍未通过。
