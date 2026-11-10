# QA 工具

| 文件 | 用途 |
| --- | --- |
| `perf-sample.mjs` | M9 帧率/绘制采样：固定 2560×1440、可选 scenic 机位，输出 rAF 帧间隔 P50/P95/max、drawCalls、三角数。必须在**可见、聚焦**的浏览器窗口跑（后台窗口会被限到 30 Hz）。 |

```sh
ego-browser nodejs < tools/qa/perf-sample.mjs
# 例：60 s、指定机位
SZ_PERF_SECONDS=60 SZ_PERF_CAMERA=cam-superHq ego-browser nodejs < tools/qa/perf-sample.mjs
```
