# QA 工具

| 文件 | 用途 |
| --- | --- |
| `check.py` | 日常按模块选择回归，大版本 `--scope full`；自动配置 Three、并行 Node/Python，拒绝跳过并保存本地结果。流程与经验统一见 [25 号](../../docs/25-FAST-CHECKS.md)。 |
| `perf-sample.mjs` | M9 帧率/绘制采样：固定 2560×1440、可选 scenic 机位，输出 rAF 帧间隔 P50/P95/max、drawCalls、三角数。必须在**可见、聚焦**的浏览器窗口跑（后台窗口会被限到 30 Hz）。 |

```sh
python3 tools/qa/check.py --scope controls --list
python3 tools/qa/check.py --scope controls
python3 tools/qa/check.py --scope full
ego-browser nodejs < tools/qa/perf-sample.mjs
# 例：60 s、指定机位
SZ_PERF_SECONDS=60 SZ_PERF_CAMERA=cam-superHq ego-browser nodejs < tools/qa/perf-sample.mjs
```

## 备注

- `ego-browser nodejs` 走本机浏览器服务，命令行前缀环境变量可能不会传入脚本（实测 `SZ_PERF_SECONDS=5` 仍按默认 60 s 跑）；需要改采样时长/尺寸时，直接改脚本顶部默认值，或用 `--ego-server-name` 独立服务再传环境变量。
- 2026-11-10 冒烟结果：2560×1440、chase 机位、60 s → p50 33.3 ms / p95 34.2 ms（≈30 FPS）、drawCalls 289、三角 0.88 M；帧间隔集中在 33 ms，仍是后台窗口 30 Hz 上限，不是场景负载。
