# 004-minimal-control-ui — Tasks

> Feature slug：`004-minimal-control-ui`
> 关联：[`requirements.md`](./requirements.md) / [`design.md`](./design.md)
> 工作流：`.agent/workflows/implement.md`、`.agent/workflows/review.md`

---

## Tasks 进度总览

```text
T001 完成 Requirements / Design .............. [x]
T002 Claude CLI 可用性检查 ................... [ ]
T003 Stop：真正关闭 + 清理 + 隔离 ............. [ ]
T004 Restart：保留 Repo/Provider/Model ........ [ ]
T005 Manage Providers（List/Create/Delete）.... [ ]
T006 Focus 命令 ............................... [ ]
T007 命令注册 + webview 消息对接 .............. [ ]
T008 空状态 UI + DebugView 控制按钮 ........... [ ]
T009 回归测试（stop A ≠ B / restart / delete） [ ]
T010 pipeline + docs 更新 ..................... [ ]
```

---

## Tasks 进度详情

---

## T001 完成 Requirements / Design

**验证**：

- [x] `requirements.md` / `design.md` 已创建

---

## T002 Claude CLI 可用性检查

**目标**：`adapters/vscode/cliCheck.ts`：

- `ensureClaudeCliAvailable(executor?)` → `{ ok, version } | { ok: false, reason }`；
- 默认 executor 用 `child_process.execFile('claude', ['--version'])`；
- `launchAgentFlow.ts` 在 `launcher()` 之前调用，失败 → `showErrorMessage`
  指定文案并 return（不创建 Terminal）；
- Restart 路径同样调用。

**步骤**：

1. 新建 `adapters/vscode/cliCheck.ts`。
2. `launchAgentFlow.ts` 接入（Step 4 前）。
3. 单测 `server/__tests__/cliCheck.test.ts`：executor 注入覆盖
   成功 / ENOENT / 非零退出 / 超时。

**验证**：

- [ ] 单测全绿；`npm run check-types` 通过

---

## T003 Stop：真正关闭 + 清理 + 隔离

**目标**：`server/src/agentRuntime.ts` 新增 `stopAgent(id)`：

- `terminalRef.dispose()`（try/catch）；
- dismissal / unregister / teammates；
- `removeAgent(id)`（既有清理）。

**步骤**：

1. 实现 `stopAgent`。
2. `PixelAgentsViewProvider`：webview `closeAgent` 消息改走 `stopAgent`
   （与命令同路径）。
3. 单测 `server/__tests__/agentRuntime.stopAgent.test.ts`：
   - stop A：A 的 watcher / timer / store 条目被清理，terminal.dispose 被调用；
   - stop A **不影响** B（B 的 watcher / timer / store 条目原样）；
   - 重复 stop 幂等。

**验证**：

- [ ] 单测全绿

---

## T004 Restart：保留 Repo/Provider/Model

**目标**：`adapters/vscode/agentControl.ts`：

- `restartConfigFromAgent(agent)` 纯函数（cwd=projectDir，profile/model 透传，
  legacy 回退 Inherit）；
- `restartAgent(provider)`：pick → 保存 config → stopAgent → CLI 检查 →
  `launchNewTerminal`（secret 重取，fail-closed）。

**步骤**：

1. 新建 `adapters/vscode/agentControl.ts`（含 `pickAgent` helper）。
2. 单测：`restartConfigFromAgent` 透传 + legacy 回退。

**验证**：

- [ ] 单测全绿

---

## T005 Manage Providers（List/Create/Delete）

**目标**：`adapters/vscode/manageProvidersFlow.ts`：

- `runManageProvidersFlow(store, secrets)`：QuickPick 列表
  （Inherit 标 built-in；Custom 可 Delete；+ Create Custom Provider…）；
- Delete：先 `secretStorage.delete(secretRef)`（失败则中止，不删 profile），
  再 `store.remove(id)`；
- 不提供 Edit（Alpha：Delete + Recreate）。

**步骤**：

1. 新建 `manageProvidersFlow.ts`；`extension.ts` 注册 `COMMAND_MANAGE_PROVIDERS`。
2. 单测（in-memory fake store / fake secretStorage）：
   - delete 联动：secretRef 存在 → 两者都被删；
   - secretRef 缺失 → 只删 profile；
   - secretStorage.delete 抛错 → profile 不被删（一致性）；
   - Inherit 不可删。

**验证**：

- [ ] 单测全绿

---

## T006 Focus 命令

**目标**：`claude-fleet.focusAgent`：pickAgent → `terminal.show()`
（teammate → lead terminal）。

**步骤**：

1. `agentControl.ts` 实现 `focusAgent`。
2. `extension.ts` 注册。

**验证**：

- [ ] 命令注册；check-types 通过

---

## T007 命令注册 + webview 消息对接

**目标**：

1. `package.json` contributes.commands 增加
   `claude-fleet.focusAgent` / `claude-fleet.stopAgent` / `claude-fleet.restartAgent`。
2. `extension.ts` 注册三条命令（与 `manageProviders` 一起）。
3. webview 消息：`stopAgent` / `restartAgent`（DebugView 按钮用）；
   provider 里执行对应命令逻辑。

**验证**：

- [ ] 六条命令都在 `package.json` + `extension.ts`

---

## T008 空状态 UI + DebugView 控制按钮

**目标**：

1. `webview-ui/src/App.tsx`：`agents.length === 0` → 空状态 overlay
   （`No agents running` + `[+ New Agent]` → 消息 `newAgent`）。
2. `PixelAgentsViewProvider`：处理 `newAgent` 消息 →
   `vscode.commands.executeCommand(COMMAND_NEW_AGENT)`。
3. `DebugView.tsx`：Agent card 增加 **Focus / Restart / Stop** 三个按钮
   （消息 `focusAgent` / `restartAgent` / `stopAgent`，复用既有
   `focusAgent` 消息类型）。

**验证**：

- [ ] 构建通过；空状态与按钮的 DOM 结构（data-testid）就位

---

## T009 回归测试

**目标**：覆盖 requirements 全部 Exit Criteria 的可测部分：

- stop A 不影响 B；
- restart 保留 Repo/Provider/Model（`restartConfigFromAgent`）；
- provider delete 移除 SecretStorage secret；
- legacy agent metadata 不崩溃（003 statusLabel 已有；此处补 restart 回退）；
- Claude CLI 检查（T002）。

**验证**：

- [ ] 新增测试全部通过（不掩盖 pre-existing 环境敏感失败）

---

## T010 pipeline + docs 更新

**目标**：

```bash
npm run check-types
npm run lint
npm run test:server
cd webview-ui && npm test
npm run build
```

1. `docs/ARCHITECTURE.md`：新增 agentControl / cliCheck / manageProvidersFlow
   模块行。
2. `docs/ROADMAP.md`：Phase 2/4 状态推进（004 完成控制面）。
3. README / CHANGELOG 由 packaging Task 统一处理（见 Sprint 主任务）。

**验证**：

- [ ] pipeline 全绿（除已记录 baseline）
- [ ] 文档一致
