# 无人机来源摘要

保留原路径供`data/source/air-routes.json`引用。汇总2026-11-09既有取证；本轮未核实实时运营。功能与方法见 [无人机路线](../08-AIR.md)，验收状态见 [HANDOFF](../HANDOFF.md)，后续统一在 [TASKS T12](../TASKS.md#t12-低空apec)。

| 条目 | 可保留事实 | 不能据此推出 |
| --- | --- | --- |
| 人才公园—海岸城/后海商圈 | [南山区2023-09-12报道](https://www.szns.gov.cn/bsfw/hlwzwfw/zwdt_140139/content/post_10830667.html)记载2023-09-04开航，潮汐广场为降落区域 | 精确柜位、逐点轨迹、高度或当前仍在运营 |
| 福田公园航线群 | 源清单保留中心公园C2、莲花山等报道端点 | 当前展示的C2—莲花山配对仍低置信，不能叫已核实直飞航线 |
| 南山M-Port及其他物流线 | air-evidence中的报道可作候选 | 园区中心点不等于起降点，宣传覆盖不等于每条可建路线 |
| 历史无人机表演 | 有来源场次可作历史参考；采购公告只证明采购/方案 | 常设演出、真实当前队形或可直接采用配送高度 |
| 大疆天空之城 | 建筑地标身份 | 无已取得的真实运营航线证据 |

`trackStatus=schematic`、`altitudeSource=estimate`、`sourceUrls`与`verifiedAt`必须保留。源文件记录的APEC管控窗口不等于实时飞行状态。

坐标统一WGS84，经`tools/sz/geo.py::project`进入城市米制坐标；GCJ-02地图坐标不得直接填入。场所/柜位/端点配对/轨迹/巡航高度/日期分别取证，资料缺失保留未知。完整链接与日期保留在 [air-routes.json](../../data/source/air-routes.json) 和 [air-evidence.json](../../data/source/air-evidence.json)。
