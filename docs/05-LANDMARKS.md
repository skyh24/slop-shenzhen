# 地标与场所模型参考

源身份、坐标与高度以 [landmarks.json](../data/source/landmarks.json)、[楼高覆盖](../data/source/building-height-overrides.json) 及当前包为准。以下压缩既有模型卡与资料入口；外部资料未在本轮重新联网核实。当前验收统一在 HANDOFF，后续统一在 TASKS T7/T14。

## 装配方法

`sz-landmarks/layout.js`注册13个建筑专模。每个`build()`输出实体部件，`parts.js/render.js`生成显示与碰撞，成功后才让对应源ID退出普通楼；保留邻楼、内院、架空净空。几何估计与源事实分开，模型可见不表示门内或屋顶开放。

## 专模

| 对象 | 已有内容/方法 | 保留限制与资料 |
| --- | --- | --- |
| 腾讯滨海大厦 `tencent-binhai.js` | 源双塔与三组功能连层，银色遮阳与橙铜连廊；源高245.8/194.8米。 | 连桥/首层与周边通行仍需完整核对。 [资料1](https://global.ctbuh.org/resources/papers/3644-Ward_TencentSeafrontTowers.pdf) |
| 华润春笋 `chunsun.js` | 建成口径392.5米，56竖肋与28组斜交收分，内退玻璃首层；按核实分块替换。 | 首层基底、下沉广场及滨水连接仍需来源。 [资料1](https://www.skyscrapercenter.com/building/china-resources-tower/14589) · [资料2](https://www.arup.com/globalassets/downloads/insights/a/arups-innovation-legacy/arup-innovation-legacy-chinese.pdf) · [资料3](https://www.charlesportelli.com/china-resources-hq) |
| 大疆天空之城 `dji-sky-city.js` | 双塔、悬挑玻璃体、V形桁架与起拱连桥；源部件高度与设计/报道高度分开。 | 塔高/连桥各口径、地面残留足迹及公共可达边界继续核对。 [资料1](https://www.credaward.com/project/284016/) · [资料2](https://www.arup.com/en-us/projects/dji-headquarters/) · [资料3](https://commons.wikimedia.org/wiki/File:南山_大疆天空之城_01.jpg) |
| 平安金融中心 `ping-an.js` | 源高599.1米，收分、角柱、尖顶与夜景分区。 | 逐部件比例和周边入口/街区闭环需实景与实走。 [资料1](https://www.skyscrapercenter.com/building/ping-an-finance-center/54) · [资料2](https://www.kpf.com/project/ping-an-finance-centre/) · [资料3](https://global.ctbuh.org/resources/papers/2969-paper41-v2.pdf) |
| 福田会展中心 `convention-center.js` | 源展馆/连接体与波浪屋面，新闻中心角色与建筑几何分开。 | 展馆入口、屋盖细部和会期用途需分别核实。 [资料1](https://www.szcec.com/szcec/cn-brief/about/index.html) · [资料2](https://www.gmp.de/cn/projects/481/shenzhen-convention-exhibition-center) · [资料3](https://www.sbp.de/en/project/shenzhen-convention-exhibition-center/) |
| 深业上城 `upperhills.js` | 源双塔388.1/299.3米、裙房/LOFT小镇、南梯与东西连桥；图照拟合小镇细部。 | 南梯已有局部实走；两桥完整接驳/净空、平台与DSM关系待验。 [资料1](https://www.som.com/projects/shen-ye-upperhills-mixed-use-development-class-a-office-luxury-hotel-complex/) · [资料2](https://www.capol.cn/projectdetail.aspx?SCode=101002001001&id=100000069418415) · [资料3](https://www.skyscrapercenter.com/building/shum-yip-upperhills-tower-1/16001) |
| 春茧体育中心 `chunjian.js` | 两馆实体屋盖、白色网壳、大树广场孔、露天场心与海之门；部分封闭馆内DSM已裁除。 | 工程+6米平台缺绝对基准转换；场馆外围/入口与露天部分不能按同一屋顶回波裁空。 [资料1](https://www.axscom.jp/legacy/en/project/no03341/) · [资料2](https://pnr.sz.gov.cn/attachment/1/1285/1285348/10537364.pdf) · [资料3](https://www.szns.gov.cn/mlns/whns/tycg/content/post_12589347.html) |
| 深圳湾文化广场 `shenzhen-bay-culture-square.js` | 用户所称人才公园新艺术馆；OSM外廓结合MAD图纸拟合九个石体，约52/32米体量为图上估计。 | 施工图附件未取得，屋顶坡线、绝对标高与公共开放通路待核。 [资料1](https://www.i-mad.com/articles/shenzhen-bay-culture-square-completion) · [资料2](https://cdn.sanity.io/images/2d8zs6ec/production/15d0dbda8602e68f929b40816a8825dc19ff6bd3-2697x707.jpg) · [资料3](https://www.sz.gov.cn/attachment/1/1626/1626489/12402245.pdf) |
| 中国有色大厦 `nonferrous-tower.js` | 源父/三部件绑定，26/6/6层推高83.2/19.2/19.2米；双翼弧阳台、西南7柱门廊，照片尺寸为估计。 | 南侧柱间已局部实走；北侧真实入口、门厅照片方位与Q1闭环仍缺。 [资料1](https://www.zg-ys.cn/images/0loupantu/2.jpg) · [资料2](https://www.zg-ys.cn/images/0loupantu/3.jpg) · [资料3](https://www.zg-ys.cn/images/0loupantu/4.jpg) |
| 深圳湾超级总部 `super-hq.js` | 按建好形态；C塔设计400/336米、119.15米连廊与十字公共轴，招银单体采用源记录裁决。 | 平面旋转、双幅连廊和公共通行待核；不同招银高度口径见源覆盖表，不能互相冒充。 [资料1](http://gdstc.gd.gov.cn/kjzx_n/gdkj_n/content/post_4801250.html) · [资料2](https://5bur.cscec.com/5bur/oa/dtxw/202510/3911196.html) · [资料3](https://finance.sina.cn/2025-07-19/detail-inffzcmt0086775.d.html?vt=4) |
| 国际交流中心 `iec-xiangmihu.js` | 院落/湖面/公园按OSM来源，主厅/酒店/门廊已注册并接APEC锚点。 | 建筑体量与高程仍为estimate，缺设计/竣工资料；会场报道不证明建筑尺寸。 [资料1](https://www.shenzhen-guide.com/guides/apec-2026-shenzhen-visitor-guide) · [资料2](https://hao.cnyes.com/post/277089) · [资料3](https://news.mingpao.com/pns/%E4%B8%AD%E5%9C%8B/article/20261109/s00013/1794155294115/) |
| 市民中心 `civic-center.js` | 波浪屋盖、双色塔、孔洞、两翼树状柱；参数卡保留供测试使用 | [参数与来源](landmarks/civic-center.md)，曲面/柱位估计不写成实测 |
| 特区报业大厦 `press-tower.js` | 源楼体加镂空顶冠和尖塔 | 身份/高度见源清单，外形与邻楼关系按同机位核对 |

## 独立结构与场所

| 对象 | 接入与边界 |
| --- | --- |
| 深圳湾大桥、沿江高速 | `sz-landmarks/shenzhen-bay-bridge.js`的`buildShenzhenBayBridge/buildYanjiangExpressway`由main直接调用；OSM线形，结构标高/墩距含估计，当前为远景，不承诺可驾驶 |
| 福田站、西丽站 | `sz-station-sites.js`独立装配；站亭/天窗与施工围挡/塔吊/基坑示意。源`way/800275814`、`way/402048868`；公共接驳和真实坑壁另验 |
| APEC城市元素、福田灯光秀 | `sz-apec*.js`与`sz-light-show.js`独立装配；站点/活动来源与模拟灯效分开，不是逐块实景复刻 |
| 其他公园、商圈、古城、大学城 | 有地图地点或通用建筑不代表已有独立场所模型；用户指定清单保留在TASKS T14 |

## 样板验收方法

每次选一个已核对象，以地块/道路/水岸确定周边边界，保留照片日期/朝向、对应尺寸和未知项。至少对照俯瞰关系、街道视线和入口三个尺度及日夜。用同一实体检查门洞/柱廊/桥下与平台，实走有来源的公共路线。截图/轨迹存本地QA；不再为每一轮追加一份模型交接。
