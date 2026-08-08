# 004-minimal-control-ui — Requirements

> Feature slug：`004-minimal-control-ui`
> 依赖：001（Runtime）/ 002（Provider / Model 隔离）/ 003（用户状态）
> 工作流：`.agent/workflows/spec-coding.md`、`.agent/workflows/implement.md`、`.agent/workflows/review.md`

---

## 目标（Goal）

为 Alpha 提供**最小可用的控制面**：用户能通过命令 / 面板完成
**New Agent / Focus / Restart / Stop / Manage Providers**，并能看到
**Repo / Provider / Model / Status**。不重做 Pixel UI。

## 用户故事（User Stories）

- 作为一个用户，我在没有 Agent 时打开面板，看到明确的空状态和
  **[+ New Agent]** 入口，而不是一片空白。
- 作为一个用户，我能用一条命令聚焦到某个 Agent 的 Claude Code Terminal。
- 作为一个用户，我能停止某个 Agent —— 它对应的 Terminal / 进程**真正关闭**，
  其他 Agent 不受影响。
- 作为一个用户，我能重启某个 Agent —— 它保持原来的 Repo / Provider / Model
  重新启动（不需要我重新选一遍）。
- 作为一个用户，我能管理 Custom Provider：列出、创建、删除。删除后
  **不留下孤儿 Secret**。

## 功能性需求（Functional Requirements）

### 命令

- **FR-001**：注册命令 `claude-fleet.focusAgent` / `claude-fleet.stopAgent` /
  `claude-fleet.restartAgent`（加上已有的 `showPanel` / `newAgent` /
  `manageProviders`）。
- **FR-002**：`focusAgent`：让用户 QuickPick 一个 Agent（无 Agent 时提示），
  并 `terminal.show()` 聚焦其 Terminal（teammate 聚焦 lead 的 Terminal）。
- **FR-003**：`stopAgent`：QuickPick 一个 Agent →
  - 关闭其 Terminal（`terminal.dispose()`，真正结束 shell 进程）；
  - 清理 runtime state（watchers / timers / store / JSONL dismissal /
    hook unregister）；
  - **不**影响其他 Agent。

### Stop 语义（Alpha）

- **FR-004**：`removeAgent`（`server/src/agentRuntime.ts`）必须**真正关闭
  Terminal** 而不是只删 AgentState。现有 `onDidCloseTerminal` 依赖"用户手动
  关闭"才清理 —— 命令路径必须主动触发关闭。
- **FR-005**：Stop 后 Agent 从 store 移除、从 webview 列表移除（既有
  `agentClosed` 通道）；外部扫描不得重新收养其 JSONL（dismissal）。

### Restart 语义（Alpha）

- **FR-006**：`restartAgent`：QuickPick 一个 Agent → 保存其
  `cwd` / `providerProfileId` / `providerDisplayName` / `modelId` →
  Stop 旧实例 → 用同一 Provider Profile 重新 Launch（从 SecretStorage
  重新取 Secret）。
- **FR-007**：Restart **不**恢复原 Claude Session（新 sessionId）；
  **不**重跑 QuickPick（自动沿用原配置）。
- **FR-008**：Secret 缺失 → `MissingSecretError` → `showErrorMessage`，
  **fail-closed**，不 fallback 到 Anthropic 登录（复用 002 行为）。

### Manage Providers

- **FR-009**：`claude-fleet.manageProviders`：QuickPick 列出所有 Profile
  （含内置 Inherit）+ "Create Custom Provider…" 入口。选中 Custom Profile
  后提供 **Delete** 操作（+ 可选的 Edit）。
- **FR-010**：删除 Custom Provider 必须同时：
  `ProviderProfileStore.remove(profileId)` **和**
  `SecretStorageProvider.delete(secretRef)` —— 不得留下 orphan secret。
- **FR-011**：正在运行的 Instance 不受删除影响（launch-time 配置已固化）。

### UI（Alpha 最小面）

- **FR-012**：没有 Agent 时，webview 显示空状态：
  `No agents running` + `[+ New Agent]` 按钮（触发 `claude-fleet.newAgent`）。
- **FR-013**：有 Agent 时，Debug View 已显示 Repo / Provider / Model / Status
  （002 + 003）；每个 Agent card 提供 **Focus / Restart / Stop** 操作入口。

### Claude CLI 可用性检查

- **FR-014**：真正 Launch 前检测 `claude --version`（非阻塞、无超时则视为
  不可用）。不可用时 `showErrorMessage`：
  `Claude Fleet: Claude Code CLI not found. Please install Claude Code and ensure \`claude\` is available in PATH.`
  并**不创建 Terminal**。
- **FR-015**：检查逻辑可测试（纯函数 / 可注入执行器），**不**每秒检查
  （每次 New / Restart 时检查一次即可）。

## 非功能性需求（Non-Functional Requirements）

- **NFR-001 隔离**：Stop / Restart A 不得影响 B（有回归测试）。
- **NFR-002 可测试**：新逻辑（stop 清理顺序、restart 配置保留、provider
  删除 secret 联动、CLI 检查）都有单测；vscode 依赖通过注入隔离。
- **NFR-003 轻量**：不新增持久化结构；不重做 React UI；复用
  `launchAgentFlow.ts` / DebugView / Command Palette。
- **NFR-004 安全**：secret 不进入 log / webview / globalState（延续 002）。

## 不在范围内（Out of Scope）

- Edit Provider（Alpha：Delete + Recreate 即可，除非实现极简单）。
- Restart 恢复原 Session / 断点续跑。
- 完整 Control Center / 侧边栏重构。
- Marketplace 发布、多 Coding Agent、状态历史等（见 ROADMAP）。

## 开放问题（Open Questions）

- （无阻塞项。Edit Provider 留作 Delete + Recreate 的替代路径，若
  QuickPick + InputBox 组合成本低则实现。）

## Exit Criteria

- [ ] 六个命令全部注册可用：Show Panel / New Agent / Manage Providers /
      Focus Agent / Restart Agent / Stop Agent。
- [ ] Stop 真正关闭 Terminal 并清理 runtime state；Stop A 不影响 B（单测）。
- [ ] Restart 保留 Repo / Provider / Model；Secret 缺失 fail-closed（单测）。
- [ ] 删除 Custom Provider 同时删除 SecretStorage secret（单测）。
- [ ] Claude CLI 检查在 launch 前执行、不可用时提示且不创建 Terminal（单测）。
- [ ] 空状态 UI（No agents running + New Agent 按钮）。
- [ ] check-types / lint / 新增单测全部通过。
