# 002-provider-model-isolation — Tasks

> Feature slug：`002-provider-model-isolation`  
> 关联：[`requirements.md`](./requirements.md) / [`design.md`](./design.md)  
> ADR：ADR-002（见 [`.agent/knowledge/decisions.md`](../../../.agent/knowledge/decisions.md)）

---

## Tasks 进度总览

```text
T001 调研 Claude Code provider/model 配置与 precedence  [x]
T002 完成 002 Requirements / Design                    [x]
T003 ADR-002 隔离策略                                  [x]
T004 ProviderProfile / ModelProfile domain model       [x]
T005 SecretStorage integration                         [x]
T006 Launch config resolver (resolveClaudeLaunchConfig)[x]
T007 per-instance terminal env                         [x]
T008 per-instance --model                              [x]
T009 +Agent Launch Flow                                [x]
T010 Instance UI metadata                              [x]
T011 isolation tests                                   [x]
T012 integration / smoke validation                    [x]*
T013 docs update                                       [x]
T014 self review                                       [x]
T015 fix: missing-secret fail-closed                   [x]
T016 webview metadata UI + tests                       [x]
```

\* T012 备注：**manual verification pending**。自动化 pipeline（check-types /
lint / build / unit tests / secret-leak grep）全部通过；运行时的手动 Smoke Test
（在 VS Code Extension Dev Host 中真实启动 2 个不同 Provider 的实例，并手动
确认错误路径）需要 GUI 环境，在当前会话中**未**执行。
下一轮 Spec（003 / 后续维护）由人类用户在 VS Code 内补做。

---

## 关键证据（Evidence）

## 关键证据（Evidence）

### T001 调研

- [Claude Code Settings](https://code.claude.com/docs/en/settings)
- [Claude Code env-vars](https://code.claude.com/docs/en/env-vars)
- [Claude Code CLI usage](https://code.claude.com/docs/en/cli-usage)
- 关键发现：`~/.claude/settings.json` 的 `env` block **覆盖** shell env（counter-intuitive），
  因此 per-instance 仅靠 env + `--model` 在用户自定义 settings.json env 时可能不够；
  走 ADR-002 决定 MVP 不强制 `CLAUDE_CONFIG_DIR`。

### T006 实现位置

- `server/src/launchConfig.ts` — 纯函数 `resolveClaudeLaunchConfig(profile, modelId,
cwd, sessionId, secretLookup, opts)`。

### T011 隔离测试

- `server/__tests__/launchConfig.test.ts` —— 19 个测试全部通过（Spec Gap 修复后）。
- 覆盖：
  - Test 1 —— env 独立性（mutate A 不影响 B）
  - Test 2 —— Profile 改动不影响已解析 env
  - Test 3 —— `--model` 每实例独立
  - Test 4 —— secret 不进入 safeMetadata
  - Test 5 —— Inherit profile 不注入 auth env
  - Test 6 —— authToken profile 注入 ANTHROPIC_AUTH_TOKEN
  - **Test 7（修复后）—— missing secret for apiKey profile FAILS CLOSED**（FR-004 + FR-010）
  - **Test 8（修复后）—— missing secret for authToken profile FAILS CLOSED**
  - **Test 9（修复后）—— empty-string secret for apiKey profile FAILS CLOSED**
  - **Test 10（修复后）—— inherit profile 仍然正常（不要求 secret）**
  - Test 11 —— PWD 永远设置 + secret 在任何 auth mode 下都不入 safeMetadata
  - Test 12 —— bypassPermissions / session-id args
  - Test 13 —— safeMetadata 字段透传
  - Plus 6 个 `validateProviderProfile` 测试。

### T016 webview metadata 测试

- `webview-ui/test/agentMetadata.test.ts` —— 17 个测试全部通过。
- 覆盖：`basename`（POSIX / Windows / mixed / trailing slash）、`shortSessionId`（不同路径 / 截短 / 空 / 短 session）、`statusLabel`（每种 status + waitingForInput override）。
- 完整 React 组件测试（rendering、user events）需要 React Testing Library / jsdom，
  当前 webview-ui **未**安装这些依赖，因此本次仅覆盖纯函数层。组件结构（`data-testid`、
  metadata grid、可选字段 fallback）的渲染通过 `npm run build` + 类型检查间接覆盖。

### T015 修复（Spec Gap 收尾）

- `server/src/launchConfig.ts`：
  - 新增 `MissingSecretError`（带 `profileId` / `profileName` / `authMode`）。
  - `resolveClaudeLaunchConfig` 对 `apiKey` / `authToken` 模式在 Secret 缺失或为空时**抛**`MissingSecretError`，**绝不**再静默 fallback 到 Anthropic 登录。
  - `authMode: 'inherit'` 仍然允许没有 Secret（沿用用户当前登录）。
- `adapters/vscode/agentManager.ts`：`launchNewTerminal` 在 `await resolveLaunchConfigFromStore` 之后、`vscode.window.createTerminal` 之前捕获 `MissingSecretError`，调用 `vscode.window.showErrorMessage` 并提前 `return`。
- 触发结果：terminal **不会**被创建，agent **不会**被注册，错误消息明确告知用户"Provider 缺少 Secret，请重新配置"。
- 用户视角：Custom Provider + Secret 缺失时，绝不会误以为在使用该 Custom Provider。

### T016 UI Metadata 修复

- `server/src/agentDiagnostics.ts`：扩展 `AgentDiagnosticsEntry` 含 `providerProfileId` / `providerDisplayName` / `modelId`。
- `webview-ui/src/components/DebugView.tsx`：在 Agent card 标题下方新增 metadata grid（data-testid 已加）：
  - Repo（来自 `projectDir` basename）
  - Provider（来自 `providerDisplayName`，缺省 `—`）
  - Model（来自 `modelId`，缺省 `—`）
  - Session（来自 `jsonlFile` basename 去 `.jsonl` 取前 8 字符，缺省 `—`）
  - Status（来自 `status` 经 `statusLabel` 映射，含 "Waiting for input" override）
- `webview-ui/src/components/agentMetadata.ts`：纯函数 `basename` / `shortSessionId` / `statusLabel` 已提取并单元测试覆盖。
- 不修改 Pixel Office 布局 / Sprite 渲染 / 不在 sprite 上方堆文字。

### T015 / T016 pipeline 结果（修复后）

| 命令                                                         | 结果                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `npm run check-types`                                        | ✅ 0 errors                                                      |
| `npm run lint`                                               | ✅ 0 errors（1 upstream React warning）                          |
| `npm run build`                                              | ✅ dist/extension.js + dist/webview/ + dist/hooks/ + dist/cli.js |
| `npx vitest run server/__tests__/launchConfig.test.ts`       | ✅ 19/19                                                         |
| `cd webview-ui && npx vitest run test/agentMetadata.test.ts` | ✅ 17/17                                                         |
| `gitleaks protect --staged`                                  | ✅ no leaks                                                      |
| grep `sk-...` in dist/adapters/server/core                   | ✅ 零命中（仅 test fixtures 含 mock strings）                    |

详细分解见下文。任务执行时**打勾**，不删除条目。

---

## Exit Criteria 收尾确认

| FR                                                | 状态 | 证据                                                                                                   |
| ------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| FR-004 Secret 安全                                | ✅   | `providerProfile.secretRef`（无 plaintext）；SecretStorage 隔离；`MissingSecretError` 强制 fail-closed |
| FR-009 UI 元数据                                  | ✅   | DebugView 渲染 Repo / Provider / Model / Session / Status（`data-testid` 标记）                        |
| FR-010 错误处理（Missing Secret）                 | ✅   | `MissingSecretError` 在 `createTerminal` 之前抛出；`showErrorMessage` 提示；terminal 不创建            |
| Exit Criteria: ≥2 Instance                        | ✅   | 001 + 002 共同保证；001 已有 baseline 通过                                                             |
| Exit Criteria: 修改 A 不影响 B                    | ✅   | Test 2 单测通过                                                                                        |
| Exit Criteria: Provider Profile non-secret 持久化 | ✅   | `providerProfileStore.ts` 走 VS Code globalState                                                       |
| Exit Criteria: Secret 走 SecretStorage            | ✅   | `secretStorageProvider.ts`                                                                             |
| Exit Criteria: check-types / build / lint 通过    | ✅   | 见 pipeline 表                                                                                         |
| Exit Criteria: isolation tests 通过               | ✅   | 19/19 通过                                                                                             |
| Exit Criteria: 保留 LICENSE + attribution         | ✅   | `LICENSE` 与 `THIRD_PARTY_NOTICES.md` 未改                                                             |

**runtime 手动验证**：标记为 **manual verification pending**（GUI 环境不可用，留给人类用户在 VS Code 中补做）。

---

## T001 调研 Claude Code provider/model 配置与 precedence

**目标**：明确 Claude Code 在 env / flag / settings.json 之间的 precedence，决定
002 的隔离策略。

**步骤**：

1. 阅读 [Claude Code Settings 文档](https://code.claude.com/docs/en/settings) 与
   [env-vars 文档](https://code.claude.com/docs/en/env-vars)。
2. 确认 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
   `ANTHROPIC_MODEL` 的优先级。
3. 确认 `claude --model` 与 `ANTHROPIC_MODEL` 的关系（CLI 覆盖 env）。
4. 确认 `CLAUDE_CONFIG_DIR` 的行为（settings/hooks/credentials）。
5. 调研 `~/.claude/settings.json` 的 `env` block 会**覆盖** shell env（counter-intuitive）
   的事实。

**Evidence**：本 Task 主要贡献给 ADR-002。

**验证**：

- [ ] ADR-002 中所有 claim 都能溯源到 Claude Code 官方文档

---

## T002 完成 002 Requirements / Design

**目标**：写出 001 风格的小而清晰的 Spec。

**步骤**：

1. 创建 `docs/specs/002-provider-model-isolation/{requirements,design}.md`。
2. requirements 至少包含 FR-001 ~ FR-010 + NFR + Out of Scope + Exit Criteria。
3. design 至少包含 Context、ADR 摘要、高层形态、模块、数据、接口、失败模式、取舍、验证。

**验证**：

- [ ] `requirements.md` 与 `design.md` 已落地

---

## T003 ADR-002 隔离策略

**目标**：在 `.agent/knowledge/decisions.md` 写入 ADR-002，决定 002 是否使用 per-instance
`CLAUDE_CONFIG_DIR`。

**结论（已写入 design § ADR-002 摘要）**：MVP 采用方案 A —— 仅 per-terminal env + `--model`，
**不**使用 `CLAUDE_CONFIG_DIR`。

**验证**：

- [ ] `decisions.md` 出现 ADR-002
- [ ] ADR-002 的 Reasons / Consequences 明确解释限制

---

## T004 ProviderProfile / ModelProfile domain model

**目标**：在 `core/src/` 增加 `ProviderProfile` / `ModelProfile` / `InstanceLaunchConfig` /
`ResolvedLaunchConfig` 的 type 定义与 zod schema。

**步骤**：

1. 新文件 `core/src/providerProfiles.ts`（types 与 schema）。
2. 不在 core 里写 IO 逻辑（IO 在 adapter 层）。

**验证**：

- [ ] type 与 zod schema 已存在
- [ ] `npm run check-types` 通过

---

## T005 SecretStorage integration

**目标**：封装 `vscode.SecretStorage` 的最小读写 API（`SecretStorageProvider`）。

**步骤**：

1. 新文件 `adapters/vscode/secretStorageProvider.ts`。
2. 实现 `set / get / delete`，对存储失败显式抛错。
3. 实现 `hasStorage()` 探测：SecretStorage 不可用时返回 false。
4. **绝不在 log 中打印 secret value**。

**验证**：

- [ ] SecretStorageProvider 实现存在
- [ ] 单元测试覆盖 set/get/delete + 不可用分支

---

## T006 Launch config resolver (resolveClaudeLaunchConfig)

**目标**：实现纯函数 `resolveClaudeLaunchConfig(profile, modelId, cwd, sessionId, secretLookup)`，
返回 `{ env, args, safeMetadata }`。

**步骤**：

1. 新文件 `server/src/launchConfig.ts`（与 `server/src/agentStateStore.ts` 平级）。
2. 纯函数，**不**直接读 SecretStorage —— 通过 `secretLookup` 注入，便于测试。
3. env 合成：
   - `authMode: 'inherit'` → 不注入 `ANTHROPIC_*` auth；
   - `authMode: 'apiKey'` → 注入 `ANTHROPIC_API_KEY=<lookup(secretRef)>`；
   - `authMode: 'authToken'` → 注入 `ANTHROPIC_AUTH_TOKEN=<lookup(secretRef)>`；
   - `baseUrl` 非空 → 注入 `ANTHROPIC_BASE_URL=<baseUrl>`；
   - `customHeaders` → **不通过 env**（Claude Code 当前不直接读取 header env）；
     写入 `safeMetadata` 供 future Spec 使用，本期不真正生效。
4. args：必含 `--session-id <id>`；modelId 非空时追加 `--model <modelId>`；
   bypassPermissions 时追加 `--dangerously-skip-permissions`（与上游兼容）。
5. safeMetadata：包含 `providerProfileId` / `providerDisplayName` / `modelId`，**绝不**含
   secret 或 env 内容。

**验证**：

- [ ] `resolveClaudeLaunchConfig` 实现存在
- [ ] 单元测试覆盖：每种 authMode、有 / 无 modelId、有 / 无 baseUrl、bypassPermissions

---

## T007 per-instance terminal env

**目标**：让 `vscode.window.createTerminal({ env })` 接收 resolve 出来的 `env`，
且**保证每个 terminal 拿到独立的 env 对象**（不共享引用）。

**步骤**：

1. 扩展 `adapters/vscode/agentManager.ts` 的 `launchNewTerminal` 入参：接受
   `InstanceLaunchConfig`。
2. 内部：调用 `resolveClaudeLaunchConfig` → 拿到 `env, args, safeMetadata` → 把 env 透传给
   `vscode.window.createTerminal({ name, cwd, env })`。
3. env 对象**深拷贝**（避免任何上游 closure 共享）。
4. `AgentState` 增加 `providerProfileId` / `providerDisplayName` / `modelId` 字段
   （在 `server/src/types.ts`）；`PersistedAgent` 同步增加。

**验证**：

- [ ] 单元测试：两个 launch 调用产生的 env 对象 `!==`，且各自 modify 不影响对方

---

## T008 per-instance --model

**目标**：让每 Instance 启动时 `claude` 命令带正确的 `--model <id>`。

**步骤**：

1. 扩展 `server/src/providers/hook/claude/claude.ts` 的 `buildLaunchCommand`：
   - 入参新增 `modelId`；
   - 当 `modelId` 非空时追加 `--model <modelId>`。
2. 把 `resolveClaudeLaunchConfig` 的 `args` 与 `buildLaunchCommand` 的输出**协调**：
   最终 launch command = `['claude', ...args, ...buildLaunchArgs]`。
3. **测试**：A 用 `--model model-a`，B 用 `--model model-b`，两条命令分别含正确 flag，
   互不影响。

**验证**：

- [ ] `buildLaunchCommand` 扩展测试通过
- [ ] 集成测试：两条 launch 命令分别含 `--model a` 与 `--model b`

---

## T009 +Agent Launch Flow

**目标**：`+ Agent` 不再直接 launch Claude Code；改为 QuickPick / InputBox 三步流程。

**步骤**：

1. 新命令 `claude-fleet.newAgent`（在 `package.json` 注册）。
2. 实现 `adapters/vscode/launchAgentFlow.ts`：
   - Step 1 — Repo: QuickPick workspaces；只有一个 workspace 时直接用 cwd；
   - Step 2 — Provider: QuickPick 已存在的 Profiles + "Create Custom Provider…" 选项；
   - Step 3 — Model: QuickPick（已有 Profiles 的 default）+ "Enter model id…" 选项。
3. "Create Custom Provider…" 子流程：InputBox 收集 name / baseUrl / authMode / secret /
   model，然后用 `ProviderProfileStore.upsert` + `SecretStorageProvider.set` 保存。
4. 收集完成后调用 `launchNewTerminal(... launchConfig ...)`。
5. **保留**原有 `claude-fleet.autoSpawnAgent` 行为：在只有一个 workspace + 只有 Inherit
   Profile 时直接 launch（兼容 001 的体验）。

**验证**：

- [ ] `claude-fleet.newAgent` 命令注册
- [ ] QuickPick / InputBox 流程实现
- [ ] Custom Provider 子流程能保存 secret 到 SecretStorage

---

## T010 Instance UI metadata

**目标**：Pixel UI 上能看出每个 Instance 的 Repo / Provider / Model / Session / Status。

**步骤**：

1. 把 `safeMetadata` 加进 `AgentState`，并在 `agentManager.ts` 创建时填入。
2. Webview DTO（webview-ui/src）增加对应字段（minimal：
   `providerDisplayName`、`modelId`）。
3. UI 展示：在 sprite 上方 label / tooltip / detail panel 至少一处显示
   `Provider · Model`。
4. **不**重做 Pixel Office 整体布局。

**验证**：

- [ ] `AgentState` 含 providerDisplayName / modelId
- [ ] Webview 收到对应字段
- [ ] UI 至少一处显示

---

## T011 isolation tests

**目标**：新增单元测试覆盖隔离性 / 安全 / 持久化。

**必须覆盖**（参见 requirements § FR-001 ~ FR-004 与 design § 验证策略）：

- **Test 1**：A 与 B 用不同 Profile → 解析后的 env `!==` 且各自 modify 不影响对方；
- **Test 2**：A 修改 Profile 后，已解析 B 的 env **不变**；
- **Test 3**：A 用 `--model model-a`，B 用 `--model model-b`，launch command 分别含
  正确 flag；
- **Test 4**：secret 不出现在任何 `safeMetadata` / 序列化 state；
- **Test 5**：删除 Provider Profile 不破坏已有 Instance（launch-time config 已固化）。

**验证**：

- [ ] 新增测试全部通过

---

## T012 integration / smoke validation

**目标**：跑完整 pipeline。

**步骤**：

```bash
npm run check-types
npm run lint
npm test
npm run build
grep -rE 'sk-(live|test)?[A-Za-z0-9_-]{16,}|ANTHROPIC_API_KEY=[^\s]*[A-Za-z0-9_-]{16,}' dist/ webview-ui/src adapters server core
```

**期望**：

- check-types / lint / build 全部通过；
- 新增 isolation tests 通过；上游 pre-existing 失败（mockClaudeRunner.test.ts 时间
  敏感）继续 known-failure；
- grep 在 non-test 产物里零命中。

**验证**：

- [ ] 上面四条命令全部输出符合预期

---

## T013 docs update

**目标**：让文档与实现保持一致。

**步骤**：

1. `docs/ARCHITECTURE.md`：在"核心模块候选"表格新增 Provider / Model 隔离模块（标 "当前
   选择"）；"已确认架构决策"加入 ADR-002。
2. `docs/ROADMAP.md`：Phase 3 状态推进（如果实现完成），但**不**宣布 Phase 3 整体 Exit
   Criteria 全部达成（还需隔离回归测试持续验证）。
3. `.agent/references/pixel-agents.md`：补充说明 002 在哪些上游函数上扩展
   （`buildLaunchCommand` / `launchNewTerminal`）。
4. 如发现可复用经验 → `.agent/knowledge/lessons.md` / `pitfalls.md`。

**验证**：

- [ ] ARCHITECTURE / ROADMAP / pixel-agents 参考都已更新

---

## T014 self review

**目标**：按 `.agent/workflows/review.md` 与 002 §"33 最终 Self Review"逐项检查。

**额外必须回答**：

- 是否修改用户全局 `~/.claude/settings.json`？—— **否**
- 两个 Instance 是否拥有独立 env？—— **是**
- 两个 Instance 是否能拥有不同 `--model`？—— **是**
- API Key 是否进入 Git / globalState / Webview / log？—— **否**
- Provider 与 Coding Agent Runtime 是否被正确区分？—— **是**
- 是否避免重新创建第二套 Instance Runtime？—— **是**
- CLAUDE_CONFIG_DIR 是否经过明确 ADR？—— **是**（ADR-002）

---

## 不在范围内（再次强调）

002 **不**包含 LiteLLM / OpenAI 协议转换 / Codex / Gemini / Antigravity / Marketplace /
Worktree Manager / Docker / 多人协作 / Token 计费 / Provider Marketplace。这些属于后续
Spec 或永不做。
