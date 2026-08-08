# 004-minimal-control-ui — Design

> 关联：[`requirements.md`](./requirements.md)
> 依赖：001 Runtime / 002 Provider-Model 隔离 / 003 用户状态

---

## Context

Alpha 控制面目前是"webview 里的 Debug View + 三条命令"：
`showPanel` / `newAgent` / `manageProviders`（manageProviders 只注册了常量，
**未实现**）。webview 有 `focusAgent` / `closeAgent` 消息，但：

- `closeAgent` 只调用 `terminal.dispose()`，依赖 `onDidCloseTerminal` 做清理；
  命令路径缺一条"主动关闭并清理"的流程。
- **没有** Focus / Stop / Restart 命令。
- **没有**空状态 UI（无 Agent 时 Pixel Office 是空画布）。
- **没有** Claude CLI 可用性检查（`claude` 不在 PATH 时创建注定失败的
  Terminal）。

本 Feature 补齐这些，全部走既有基础设施。

## 高层形态

```
命令（Command Palette）                          webview（Debug View card）
┌──────────────────────────────┐                ┌──────────────────────────┐
│ claude-fleet.showPanel       │                │ Repo / Provider / Model  │
│ claude-fleet.newAgent        │──►launchAgentFlow──► launchNewTerminal     │
│ claude-fleet.manageProviders │──►QuickPick/InputBox (List/Create/Delete) │
│ claude-fleet.focusAgent      │──►terminal.show()                          │
│ claude-fleet.stopAgent       │──►stopAgent(cleanup)                       │
│ claude-fleet.restartAgent    │──►stop + relaunch (same config)            │
└──────────────────────────────┘                └──────────────────────────┘
        │
        ├──► ensureClaudeCliAvailable()（launch 前一次）
        └──► AgentRuntime / AgentStateStore（既有）
```

## 模块职责

| 模块                                                 | 职责                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters/vscode/agentControl.ts`（新增）            | `focusAgent` / `stopAgent` / `restartAgent` 命令实现 + `pickAgent`（QuickPick 复用 helper）+ `restartAgentPreservingConfig` 纯函数（保存 cwd/profile/model 的投影）。 |
| `adapters/vscode/cliCheck.ts`（新增）                | `ensureClaudeCliAvailable(executor?)` —— 运行 `claude --version`，成功返回版本 / 失败返回原因。执行器可注入（测试）。                                                 |
| `server/src/agentRuntime.ts`（小改）                 | `removeAgent` 增加可选 `disposeTerminal` 行为；新增 `stopAgent(id, {disposeTerminal})` 语义：关闭 Terminal → dismissal → unregister → removeAgent。                   |
| `adapters/vscode/PixelAgentsViewProvider.ts`（小改） | `requestDiagnostics` 广播（003）；注册 3 条新命令；`closeAgent` 消息改为走统一的 stop 流程（webview ✕ 按钮语义 = Stop）。                                             |
| `adapters/vscode/extension.ts`（小改）               | 注册 `focusAgent` / `stopAgent` / `restartAgent` / `manageProviders` 命令。                                                                                           |
| `adapters/vscode/manageProvidersFlow.ts`（新增）     | Manage Providers QuickPick / InputBox：List / Create / Delete；Delete 联动 SecretStorage。                                                                            |
| `adapters/vscode/launchAgentFlow.ts`（小改）         | launch 前调用 `ensureClaudeCliAvailable`，不可用则中止。                                                                                                              |
| `webview-ui/src/App.tsx`（小改）                     | `agents.length === 0` 时渲染空状态（文案 + New Agent 按钮 → `transport.send({type:'newAgent'})` → provider 执行命令）。                                               |
| `webview-ui/src/components/DebugView.tsx`（小改）    | Agent card 增加 Focus / Restart / Stop 按钮（复用 `transport.send` 消息）。                                                                                           |
| `adapters/vscode/PixelAgentsViewProvider.ts`（消息） | 新增 webview 消息：`focusAgent`（已有）/ `stopAgent` / `restartAgent`。                                                                                               |

## 关键语义

### Stop（FR-004 / FR-005）

```
stopAgent(id):
  agent = store.get(id); if (!agent) return
  if (agent.terminalRef) terminalRef.dispose()   // 真正关闭 Terminal（VS Code 语义：关闭 PTY，shell 进程结束）
  runtime.dismissalTracker.dismiss(agent.jsonlFile)
  runtime.unregisterAgent(agent.sessionId)
  if (agent.isTeamLead) runtime.removeTeammates(id)
  runtime.removeAgent(id)                         // watchers / timers / store / persist
```

`onDidCloseTerminal` 会再次触发（dispose 触发 close 事件），其清理是幂等的
（`store.get(id)` 已为空 → no-op）。Stop 只操作目标 id 的资源 —— 其他
Agent 的 terminal / watcher / timer 全程不触碰。

### Restart（FR-006 ~ FR-008）

```ts
// 纯函数：从 AgentState 投影重启配置（可单测）
export function restartConfigFromAgent(agent: AgentState): InstanceLaunchConfig {
  return {
    cwd: agent.projectDir, // 注意：projectDir 是 Claude 的 session dir
    providerProfileId: agent.providerProfileId ?? INHERIT_PROVIDER_PROFILE_ID,
    modelId: agent.modelId,
  };
}
```

> `cwd` 语义说明：`agent.cwd` 不存在于 AgentState，最接近的是 `projectDir`
> （Claude 的 transcript 目录）。Alpha 用 `projectDir` 作为重启 cwd 的近似
> （对单 workspace 场景，与原始 cwd 的 transcript 路径一致）。文档记录此近似。

流程：pick → `restartConfigFromAgent` → `stopAgent`（await dispose 清理）
→ `ensureClaudeCliAvailable` → `launchNewTerminal(options)`（secret 从
SecretStorage 重取；缺失 → `MissingSecretError` → fail-closed，terminal
不创建，旧实例已停止 → 用户看到错误提示）。

### Manage Providers（FR-009 ~ FR-011）

QuickPick 列表项：

```
Anthropic (Inherit)   [built-in]           → 选择后提示"内置，不能删除"
<name>  <baseUrl>  (API Key / Auth Token)  → 选中后提供: Delete
$(plus) Create Custom Provider…            → 复用 launchAgentFlow 的创建子流程
```

Delete 流程：

```ts
const profile = store.get(id);
if (!profile) return;
if (profile.secretRef) await secretStorage.delete(profile.secretRef); // 先删 secret
await store.remove(id); // 再删 profile
```

运行中的 Instance 持有多年前解析出的 env，与 store 无引用关系 —— 不受影响。

### Claude CLI 检查（FR-014 / FR-015）

```ts
// cliCheck.ts — executor 可注入，默认 child_process.execFile
export async function ensureClaudeCliAvailable(
  executor: (cmd: string, args: string[]) => Promise<string> = defaultExecutor,
): Promise<{ ok: true; version: string } | { ok: false; reason: string }>;
```

- 只在 **New Agent 提交时** 与 **Restart** 时调用一次（不做定时轮询）。
- 失败 → `showErrorMessage('Claude Fleet: Claude Code CLI not found. Please install Claude Code and ensure `claude` is available in PATH.')`，流程中止，**不创建 Terminal**。
- 成功 → 继续。版本字符串仅进 log。

### 空状态（FR-012）

webview `App.tsx`：`agents.length === 0` 时在 Canvas 上方渲染居中 overlay：

```
No agents running

[+ New Agent]
Launch a Claude Code instance with its own repo, provider and model.
```

按钮 → `transport.send({ type: 'newAgent' })` → provider 收到后
`vscode.commands.executeCommand('claude-fleet.newAgent')`。
（webview 内直接 `acquireVsCodeApi().postMessage` 同通道。）

## 失败模式（Failure Modes）

| 失败                                  | 应对                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `claude` 不在 PATH                    | New / Restart 前检测，提示并中止，不建 Terminal                               |
| Stop 时 terminal 已不存在             | `terminalRef.dispose()` 抛错 → try/catch，继续清理 store                      |
| Restart 时 Secret 缺失                | `MissingSecretError` → 提示，不创建新 Terminal（fail-closed）                 |
| 删除 Provider 时 SecretStorage 不可用 | `delete` 抛错 → 提示错误，**不**执行 `store.remove`（保持一致，不留半删状态） |
| 重复 Stop（webview ✕ 与命令并发）     | `store.get(id)` 幂等检查；onDidCloseTerminal 幂等                             |
| legacy agent 无 provider/model        | `restartConfigFromAgent` 回退 Inherit；DebugView 显示 '—'（既有）             |

## 取舍（Trade-offs）

- **Stop = Terminal dispose + 清理，而不是"只删状态"**：真正的 Alpha Stop
  语义（FR-004）。代价：VS Code 可能因 shell 子进程驻留而延迟回收 ——
  由用户环境决定，Claude Fleet 侧无法更强（Alpha 不引入 taskkill / 信号注入）。
- **Restart 不复用 Session**：实现最小、可测。断点续跑留给未来 Spec。
- **cwd 用 projectDir 近似**：AgentState 不保存原始 cwd；单 workspace 下
  与 launchAgentFlow 的默认 cwd 等价。多 workspace 场景记录为已知限制。
- **Manage Providers 用 QuickPick 而非新 View**：复用 002 交互模式，零 UI 成本。
- **空状态放 webview overlay**：不引入新的 view container。

## 验证策略

- 单测（vitest）：
  - `server/__tests__/agentControl.test.ts` —— `restartConfigFromAgent`
    （含 legacy 回退）、stop 清理顺序（纯函数层：pickAgent 排除逻辑可测部分）；
  - `server/__tests__/cliCheck.test.ts` —— executor 注入：成功 / 命令不存在 /
    非零退出 / 超时；
  - `server/__tests__/manageProviders.test.ts` —— in-memory store + in-memory
    secret 的 delete 联动（删除时先 secret 后 profile；secretRef 缺失时只删 profile）；
  - `server/__tests__/agentRuntime.stopAgent.test.ts` —— stop A 不影响 B
    （两个 fake agent 资源 Map，验证 B 的 watcher/timer 未被触碰）。
- 既有测试回归：`agentStateStore.test.ts`、`hookEventHandler.test.ts`、
  `launchConfig.test.ts` 必须继续通过。
- pipeline：`npm run check-types` / `npm run lint` / `npm run test:server`。
- GUI Smoke（manual）：空状态 / New Agent / 两个 Agent / Status / Focus /
  Restart / Stop / Missing Secret fail-closed —— 记录 manual pending 或实测。
