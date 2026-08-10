# Fleet / agentmetrics 集成边界测试报告

日期：2026-08-09

## 交付边界

本报告只覆盖本地、确定性的 fake runner 链路，不启动真实 Claude/Codex 任务，也不调用 Provider API：

```text
Fleet identity
  -> run-codex-with-metrics.ps1
  -> agent-metrics start
  -> fake Codex exec --json
  -> agent-metrics finish
  -> sanitized-summary.json
  -> Fleet UsageRecord-shaped projection
```

## 已验证语义

- `fleet_run_id`、`fleet_task_id`、`fleet_worker_id`、`fleet_coordinator_id`、
  `parent_worker_id`、`worker_role`、`worktree_id` 和 `attempt` 能完整从 runner 进入
  `run-context.json`，并原样进入 sanitized summary。
- `input_tokens=120`、`output_tokens=45`、`reasoning_tokens=15`、缓存桶
  `10/5` 时，`total_tokens=165`，即只计算 input + output；reasoning/cache 不会被
  重复累加。
- `agent_process_seconds` 只映射到 UsageRecord 的 `durationMs`；不会用 quota 百分比
  推算耗时，也不会把 wall-clock 和 agent process time 混为一个字段。
- quota 仍保留为 account-level summary 数据，带有 `scope=ACCOUNT`、
  `attribution=NOT_PROVEN`；不会进入 UsageRecord 的 token 字段。
- `COMPLETE` / `PARTIAL` usage 才允许生成 UsageRecord-shaped projection；
  `NOT_AVAILABLE`、`AMBIGUOUS` 等状态 fail closed，禁止制造伪 usage。
- projection 只输出 Fleet Ledger 所需的 secret-free 字段，不携带 prompt、response、
  API key 或完整 Fleet identity 对象。

## 测试结果

定向交付边界：

```text
python -m pytest agentmetrics/tests/test_fleet_usage_boundary.py \
  agentmetrics/tests/test_fleet_identity.py \
  agentmetrics/tests/test_codex_exec_json_collector.py \
  agentmetrics/tests/test_codex_runner.py -q

17 passed
```

其他 Python 回归分组：

```text
143 passed, 12 subtests passed
4 passed  (GitHub integration + concurrency tests)
39 passed (CLI tests)
```

全量收集到 202 个测试；按文件分组执行后共 199 passed、3 failed，另有 12 个
subtests 通过。未把最初一次 180 秒整体运行超时误报为通过。

`test_cli_process_exit_codes.py` 中 3 个子测试在当前 Codex Python 运行时失败，原因是
该运行时使用 isolated embedded Python（`sys.flags.ignore_environment=1`），忽略测试设置
的 `PYTHONPATH`，导致子进程 `python -m agent_metrics` 报 `No module named agent_metrics`。
这不是本次边界代码的断言失败，也未通过真实 API 或 Provider 重试来规避。

## 后续接入约束

本次交付提供的是纯 Python projection 和 fake runner 验收边界，不等同于 server 已自动
消费 summary。下一步 server 侧接入时，应使用 Fleet 自己的 `instanceId`，并把 summary
中的 `fleet_task_id` 映射到 `workItemId`；不要把 quota snapshot 当成 request usage。
