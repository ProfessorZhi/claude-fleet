# 003-instance-status — Tasks

> Feature slug：`003-instance-status`
> 关联：[`requirements.md`](./requirements.md) / [`design.md`](./design.md)
> 工作流：`.agent/workflows/implement.md`、`.agent/workflows/review.md`

---

## Tasks 进度总览

```text
T001 完成 Requirements / Design ............ [x]
T002 normalizeAgentStatus 纯函数 + 单测 ..... [ ]
T003 hook 广播改为用户状态 ................. [ ]
T004 requestDiagnostics 轮询广播（含 error） [ ]
T005 webview statusLabel / agentStatuses 对接 [ ]
T006 pipeline 验证 ......................... [ ]
T007 docs 与 knowledge 更新 ................ [ ]
```

---

## Tasks 进度详情

---

## T001 完成 Requirements / Design

**目标**：`requirements.md` / `design.md` 落地（本文件）。

**验证**：

- [x] `requirements.md` / `design.md` 已创建

---

## T002 normalizeAgentStatus 纯函数 + 单测

**目标**：新增 `server/src/agentStatus.ts`：

- `UserFacingStatus` 类型（6 值）；
- `AgentStatusInput` 接口；
- `normalizeAgentStatus(input)`（优先级见 design § 状态映射）；
- `agentStateToUserStatus(agent)`（从 AgentState 字段取数）；
- `agentStateToUserStatusWithError(agent, { jsonlExists, createdAt, now })`
  （error 判定 + 转交 normalizeAgentStatus）。

**步骤**：

1. 新建 `server/src/agentStatus.ts`（纯函数，无 vscode / fs 依赖）。
2. `AgentState` 增加 transient `createdAt?: number`（`server/src/types.ts`）。
3. 新建 `server/__tests__/agentStatus.test.ts`：
   - 6 种用户状态各 ≥1 例；
   - 优先级顺序（waiting > working > idle > starting）；
   - `stopped` / `error` 显式短路；
   - legacy 输入（空对象 / 未知字段）→ `starting`；
   - error 判定：文件消失（lines>0 + !jsonlExists）→ error；
     超时（createdAt 30s 前 + !jsonlExists + 非 external/hooksOnly）→ error；
     无 createdAt 不触发超时 error；
     hooksOnly 不触发超时 error。

**验证**：

- [ ] `npx vitest run server/__tests__/agentStatus.test.ts` 全绿

---

## T003 hook 广播改为用户状态

**目标**：`server/src/hookEventHandler.ts` `handlePreToolUse` 广播
`status: 'working'`（替代 `'active'`）；Stop / Permission 维持 `'waiting'`。

**验证**：

- [ ] grep 确认 `status: 'active'` 不再从 hook 路径广播（兼容见 T005）
- [ ] 既有 `hookEventHandler.test.ts` 通过（如断言 'active' 则同步更新为 'working'）

---

## T004 requestDiagnostics 轮询广播（含 error）

**目标**：

1. `adapters/vscode/agentManager.ts`：`launchNewTerminal` 设置 `agent.createdAt`；
   `sendCurrentAgentStatuses` 改为广播归一化状态。
2. `adapters/vscode/PixelAgentsViewProvider.ts`：`requestDiagnostics` 处理时对每个
   agent 计算 `agentStateToUserStatusWithError(...)` 并 `postMessage agentStatus`。

**验证**：

- [ ] 轮询路径每次广播当前用户状态（含 error）
- [ ] `npm run check-types` 通过

---

## T005 webview statusLabel / agentStatuses 对接

**目标**：

1. `webview-ui/src/components/agentMetadata.ts`：`statusLabel` 增加
   `'working' → 'Working'`。
2. `webview-ui/src/hooks/useExtensionMessages.ts`：`agentStatus` 处理改为
   - 任何用户状态都写入 `agentStatuses[id]`（不再对 'active' 删除）；
   - `os.setAgentActive(id, status === 'working' || status === 'active')`（兼容旧广播）；
   - `'waiting'` 维持 bubble 逻辑。
3. `webview-ui/test/agentMetadata.test.ts`：补充 'working' 用例与未知状态回退用例。

**验证**：

- [ ] `cd webview-ui && npx vitest run test/agentMetadata.test.ts` 全绿

---

## T006 pipeline 验证

**目标**：

```bash
npm run check-types
npm run lint
npx vitest run server/__tests__/agentStatus.test.ts server/__tests__/hookEventHandler.test.ts
cd webview-ui && npx vitest run test/agentMetadata.test.ts
```

**验证**：

- [ ] check-types / lint 通过
- [ ] 003 相关单测全绿；pre-existing 环境敏感失败（mockClaudeRunner /
      cli / clientMessageHandler / configPersistence）保持记录，不掩盖

---

## T007 docs 与 knowledge 更新

**目标**：

1. `docs/ARCHITECTURE.md`：状态归一化模块加入"核心模块候选"表。
2. `docs/ROADMAP.md`：Phase 4 状态推进（003 完成）。
3. 如发现可复用经验 → `.agent/knowledge/lessons.md` / `pitfalls.md`。

**验证**：

- [ ] 文档与实现一致
