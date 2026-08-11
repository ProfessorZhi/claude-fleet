# 003-instance-status — Design

> 关联：[`requirements.md`](./requirements.md)
> 上游基线：001（AgentState / AgentStateStore / hookEventHandler / fileWatcher / JSONL transcript）
> 元数据基线：002（providerProfileId / providerDisplayName / modelId）

---

## Context

001/002 建立了多实例 Runtime 与 Provider / Model 隔离，但**没有统一的用户状态层**：

- 内部状态分散在 `AgentState` 布尔字段（`isWaiting` / `permissionSent` /
  `hookDelivered` / `linesProcessed` / `lastDataAt`）、`activeToolStatuses`
  （reading / writing / command / tool / permission 等工具级状态）、
  hook 广播（`active` / `waiting`）与 JSONL 解析之间。
- Debug View 的 Status 行直接吃 hook 广播：Agent 活跃时 `agentStatuses[id]`
  被删除 → `statusLabel(undefined)` → **显示 "Idle"，哪怕 Agent 正在干活**。

本 Feature 不新建运行时，只加**一层纯函数归一化** + **广播与展示对接**。

## 高层形态

```
AgentState（内部字段，001/002 已有）
   │
   ├─ hook 事件（PreToolUse/Stop/Permission） ──► 广播 agentStatus: 'working' | 'waiting'
   │
   └─ requestDiagnostics 轮询（2s） ──► normalizeAgentStatus(agentStateToUserStatus(agent))
                                          │
                                          ▼
                                     agentStatus: starting|working|waiting|idle|error|stopped
                                          │
   webview agentStatuses[id] ◄────────────┘
       │
       ▼
   DebugView statusLabel(...) ──► "Starting" / "Working" / "Waiting" / "Idle" / "Error" / "Stopped"
```

## 模块职责

| 模块                                                   | 职责                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/agentStatus.ts`（新增，纯函数）            | `UserFacingStatus` 类型、`normalizeAgentStatus(input)`、`agentStateToUserStatus(agent)`。无 vscode / fs / 时间依赖（时间由调用方注入）。 |
| `server/src/hookEventHandler.ts`（小改）               | `handlePreToolUse` 广播 `status: 'working'`（替代 `'active'`）；Stop / Permission 维持 `'waiting'`。                                     |
| `adapters/vscode/agentManager.ts`（小改）              | `launchNewTerminal` 设置 transient `agent.createdAt`；`sendCurrentAgentStatuses` 重发归一化状态。                                        |
| `adapters/vscode/PixelAgentsViewProvider.ts`（小改）   | `requestDiagnostics` 处理时对每个 agent 计算并广播一次 `agentStatus`（含 error 判定）。                                                  |
| `server/src/types.ts`（小改）                          | `AgentState` 增加 transient `createdAt?: number`（**不持久化**）。                                                                       |
| `webview-ui/src/hooks/useExtensionMessages.ts`（小改） | `agentStatus` 处理：'working' 保留在 `agentStatuses` 中（不再删除），`os.setAgentActive` 兼容 'working'/'active'。                       |
| `webview-ui/src/components/agentMetadata.ts`（小改）   | `statusLabel` 增加 'working' → 'Working'；其余用户状态已支持。                                                                           |

## 数据 / 状态形态

### UserFacingStatus

```ts
export type UserFacingStatus =
  | 'starting' // 已创建，但既无 hook 也无 transcript 数据
  | 'working' // 有活跃工具 / hook 证明正在干活
  | 'waiting' // 等待用户输入 / 等待权限 / hook Stop
  | 'idle' // 有历史数据，当前无动作
  | 'error' // 明确失败信号（transcript 消失 / 超时未出现）
  | 'stopped'; // 终端状态（Alpha：stop 后卡片移除，此值仅在瞬态出现）
```

### normalizeAgentStatus 优先级（先命中先赢，顺序被测试锁定）

| #   | 条件                                                 | 结果                                      |
| --- | ---------------------------------------------------- | ----------------------------------------- |
| 1   | `stopped === true`                                   | `stopped`                                 |
| 2   | `error === true`                                     | `error`                                   |
| 3   | `isWaiting \|\| permissionSent \|\| waitingForInput` | `waiting`                                 |
| 4   | `activeToolCount > 0`                                | `working`                                 |
| 5   | `linesProcessed > 0`                                 | `idle`                                    |
| 6   | `hookDelivered === true && !hooksOnly`               | `starting`（hook 已到但 transcript 未到） |
| 7   | 其余（含全空输入）                                   | `starting`                                |

**为什么不把 `hookDelivered` 直接判为 working**：`hookDelivered` 是粘滞标记
（第一次 hook 事件后一直为 true），不能区分"正在干活"与"干完了在等输入"；
"working" 由 **事件广播**（PreToolUse → 'working'）驱动，`normalizeAgentStatus`
只负责轮询路径的**派生**状态。

### error 判定（在 PixelAgentsViewProvider 的 requestDiagnostics 中，唯一有

fs + 时间的地方）

- JSONL 曾经有数据（`linesProcessed > 0`）但现在文件不存在 → `error`；
- 非 external、非 hooksOnly、JSONL 从未出现、终端已经退出且
  `now - createdAt > 30_000` → `error`（启动后 30s 连 transcript 都没有，且
  终端已结束，判定启动失败）。
- 终端仍存活（`terminalRef?.exitStatus === undefined`）时，即使超过 30s 仍无
  transcript，也保持 `starting`，因为 Claude 可能还在等待用户的首条输入。
- 其余情况交给 `normalizeAgentStatus` 的默认优先级。

### 广播

- 现有 `agentStatus` 消息复用，`status` 字段取用户状态。webview 的
  `agentStatuses` 字典语义从"仅记录 waiting"改为"记录当前用户状态"。
- `agentClosed` 时 webview 删除条目（既有行为）。

## 接口（Interfaces）

```ts
// server/src/agentStatus.ts
export type UserFacingStatus = ...;                       // 见上
export interface AgentStatusInput { ... }                 // 见 requirements FR-002
export function normalizeAgentStatus(input: AgentStatusInput): UserFacingStatus;
export function agentStateToUserStatus(agent: AgentState): UserFacingStatus;
export function agentStateToUserStatusWithError(agent: AgentState, opts: {
  jsonlExists: boolean; createdAt: number | undefined; now: number;
}): UserFacingStatus;
```

## 失败模式（Failure Modes）

| 失败                             | 表现                    | 应对                                                                      |
| -------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| legacy agent 无新字段            | 状态字典无 'working' 等 | `statusLabel` 未知值回退原样 / 'Idle'，不崩溃                             |
| `createdAt` 缺失（restore 路径） | error 判定无法超时      | `createdAt === undefined` 时不触发超时 error，仅用文件消失规则            |
| webview 收到旧格式 'active'      | 兼容期                  | `os.setAgentActive` 兼容 'working' / 'active'                             |
| hooksOnly agent 无 JSONL         | 永远 starting           | `hooksOnly === true` 时跳过"JSONL 未出现"error 规则；状态由 hook 广播驱动 |

## 取舍（Trade-offs）

- **复用 `agentStatus` 消息而非新增消息类型**：webview 改动最小；风险是
  语义变化（'active' 删除行为）。兼容处理：'active' 仍被 `os.setAgentActive`
  识别，但不再从字典删除（旧广播罕见，影响可忽略）。
- **error 用启发式而非精确进程退出检测**：Alpha 无进程退出回调
  （terminal 关闭即整体移除 agent，onDidCloseTerminal 已处理）；
  文件级启发式覆盖了最常见的"启动失败 / transcript 丢失"。
- **不在 UI 保留 Stopped 卡片**：Alpha 的 Stop 语义是"真正关闭并清理"，
  卡片随 `agentClosed` 消失；Stopped 状态值仅用于归一化接口与瞬态展示。

## 验证策略

- 单测（vitest，`server/__tests__/agentStatus.test.ts`）：
  每个用户状态至少 1 例、优先级顺序用例、legacy 输入、时间注入边界。
- webview 单测（`webview-ui/test/agentMetadata.test.ts`）：`statusLabel`
  覆盖全部 6 种用户状态 + 未知状态回退。
- pipeline：`npm run check-types` / `npm run lint` / `npm run test:server` /
  `cd webview-ui && npm test`。
