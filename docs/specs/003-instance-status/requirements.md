# 003-instance-status — Requirements

> Feature slug：`003-instance-status`
> 关联：001-multi-instance-runtime（Runtime 基线）/ 002-provider-model-isolation（Provider / Model 元数据）
> 工作流：`.agent/workflows/spec-coding.md`、`.agent/workflows/implement.md`、`.agent/workflows/review.md`

---

## 目标（Goal）

为用户提供一个**轻量、可理解**的 Agent 状态层：把现有内部状态（reading / writing /
command / tool / permission / waitingForInput / idle / done 等）归一化为一组
**用户可读的状态**（Starting / Working / Waiting / Idle / Error / Stopped），
并能在 UI（Debug View / 空状态）中展示，同时为 004 的 Stop / Restart 控件提供
状态依据。

## 用户故事（User Stories）

- 作为一个用户，我打开 Claude Fleet 面板后，能立即看出每个 Agent 现在
  **在干活（Working）**、**在等我输入（Waiting）**、还是**闲着（Idle）**。
- 作为一个用户，我想区分"刚刚启动还没就绪"（Starting）和"已经停止"（Stopped）。
- 作为一个用户，当 Agent 出错（例如进程退出、JSONL 丢失）时，我想看到 Error，
  而不是一个永远停留在 Working 的假状态。

## 功能性需求（Functional Requirements）

- **FR-001**：定义 `UserFacingStatus` 类型，取值恰好为：
  `starting | working | waiting | idle | error | stopped`。
- **FR-002**：提供纯函数 `normalizeAgentStatus(...)`，把内部状态（`isWaiting`、
  `permissionSent`、`hadToolsInTurn`、`hookDelivered`、`linesProcessed`、
  `lastDataAt`、`activeToolIds`、`activeToolStatuses` 等）映射为
  `UserFacingStatus`。该函数**不依赖** VS Code / webview API，可单测。
- **FR-003**：映射优先级明确（见 design.md § 状态映射）。同一条规则先命中先赢，
  规则顺序有文档与测试。
- **FR-004**：状态变化以消息 `agentStatus`（扩展 `status` 字段）广播给 webview，
  复用现有 AgentStateStore broadcast 通道；**不**新建第二套运行时。
- **FR-005**：Debug View 的 Status 行使用归一化后的用户状态显示（含
  `waitingForInput` 细节仍可显示为 "Waiting for input"）。
- **FR-006**：webview 侧的 `agentStatuses` 字典与 `statusLabel` 纯函数
  与新的用户状态枚举一致；`statusLabel` 对未知 / legacy 状态**不崩溃**，
  回退为传入值或 `Idle`。
- **FR-007**：Error 状态必须有明确的触发条件（进程 / JSONL 探测失败路径），
  不允许"永远 Working"。

## 非功能性需求（Non-Functional Requirements）

- **NFR-001 可测试**：`normalizeAgentStatus` 与 `statusLabel` 都是纯函数，
  至少 20 个断言级别的单测覆盖（每种用户状态 + 优先级 + legacy 输入）。
- **NFR-002 无新运行时**：本 Feature 不创建新的 Agent Runtime / 状态机 /
  持久化结构。全部复用 001/002 已有 `AgentState` 字段。
- **NFR-003 向后兼容**：legacy Agent（001 时代，无 provider/model 字段、状态字典
  里没有新状态值）不得崩溃，不得把状态显示成 `undefined`。

## 不在范围内（Out of Scope）

- 重建 Pixel Agents 状态系统 / AgentState 结构。
- 新增持久化字段或状态迁移。
- 状态机的历史 / 时间线记录。
- 任何 UI 重构（只改 Debug View 的 Status 行展示与空状态文案）。
- 005+ 的任何能力。

## 开放问题（Open Questions）

- （无阻塞项。Error 的探测口径：Alpha 采用"已注册但 JSONL 从未出现 + 超时"
  与"hookDelivered 但长时间无数据"两类启发式，具体阈值见 design.md。）

## Exit Criteria

- [ ] `normalizeAgentStatus` 纯函数存在且被单测覆盖（全部用户状态至少各 1 例）。
- [ ] `agentStatus` 消息携带归一化状态（webview 收到 `starting`/`working`/
      `waiting`/`idle`/`error`/`stopped` 之一）。
- [ ] Debug View Status 行展示用户状态；legacy agent 不崩溃（有测试）。
- [ ] `statusLabel` 支持全部用户状态 + 未知状态回退（有测试）。
- [ ] `npm run check-types` / `npm run lint` / 相关单测通过。
