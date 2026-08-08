# 005-provider-registry-session-continuity — Design

> Context：[requirements.md](./requirements.md)；相关 ADR：ADR-002（per-terminal
> env + `--model`，本轮保留）、ADR-003（Fleet 是管理层，不是 Claude Code
> fork）、ADR-004（ProviderDefinition ≠ ProviderProfile）、ADR-005
> （Session ≠ Provider）、ADR-006（native resume 是唯一会话连续性手段）、
> ADR-007（Auto Discovery 一等公民）。

---

## 高层形态

```text
Claude Fleet
│
├── Provider Registry            ← 本轮核心
│   ├── ProviderDefinition       （模板：native-anthropic / anthropic-api /
│   │                              bedrock / vertex / foundry /
│   │                              anthropic-compatible(+presetId)）
│   └── ProviderProfileStore     （用户配置实例：displayName / type / preset /
│                                  authStrategy / endpoint / secretRef /
│                                  modelIds / enabled）
├── Secret Store                 （VS Code SecretStorage，不落盘明文）
├── Session Registry             （AgentState.cwd / sessionId / provider / model /
│                                  managedByFleet；Restart/Switch 的元数据来源）
├── Instance Manager             （launchNewTerminal / Stop / Focus / Restart）
├── Auto Discovery               （global scanner / external adoption / upsert 去重）
├── Status / Pixel UI            （Agent card：Repo / Provider / Model / Session /
│                                  Status / Managed）
│
└── Claude Code Runtime Adapter
    ├── resolveClaudeLaunchConfig（唯一 Resolver：Profile+Secret → env/args/safeMetadata）
    └── buildLaunchCommand       （claude 原生参数：--model / --resume / --session-id /
                                   --continue / --dangerously-skip-permissions）
         └── native `claude` CLI
```

## 核心决策

### D1. ProviderDefinition 与 ProviderProfile 分层（FR-001/002）

```ts
// core/src/providerRegistry.ts（新）
type ProviderType =
  | 'native-anthropic' // Claude account OAuth 登录
  | 'anthropic-api' // Console API Key
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'anthropic-compatible';

interface ProviderDefinition {
  id: string; // 'deepseek' | 'minimax' | 'anthropic-account' ...
  displayName: string; // 'DeepSeek' | 'MiniMax' ...
  providerType: ProviderType;
  runtime: 'claude-code';
  authStrategy: 'native-login' | 'api-key' | 'auth-token' | 'external-credential-chain';
  /** 官方稳定端点；仅官方文档验证后填充 */
  defaultEndpoint?: string;
  /** 官方推荐 model hints；仅官方验证后填充，否则为空 */
  supportedModelHints?: string[];
  /** 官方要求的额外 env（如 CLAUDE_CODE_AUTO_COMPACT_WINDOW） */
  requiredEnv?: Record<string, string>;
  /** 官方信息未能可靠验证时标记；用户仍可手动 Custom 配置 */
  verified: boolean;
}
```

`ProviderProfile` 扩展现有 `core/src/providerProfiles.ts`：

```ts
interface ProviderProfile {
  id: string;
  displayName: string;
  providerType: ProviderType;
  presetId?: string; // definition id；custom 无
  authStrategy: AuthStrategy;
  endpoint?: string;
  secretRef?: string;
  modelIds?: string[]; // 默认模型列表，可选
  enabled: boolean;
  createdAt?: number;
}
```

新增 Provider 只加 definition 条目 + Profile，Runtime 核心零改动。
**没有任何 `if (presetId === 'deepseek')` 散落。** 唯一分支点是
`providerType`（如 native-login 不注入 env；anthropic-compatible 注入
base_url + token）。

### D2. 官方 Preset 数据（FR-007，只含官方文档验证值）

| presetId                         | providerType           | authStrategy              | endpoint (官方)                                                                                    | env (官方)                                                                                                                                                                                                                                                                                        | model hints (官方)                         |
| -------------------------------- | ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `deepseek`                       | anthropic-compatible   | auth-token                | `https://api.deepseek.com/anthropic`                                                               | `ANTHROPIC_AUTH_TOKEN`（用户 Key）；官方还建议 `ANTHROPIC_MODEL=deepseek-v4-pro[1m]`、`ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]`、`ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]`、`ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash`、`CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash` | `deepseek-v4-pro[1m]`, `deepseek-v4-flash` |
| `minimax`                        | anthropic-compatible   | auth-token                | 国际 `https://api.minimax.io/anthropic`；中国 `https://api.minimaxi.com/anthropic`（用户按区域选） | `ANTHROPIC_AUTH_TOKEN`（用户 Key）；`CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000`（1M 上下文）；官方建议 `ANTHROPIC_MODEL=MiniMax-M3[1m]` + `ANTHROPIC_DEFAULT_*_MODEL`                                                                                                                               | `MiniMax-M3[1m]`                           |
| `anthropic-account`              | native-anthropic       | native-login              | —（沿用 Claude Code 自身登录）                                                                     | —                                                                                                                                                                                                                                                                                                 | —                                          |
| `anthropic-api`                  | anthropic-api          | api-key                   | `https://api.anthropic.com`（Claude Code 默认）                                                    | `ANTHROPIC_API_KEY`（用户 Key）                                                                                                                                                                                                                                                                   | 官方 model id                              |
| `bedrock` / `vertex` / `foundry` | bedrock/vertex/foundry | external-credential-chain | —                                                                                                  | Claude Code 官方 native provider 配置（aws/gcp/azure credential chain 由原系统管理，Fleet 不复制 Secret）                                                                                                                                                                                         | 官方 model id                              |

来源：[DeepSeek API Docs — Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)、
[MiniMax API Docs — Claude Code](https://platform.minimax.io/docs/token-plan/claude-code)。
**任何无法从官方文档验证的 preset 一律 `verified: false`，不编造 endpoint/model。**

### D3. Resolver 唯一真相（FR-008）

扩展 `server/src/launchConfig.ts` 的 `resolveClaudeLaunchConfig`，按
`providerType` 分支（唯一的类型级分支）：

- `native-login` → env 不含任何 ANTHROPIC_BASE_URL/TOKEN/KEY（让 Claude Code
  用自身登录态）；可额外设 `ANTHROPIC_MODEL`/`--model`。
- `api-key` → `ANTHROPIC_API_KEY`（来自 SecretStorage）。
- `auth-token` → `ANTHROPIC_BASE_URL`（endpoint）+ `ANTHROPIC_AUTH_TOKEN`。
- `external-credential-chain` → Claude Code 官方 native provider 配置
  （本轮实现：提供 profile 形态，env 由官方原生机制处理；若官方文档不支持
  则 `verified:false` 并提示手动配置）。
- 一律 merge preset 的 `requiredEnv`（DeepSeek 的 DEFAULT_*_MODEL 等）。

New Agent / CLI / Restart / Switch 四个入口全部调用同一 resolver。

### D4. Session 连续性 = Claude Code 原生 Resume（FR-009/010/011/012）

`claude` 2.1.220 实际能力（`claude --help` 实测）：

- `-r, --resume [value]` —— 按 session ID resume，或打开交互 picker；
- `-c, --continue` —— 继续当前目录最近会话；
- `--session-id <uuid>` —— 指定会话 ID（必须合法 UUID）；
- `--fork-session` —— resume 时 fork 新 ID（配 --resume/--continue）；
- `--model <model>` —— 本会话模型。

launch command 生成规则（`buildLaunchCommand` 扩展）：

- **New Session**：`claude --session-id <new-uuid> [--model X] [permissions]`。
- **Restart（resume 同会话）**：`claude --resume <sessionId> [--model X]`。
  保留 `sessionId / cwd / providerProfileId / modelId` → Stop → 重解析 Secret →
  launch。
- **Switch Provider**：同一 `cwd + sessionId`，新的 Provider env + 可选新
  Model，`claude --resume <sessionId>`。
- **Resume 失败**：Claude Code 拒绝 resume 时（无法从 CLI 直接捕获 TUI 内部
  失败），通过 transcript 观察 session 是否产出新内容判断；无法可靠判断时
  提供显式确认路径 —— 不静默 fork。设计上保留 `--fork-session` 作为用户
  显式选择"另起对话"的入口（Switch 流程提供确认对话框：
  resume 失败 → 提示 → 用户确认 → 才 `--fork-session`/new session）。

> 注意：transcript 是本地 JSONL，resume 是本地重放，理论上与 Provider 无关；
> 真实验证留给用户手动测试（自动测试只验证 launch semantics —— 参数/env/顺序）。

### D5. AgentState / PersistedAgent 扩展（FR-013）

```ts
// AgentState 新增
managedByFleet?: boolean;     // 由 Fleet launch 的实例（vs 外部扫描发现）
lastProviderProfileId?: string; // Switch 前 provider（可选，最小化）
// PersistedAgent 同步新增（sessionId/cwd/provider/model 已有）
```

`sessionId` 已是持久化字段；Fleet launch 的 instance 在 launch 时就登记
`managedByFleet=true`，Auto Discovery 重新发现同一 sessionId 时
**upsert 恢复 provider/model/managedByFleet，不新建 Agent**（按
sessionId 去重，见 006/FR）。

### D6. CLI（FR-014）

`server/src/cli.ts` 增加：

- `claude-fleet providers` —— list configured profiles（显示名/类型/状态，
  无 Secret）。
- `claude-fleet launch` —— 交互：Repo → Profile → Model → New/Resume →
  resolve → spawn 原生 `claude`。

CLI 复用同一 `ProviderRegistry` + `resolveClaudeLaunchConfig`。CLI 的
SecretStorage 替代 = 本地 `~/.claude-fleet/secrets.json`（仅 CLI 用，
chmod 600 / 指明未加密是 alpha 限制，VS Code 侧仍用 SecretStorage）——
**本轮最小实现**：CLI 从同一 ProfileStore 读取 profile，secret 通过
`secretLookup` 注入函数（VS Code 传 SecretStorage，CLI 传本地文件读取器）。

---

## 模块职责

| 模块                 | 职责                                         | 位置                                                 |
| -------------------- | -------------------------------------------- | ---------------------------------------------------- |
| ProviderRegistry     | definitions 常量 + 查询                      | `core/src/providerRegistry.ts`（新）                 |
| ProviderProfileStore | profile CRUD（globalState）                  | `adapters/vscode/providerProfileStore.ts`（扩展）    |
| SecretStore          | SecretStorage 封装                           | 现有 `secretStorageProvider.ts`                      |
| Resolver             | Profile+Secret → env/args/safeMetadata       | `server/src/launchConfig.ts`（扩展）                 |
| LaunchCommand        | claude CLI 参数（含 resume/session-id）      | `server/src/providers/hook/claude/claude.ts`（扩展） |
| LaunchAgentFlow      | New Agent 交互（只显示 configured profiles） | `adapters/vscode/launchAgentFlow.ts`（扩展）         |
| ManageProvidersFlow  | Add/Edit/Delete（含 secret replace/delete）  | `adapters/vscode/manageProvidersFlow.ts`（扩展）     |
| AgentControl         | Restart（resume）/ Switch Provider           | `adapters/vscode/agentControl.ts`（扩展）            |
| CLI                  | providers/launch                             | `server/src/cli.ts`（扩展）                          |
| Session Registry     | AgentState 扩展字段                          | `server/src/types.ts` / `agentStateStore.ts`         |

---

## 失败模式（Failure Modes）

| 场景                          | 行为                                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| New Agent 时无任何 Profile    | 显示 `No Provider Profiles configured. [Add Provider]`，不进空 QuickPick |
| Profile 被删后 Restart/Switch | resolver 明确报错 `profile not found`，不静默 fallback                   |
| Secret 缺失（非 inherit）     | MissingSecretError，fail-closed（002 语义不变）                          |
| resume 失败                   | 显式提示 + 用户确认后才 fork/new session（FR-012）                       |
| 多 Profile 同 Provider        | 各自独立 env object，互不影响                                            |
| CLI 无 TTY / 无 workspace     | 明确报错并提示用法                                                       |

---

## 取舍（Trade-offs）

- **per-terminal env（ADR-002）保留** vs 独立 CLAUDE_CONFIG_DIR：
  保留方案 A —— 保持 Claude Code 原生能力（hooks/skills/MCP/session
  history/discovery/resume/Agent Teams）不隔离。若用户级
  `settings.json` 的 `env.ANTHROPIC_*` 覆盖 terminal env（官方行为），
  文档明示这是 Claude Code 语义而非 bug。
- **native-login 不再默认** vs 保留 inherit：用户场景证明"默认 Inherit"
  是错误默认；native account 变成显式 profile（FR-005）。
- **Session 与 Provider 解耦**：Provider 是"当前 launch configuration"，
  不是 conversation owner；resume 同一 transcript 换 env 即可换 provider。
- **不解析 `~/.claude/.credentials.json`**：undocumented 内部文件，禁止耦合；
  用 `claude auth status` 探测登录态（官方 JSON），不稳定则仅显式 profile。
