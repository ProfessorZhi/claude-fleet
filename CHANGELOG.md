# Changelog

## 0.1.0 — Alpha

首个 Alpha 版本。基于 Pixel Agents（MIT）二次开发的
Claude Code 多实例管理扩展。

### 新增

- 多 Claude Code Instance：同时运行多个 Agent，每个独立 Repo / Session
- 每 Instance 独立 Provider / Model：支持 Anthropic-compatible Custom
  Provider（API Key / Auth Token），Secret 存于 VS Code SecretStorage
- New Agent 流程：Repo → Provider → Model → Launch（QuickPick / InputBox）
- Manage Providers：列出 / 创建 / 删除 Custom Provider（删除时同步清理 Secret）
- Focus Agent：一键聚焦对应 Claude Code Terminal
- Stop Agent：真正关闭 Terminal / 进程并清理运行时状态，不影响其他 Agent
- Restart Agent：保留 Repo / Provider / Model 重启（重新获取 Secret，缺失时 fail-closed）
- 用户状态展示：Starting / Working / Waiting / Idle / Error / Stopped
- Pixel 状态可视化（复用上游 Pixel Agents UI）
- Claude CLI 可用性检查：New / Restart 前检测 `claude` 是否可用
- 空状态 UI：无 Agent 时显示 "No agents running" 与 `+ New Agent` 入口
- Debug View：Agent 卡片显示 Repo / Provider / Model / Status 与
  Focus / Restart / Stop 操作

### 限制（Alpha）

- 当前主要支持 Claude Code
- 尚未发布到 VS Code Marketplace（通过 VSIX 分发）
- Restart 不恢复原 Session
