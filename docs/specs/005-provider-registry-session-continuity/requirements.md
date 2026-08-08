# 005-provider-registry-session-continuity — Requirements

> Feature slug：`005-provider-registry-session-continuity`  
> 依赖：001（multi-instance runtime）、002（provider-model-isolation）、004（control UI）  
> 阻塞：006（branding & discovery migration，共享发现/迁移基础）

---

## 目标（Goal）

把 Claude Fleet 从"能多开 Claude Code 并配 Provider/Model"升级为**真正的
Provider/Profile Launcher**：用户在进入 Claude Code 之前完成
Repo → Provider Profile → Model → Session 的选择，然后 Fleet 启动**原生
`claude` CLI**，并保证 Restart / Switch Provider 走 Claude Code **原生
Resume**，对话不丢失、不复制。

**Claude Fleet 不是 Claude Code 的替代品。** 它不实现 Conversation Engine，
不模拟 Resume，不代理 TUI；进入 Claude Code 之后的所有原生能力
（/help /resume /clear /mcp / skills / hooks / CLAUDE.md / subagents /
Agent Teams / permissions / session history）与用户直接运行 `claude` 一致。

---

## 背景（Context）

真实手动测试暴露：用户没有 Anthropic 官方订阅 / Console API / Bedrock /
Vertex / Foundry，实际使用 MiniMax / DeepSeek 等 Anthropic-compatible API。
但当前 New Agent 流程默认提供 `Inherit / Anthropic` profile，启动后落入
Claude Code 的官方登录选择（"1. Claude account / 2. Anthropic Console / 3. Bedrock / Foundry / Vertex"），产品流程错误。

本轮架构纠正：Provider Definition 与 Provider Profile 分层，New Agent 只显示
**已经配置好**的 Profile；native Anthropic account 成为显式配置，不再默认存在；
Session 与 Provider 解耦，Provider 切换 = 新的 launch env + Claude Code 原生 resume。

---

## 用户故事（User Stories）

- **US-1 没有官方账号的用户** —— 我只有 DeepSeek / MiniMax API Key。我添加
  Provider Profile 后，New Agent 只显示我配置的 Profile，启动后直接进入
  Claude Code，不再被要求选择 Claude 官方登录方式。
- **US-2 Restart 保留对话** —— 我 Restart 一个 Agent，希望进程重启后
  **同一个对话**还在（Claude Code 原生 resume），而不是空 Session。
- **US-3 Switch Provider** —— 我把 Agent 从 MiniMax 切到 DeepSeek，希望
  Repo / Session / 对话内容都保留，只有后续回答由新 Provider / Model 生成。
- **US-4 新 Session** —— 我明确要一个全新对话（同 Repo / 同 Provider），
  得到空 Session。
- **US-5 配置管理** —— 我能在 Manage Providers 里 Add / Edit / Delete
  Profile（DeepSeek - Personal、DeepSeek - Work、MiniMax - Main），
  每个 Profile 独立 Secret / Model / Endpoint。
- **US-6 Resume 失败不静默丢对话** —— 切 Provider 后若 Claude Code 拒绝
  resume，必须明确提示我，由我决定是否新建 Session。

---

## 功能性需求（Functional Requirements）

### FR-001 ProviderDefinition ≠ ProviderProfile

两层概念，禁止混用：

- **ProviderDefinition / Preset**：产品支持的 Provider 类型模板
  （`native-anthropic` / `anthropic-api` / `bedrock` / `vertex` / `foundry` /
  `anthropic-compatible`）。定义 `id / displayName / runtime / protocol /
authStrategy / endpoint(如有官方稳定值) / requiredConfiguration /
supportedModelHints(仅官方验证后)`。不含任何用户 Secret。
- **ProviderProfile**：用户配置的实例（`DeepSeek - Personal` 等），含
  `providerType / presetId / authStrategy / endpoint / secretRef / modelIds /
enabled`。

### FR-002 数据模型可扩展，禁止散落 if/else

Provider 分支必须收敛到统一 abstraction。新增 Provider（智谱、公司 Gateway 等）
不得修改 Runtime 核心。第三方服务表示为
`providerType = anthropic-compatible` + `presetId = deepseek | minimax | custom`。

### FR-003 New Agent 只显示 Configured + Enabled Profiles

- Provider Picker **只**展示用户已配置且 `enabled` 的 Profile；
- 不再默认注入 `Inherit / Anthropic`；
- 若没有任何 Profile，不显示空 QuickPick，而是提示
  `No Provider Profiles configured. [Add Provider]`。

### FR-004 Manage Providers：Configured vs Available 分开

Manage Providers 展示已配置列表（Display Name / Type / Endpoint(safe) /
Auth Strategy / Default Model / Status，**永不显示 Secret**），
`Add Provider` 才展开全部可配置类型（Official/Native + Anthropic-compatible +
Custom）。

### FR-005 Native Anthropic Account 不再默认存在

`claude-fleet.inherit` 内置 Inherit Profile 取消默认注入。Native Claude
Account = 用户显式添加的 Profile（`authStrategy = native-login`），添加后才
出现在 New Agent。

- 判断 native 登录状态**不得**解析 `~/.claude/.credentials.json`；
  优先使用 `claude auth status`（官方 CLI，JSON 输出），不稳定则放弃探测，
  交给显式 Profile。

### FR-006 Cloud Provider（Bedrock / Vertex / Foundry）

支持以 Profile 形式配置，Secret 由外部 credential chain 管理
（Fleet 不复制 AWS/GCP/Azure 凭据）；Fleet 负责设置 Claude Code 官方要求的
native provider configuration。以 Claude Code 官方能力为准。

### FR-007 Anthropic-compatible Provider（DeepSeek / MiniMax / Custom）

Adapter 负责生成 `env / args / safeMetadata`；Secret 从 VS Code
SecretStorage 读取。坚持 002 的 No Secret 纪律：
no global settings mutation / no secret in AgentState / logs / Webview / Git。

DeepSeek / MiniMax preset 的 endpoint / env / model 只来自官方
Claude Code integration 文档（见设计文档），不凭记忆、不抄博客；
无法可靠验证的 preset 标记 `unverified`，只提供 Custom 手动配置。

### FR-008 唯一 Resolver 真相

New Agent / CLI launch / Restart / Switch Provider 全部走同一个
`Provider Registry + Launch Config Resolver`。禁止四套不同逻辑。

### FR-009 Restart = 原生 Resume

`Restart Agent` 默认语义升级为：
保存 `sessionId / cwd / providerProfileId / modelId` → Stop 进程 →
使用 Claude Code 官方 resume 参数（按 `claude --help` 实际行为）恢复
**同一 Session**。

### FR-010 New Session 与 Restart 分离

- `Restart` = restart process + resume same conversation；
- `New Session` = same repo/provider/model + 新 sessionId + 空对话。
  New Agent 流程中 Session 步骤提供 `New Session | Resume Existing Session`。

### FR-011 Switch Provider

`Claude Fleet: Switch Provider`（Debug View Agent 卡片入口 + 命令）：
选 Profile → 选 Model → Stop 当前进程 → **同一 cwd + sessionId + transcript**，
新 Provider env → Claude Code native resume。禁止复制聊天内容拼 Prompt。

### FR-012 Resume 失败必须显式提示

跨 Provider resume 若被 Claude Code 拒绝，禁止静默新建 Session；提示
`This Claude Code session could not be resumed with the selected Provider. Start a new session instead?`，
用户确认后才 new session。

### FR-013 Session 元数据

AgentState / PersistedAgent 至少稳定表示：
`cwd / sessionId / providerProfileId / providerDisplayName / modelId / managedByFleet`；
必要时 `lastProviderProfileId`。不过度设计。

### FR-014 CLI 支持

`claude-fleet providers`（list configured profiles）与
`claude-fleet launch`（Repo → Provider Profile → Model → New/Resume → launch
原生 claude），复用同一 Provider Registry / Resolver；不创建第二个 runtime。

### FR-015 隔离与共享

- 同一 Profile 可同时服务多个 Agent（独立 Session、独立 env object，
  SecretStorage 只存一份）；
- 同一 Provider 可存在多个 Profile；
- Switch A 不得影响 B 的 env / terminal / session / provider。

---

## 非功能性需求（Non-Functional Requirements）

- **NFR-1** 不修改 Claude Code 本体（不 patch claude.exe / npm 包 / TUI）。
- **NFR-2** 不全局修改 `~/.claude/settings.json` 来切 Provider
  （per-process / per-terminal env；settings.json 只允许 Fleet hook 的最小可回滚 merge）。
- **NFR-3** 不强制 `CLAUDE_CONFIG_DIR` 隔离（沿用 ADR-002 方案 A），
  保持 Claude Code native settings / MCP / skills / hooks / session history /
  auto discovery / resume / Agent Teams 原生。
- **NFR-4** 自动测试不访问真实付费 API：fake profile / fake secret / fake launcher。
- **NFR-5** Secret 纪律与 002 相同（见 FR-007）。

---

## 不在范围内（Out of Scope）

- 重新实现 Claude Code / 自建 Conversation Engine / 代理 TUI。
- 魔改 Claude 登录选择页面。
- 读取 / 修改 `~/.claude/.credentials.json` 或 `hasCompletedOnboarding`。
- Codex / Gemini / Antigravity runtime。
- Marketplace / GitHub Release。
- Provider 切换写全局 settings.json（CC-Switch 式）。

---

## 开放问题（Open Questions）

- `claude --resume <session-id>` 在第三方 provider（ANTHROPIC_BASE_URL 指向
  MiniMax/DeepSeek）下是否真正恢复对话 —— Claude Code 将 transcript 存于本地
  JSONL，resume 是本地重放，理论上与 provider 无关；但需要真实验证
  （用户手动 GUI/API 验证，自动测试只验证 launch semantics）。
- 跨 Provider resume 时 Claude Code 是否会因为 session 的 model 历史与新
  model 冲突而拒绝 —— 失败路径见 FR-012，必须显式提示。
