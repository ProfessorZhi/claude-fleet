# 008-fleet-command-scene — Requirements

## 目标

在不破坏现有 Runtime、Hook、Session 和 Pixel Office 的前提下，增加 Fleet Command
场景：用舰队视图展示 Agent、Repo、Task、Session、Provider、Model、Status 和遥测。

## 功能需求

- `FleetScene` 与 `OfficeScene` 并存；Fleet Command 是目标默认场景，Office 仍是正式可选 Scene。
- Agent 是船只，Coordinator 是旗舰，Worker 是护卫舰，Reviewer 是侦察舰，Subagent
  是无人机，External Agent 是未识别舰船。
- 文字状态保持工程语义：`Starting / Working / Waiting / Idle / Error / Stopped`。
- 同一 Repo 的 Agent 形成区域/分组；当前不虚构不存在的 Task DAG。
- 点击 Agent 能查看 Repo、Worktree、Provider、Model、Session、当前 Task、当前 Tool、
  Context、Usage 和最近事件。
- Actions 继续复用现有 Focus、Stop、Restart、Switch Provider。
- FleetScene 只消费统一 Scene Model / Fleet Telemetry，不直接读取 Claude/Codex 原始日志。

## 不在范围内

- 第一版不做 3D、复杂星图或在线协作；
- 不删除现有 OfficeScene；
- 不在 UI 内计算假的总进度或 Token；
- 不改变 Runtime Ownership。
- 不把 Fleet 变成 Coding Agent Runtime；Focus 仍然打开真实 Claude Terminal。
