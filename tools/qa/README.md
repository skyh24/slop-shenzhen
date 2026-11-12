# QA 工具

流程统一见 [开发检查](../../docs/25-FAST-CHECKS.md)，正式预算与路线见 [验收标准](../../docs/10-PERF-QA.md)。

| 工具 | 用途 |
| --- | --- |
| `check.py` | `--scope`按模块检查，`--list`预览，日志存本地`docs/qa/checks/` |
| `perf-sample.mjs` | 可见聚焦浏览器的帧间隔、绘制和三角数采样；专门性能任务使用 |
| `bench-city-data.mjs` | 同载荷JSON/SZC1读取对照，不代表完整冷启动性能 |

`perf-sample.mjs`通过`ego-browser nodejs < tools/qa/perf-sample.mjs`运行；执行前核实际时长、视口与环境参数。命令行环境变量曾未传入浏览器服务，不把默认60秒误记成指定时长。后台30Hz样本不用于正式FPS结论；工具改进见TASKS T10。
