# Decisions — Architecture Decision Records (ADR)

> Claude Fleet 的轻量 ADR。每一条记录**一个**有意义的架构选择、它被做出的上下文，
> 以及我们接受的代价。

**使用方式：**

- 改架构边界之前先搜这里。决策可能已经做过了。
- 当做出新的、显著塑造系统的架构选择时，按下面格式**追加**一条 ADR。
- ADR 是**只追加**的历史。如果某条决策被反转，**新写一条** ADR 说明它 superseded
  了哪一条 —— 不要直接改原条目的 Decision。

**条目格式：**

```markdown
## ADR-XXX: 决策标题

### Status

### Context

### Decision

### Reasons

### Consequences
```

**编号**：使用下一个连续的 `ADR-XXX`（零填充）。新增前先看现有条目。

---

## ADR-001: 以 Pixel Agents 作为 Claude Fleet 第一阶段 VS Code Runtime 与可视化基础

### Status

Accepted（2026-08-08，Spec 001 落地）

### Context

Claude Fleet 的目标是"在同一 VS Code 工作区里同时驱动多个 Coding Agent"。第一阶段
重点是多个 Claude Code 实例 + 实时状态 + 可视化（详见 [`docs/ROADMAP.md`](../../docs/ROADMAP.md)
Phase 2 / 4）。

如果从零实现一个 VS Code Extension + 多实例 Runtime + Hook 监听 + Webview + Pixel Canvas，
工程量大、与第一阶段"快速获得可运行基线"的目标不一致。

调研后确认上游 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)
（Version `1.4.0`，Commit `9794e075d3cf1a1407766a93d3cac87813393705`，MIT License，
Copyright (c) 2026 Pablo De Lucca）已经具备：

- VS Code Extension 完整宿主（`adapters/vscode/extension.ts`）
- 多 Claude Code Terminal + Instance 状态机（`adapters/vscode/agentManager.ts` 中的
  `launchNewTerminal`、`AgentStateStore`）
- Claude Code hooks / transcript 状态检测
  （`server/src/hookEventHandler.ts`、`server/src/providers/hook/claude/`）
- Provider 抽象（`core/src/provider.ts`、`server/src/providers/index.ts`）
- Webview Transport（`webview-ui/src/transport/`）
- Pixel-style Canvas UI（`webview-ui/src/`）
- 多 workspace 支持
- 单元测试 + E2E 框架

### Decision

**Claude Fleet 第一阶段直接基于 Pixel Agents 上游代码进行二次开发**，作为 VS Code
Runtime + 可视化基线，而不是从零重写。

具体落地步骤（详见 [`docs/specs/001-multi-instance-runtime/`](../../docs/specs/001-multi-instance-runtime/)）：

1. 把上游代码（commit `9794e075`）作为代码基线导入到 Claude Fleet 仓库根目录；
2. 保留上游 `LICENSE`（MIT）与原作者版权，**不**删除、不替换；
3. 新增 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 注明二次开发关系；
4. 在 `.agent/references/pixel-agents.md` 记录上游 SHA、License、复用模块清单；
5. 做**最小限度**的品牌替换（命令 ID、`displayName`、配置 key、log 前缀等用户面字符串）；
6. **不**重写 `AgentState` / `AgentStateStore` / `launchNewTerminal`，优先扩展上游已有能力；
7. **不**做 Provider / Model 隔离（属 Spec 002）；
8. **不**做跨 Coding Agent 适配（属 ROADMAP Phase 5）。

### Reasons

#### 优点

- **显著缩短 MVP 时间**：立刻拿到 multi-instance、hooks、transcript、Pixel UI、webview
  一整套已经能跑的能力；
- **避免在 Multi-instance / Hooks / Webview / Pixel UI 上重新发明轮子**；
- **复用上游 Provider 抽象**：未来加入 Codex / Gemini CLI 时，按上游
  `core/src/provider.ts` 增加 subdirectory 即可；
- **保留上游测试基础设施**：Claude Fleet 直接复用 vitest / playwright；
- **风险低**：上游是 MIT，Claude Fleet 在其上做任何修改都可以自由发布。

#### 代价（接受）

- **必须跟踪 upstream 演进**：上游更新时，Claude Fleet 需要决定是否同步、如何同步；
  同步成本随代码 diff 大小变化。
- **必须保留 MIT attribution**：原作者 `Copyright (c) 2026 Pablo De Lucca` 与 `LICENSE`
  文本**不可修改、不可删除**。
- **Persistence namespace 暂保留上游值**：本阶段不主动把 `pixel-agents.*` 这类
  globalState / 磁盘文件路径改为 `claude-fleet.*`，避免破坏已有用户状态；
  后续可以再单独 Spec 决定迁移路径。
- **后续需要逐步抽象 vendor-specific 部分**：本阶段**不**做此抽象，
  避免与 upstream 同步困难。
- **class 名称（`PixelAgentsViewProvider` 等）暂不改**：本阶段只换用户面字符串；
  后续如果产品定位完全独立，再做改名。

### Consequences

- Claude Fleet 的代码基线有清晰的"upstream baseline"边界：
  - 第一个 commit = `chore: import Pixel Agents baseline`（纯上游代码 + 必要合并）；
  - 第二个 commit = `feat: establish Claude Fleet multi-instance runtime`
    （品牌 + Spec + ADR + 文档）。
- 后续 002 / 003 / 004 / ... 都将基于"已 import 的 upstream"做扩展，而不是从头实现。
- 上游的 Hook / Provider 抽象为未来扩展 Codex / Gemini CLI / Antigravity 提供
  了现成的"插槽"。
- 当上游 release 新版本时，Claude Fleet 必须决定：
  - cherry-pick / merge 选定 commit；
  - 在 `pixel-agents.md` 更新 SHA 与版本；
  - 重新跑 `npm run check-types` / `npm run build` / `npm test`。

### Supersedes

_(none)_

### Superseded by

_(none)_

---

## ADR-002: Claude Code Instance Provider / Model Isolation Strategy

### Status

Accepted（2026-08-08，Spec 002 落地）

### Context

002 的目标是为每个 Claude Code Instance 提供**独立的 Provider / Model 配置**，并保证
并行 Instance 之间互不污染。

调研 Claude Code 官方文档后（[Settings](https://code.claude.com/docs/en/settings)、
[env-vars](https://code.claude.com/docs/en/env-vars)、[CLI usage](https://code.claude.com/docs/en/cli-usage)），
影响隔离的关键事实是：

1. `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`
   都是 **process-scope**，在 `claude` 启动时被读取一次。
2. `claude --model <id>` **覆盖** `ANTHROPIC_MODEL` env；`--session-id <uuid>` 是合法
   flag；`--dangerously-skip-permissions` 仍然可用（也可用 `--permission-mode bypassPermissions`）。
3. **`~/.claude/settings.json` 的 `env` block 会覆盖 shell env**（counter-intuitive 但
   是官方行为）。这意味着：用户如果在 `~/.claude/settings.json` 设了
   `env.ANTHROPIC_API_KEY`，会**覆盖** per-terminal 注入的 env。
4. `CLAUDE_CONFIG_DIR` env 改变 `~/.claude/` 的解析路径，影响 **settings / hooks /
   credentials / transcript / skills**。它不是"只换 settings 文件"，是"换整套 Claude
   数据根目录"。

候选方案：

- **方案 A**：仅 per-terminal env + `--model`；
- **方案 B**：per-terminal env + 独立 `CLAUDE_CONFIG_DIR`；
- **方案 C**：共享基础 config + instance overlay。

### Decision

**002 MVP 采用方案 A —— 仅 per-terminal env + `claude --model` / `--session-id`。**

具体落地（详见 [`docs/specs/002-provider-model-isolation/`](../../docs/specs/002-provider-model-isolation/)）：

1. 把 `ProviderProfile` / `ModelProfile` / `InstanceLaunchConfig` 设计成 Agent-neutral
   types（参见 [`core/src/providerProfiles.ts`](../../core/src/providerProfiles.ts)）。
2. 实现纯函数 [`resolveClaudeLaunchConfig`](../../server/src/launchConfig.ts)，把
   Profile + Secret 解析为 `{ env, args, safeMetadata }`。
3. `vscode.window.createTerminal({ env })` 接收 resolve 出来的 env，**每实例独立对象**。
4. `claude --model <id>` 由 `buildLaunchCommand` 透传。
5. Provider secrets 走 **VS Code SecretStorage**，**绝不**进入
   AgentState / globalState / log / Webview。
6. **不**为每个 Instance 创建独立 `CLAUDE_CONFIG_DIR`。

### Reasons

#### 方案 A 的优点

- **简单且可测**：`resolveClaudeLaunchConfig` 是纯函数，所有隔离行为可以离线单测。
- **与 001 完全兼容**：001 已建立的 `~/.claude/settings.json` hooks 安装 / transcript
  检测在方案 A 下继续工作（多个 Instance 共享同一份 hooks 是期望行为，因为 hooks
  上报的目标 Extension 是同一个）。
- **不需要做凭证 / login 隔离**：登录态由用户级 Claude Code 登录处理，per-instance
  不需要重新登录。
- **与上游未来演进更兼容**：Claude Code 后续如果增加 env 变量，方案 A 直接受益；
  方案 B 可能因为新变量走 `CLAUDE_CONFIG_DIR` 而漏掉。

#### 方案 B（CLAUDE_CONFIG_DIR）的代价

- 强制独立 config dir 会同时隔离 **hooks、credentials、transcript 路径、skills**；
- hooks 必须**每个 dir 装一份**（当前实现是写一份到 `~/.claude/settings.json`）；
- transcript detection 当前基于 `~/.claude/projects/<workspace>/<sessionId>.jsonl`，
  per-instance dir 会让 transcript 散落到不同位置，上游的 `getSessionDirs` 与
  `getAllSessionRoots` 都需要改；
- 当前**没有任何具体 case**证明方案 A 不够用；过早采用方案 B 是过度工程。

#### 方案 C 的代价

- 实现成本最高；
- 需要定义 "base config" vs "instance overlay" 的 merge 语义；
- 与 001 已有 globalState migration 路径纠缠。

### Consequences

#### 接受（已记录）

- 如果用户在 `~/.claude/settings.json` 的 `env` block 设了 `ANTHROPIC_*`，会**覆盖**
  per-terminal env。这是 Claude Code 官方语义（"settings file value applies"），
  不是 Claude Fleet 的 bug。002 在 `docs/specs/002-provider-model-isolation/design.md`
  显式记录此限制；后续用户文档需要告知。
- hooks / transcript 跨 Instance 共享是设计如此；hooks 写一次即可。

#### 未来如果遇到方案 A 不够用的情况

- 在用户级 settings.json env 与 per-terminal env 冲突的具体场景出现时，可以单独 Spec
  升级到方案 B；
- 但升级时必须同时处理：hooks 复制 / 重装、credentials 跨 dir 共享、
  transcript 路径重写。

#### 命名约束（被本 ADR 锁死）

- `ProviderProfile` 不写死厂商（不预设 MiniMax / DeepSeek / Kimi）；
- "Provider" 是 **Coding Agent 内部** 的概念，不同 Agent Runtime（Claude Code /
  Codex / Gemini）各自定义 Provider 能力（参见 requirements §"Provider 与 Coding Agent
  不要混淆"）。

### Supersedes

_(none)_

### Superseded by

_(none)_

---

## ADR-003: Claude Fleet 是管理层，不是 Claude Code 的 fork / runtime 替代品

### Status

Accepted（2026-08-08，Spec 005 落地）

### Context

真实手动测试暴露：用户没有 Anthropic 官方订阅 / Console API / Bedrock /
Vertex / Foundry，实际使用 DeepSeek / MiniMax 等 Anthropic-compatible API。
启动 Claude Code 后落入官方登录选择（"1. Claude account / 2. Anthropic
Console / 3. Bedrock / Foundry / Vertex"），产品流程错误。

### Decision

Claude Fleet 只负责：Provider / Account / API Profile 管理 + Model 选择 +
多 Claude Code Instance 管理 + Repo / Session 管理 + Pixel 可视化 / Auto
Discovery。进入 Claude Code 之后，所有原生能力（/help /resume /mcp / skills /
hooks / CLAUDE.md / subagents / Agent Teams / permissions / session history）
与用户直接运行 `claude` 一致。

禁止：重新实现 Claude Code、自建 Conversation Engine、复制聊天内容模拟
Resume、代理 Claude Code TUI、patch claude 安装文件、魔改登录选择页面。

### Reasons

- 用户的核心诉求是"进入 Claude Code 之前选好 Provider / Model / Session"，
  而不是一个新的聊天界面。
- 所有 Provider（Anthropic / DeepSeek / MiniMax / Bedrock…）运行的都是
  Claude Code runtime —— 会话连续性用 native resume，不复制对话。

### Consequences

- New Agent 流程：Repo → Configured Profile → Model → New/Resume → 原生 claude。
- Restart = native resume；Switch Provider = 新 env + native resume 同 session。
- 检测到 Provider 注入失败（仍落入官方 Login 选择）时视为 BLOCKER。

---

## ADR-004: ProviderDefinition ≠ ProviderProfile

### Status

Accepted（2026-08-08，Spec 005 落地）

### Context

ProviderProfile 早期模型较简单（kind/authMode/baseUrl），无法表达
"DeepSeek / MiniMax 是同一类协议的不同厂商预设"这一层。

### Decision

两层概念：

- **ProviderDefinition / Preset**（`core/src/providerRegistry.ts`）：类型模板
  （native-anthropic / anthropic-api / bedrock / vertex / foundry /
  anthropic-compatible），定义 id / displayName / authStrategy / 官方验证的
  defaultEndpoint / requiredEnv / model hints。不含 Secret。
- **ProviderProfile**（`core/src/providerProfiles.ts`）：用户配置实例
  （DeepSeek - Main），含 providerType / presetId / authStrategy / endpoint /
  secretRef / modelIds / enabled。

Runtime 核心唯一的 Provider 分支点是 `providerType`（resolver 内一层）。
新增 Provider（智谱、公司 Gateway）只加 definition + profile，零核心改动。
**禁止 `if (presetId === 'deepseek')` 散落。**

### Consequences

- DeepSeek = `providerType: anthropic-compatible` + `presetId: deepseek`。
- 官方文档无法验证的 preset 标记 `verified: false`，不编造 endpoint/model。

---

## ADR-005: Session ≠ Provider

### Status

Accepted（2026-08-08，Spec 005 落地）

### Context

早期模型把 Session 视为 launch 时的副作用；Restart 总是 fresh session。
用户希望 Restart / Switch Provider 后对话保留。

### Decision

Session 是 Claude Code 原生 Session（transcript / JSONL）。Fleet 只保存
sessionId / cwd / providerProfileId / modelId / managedByFleet。
Provider 是"当前 launch configuration"，不是 conversation owner。
会话连续性 = Claude Code native resume（`claude --resume <sessionId>`，
2.1.220 实测支持）。切换 Provider = 同一 cwd + sessionId + 新 env + resume。
Resume 被拒绝时显式提示，不静默新建会话。

### Consequences

- Restart = resume 同 session；New Session 才是 fresh conversation。
- AgentState / PersistedAgent 扩展 managedByFleet / lastProviderProfileId。
- 同一 Profile 可服务多个 Agent（独立 env object）；同一 Provider 可多个 Profile。

---

## ADR-006: Provider 切换使用 Claude Code 原生 Resume

### Status

Accepted（2026-08-08，Spec 005 落地）

### Context

跨 Provider（MiniMax → DeepSeek）保持对话的候选方案：复制聊天内容拼
Prompt（错误架构，禁止）；Fleet 自建会话 DB（重新实现 Claude Code，禁止）；
native resume（正确）。

### Decision

Switch Provider / Restart 一律走 Claude Code 原生 `--resume <sessionId>`。
Fleet 只改变 launch env（Provider 凭据 / Base URL / Model）。自动测试只验证
launch semantics（参数 / env / 顺序）；真实 API 行为由用户手动验证。

### Consequences

- 若 Claude Code 拒绝跨 Provider resume：显式提示
  "could not be resumed… Start a new session instead?"，用户确认后才新建。
- 不读取 `~/.claude/.credentials.json`（undocumented）；用 `claude auth
status`（官方 JSON）探测 native 登录态，不可用时仅显式 Profile。

---

## ADR-007: Auto Discovery 一等公民

### Status

Accepted（2026-08-08，Spec 006 落地）

### Context

Pixel Agents 上游的 Global Session Scanner / Watch All Sessions / External
Adoption / JSONL discovery 是核心资产，不能因为 Fleet 自己 launch Agent 而消失。

### Decision

统一 Discovery 语义：Fleet managed + 用户外部手动 `claude` + CLI launched
全部被发现。按 sessionId upsert（Restart / Switch 后不重复）。Fleet launch
时持久化 sessionId → provider 映射（managedByFleet）；外部 agent 不猜
Provider，显示 External / Unknown。

### Consequences

- `upsertAgentBySessionId` 接入 adopt 路径；knownJsonlFiles / pathsMatch /
  dismissalTracker 既有机制保留。

---

## ADR-008: ~/.pixel-agents → ~/.claude-fleet 状态迁移

### Status

Accepted（2026-08-08，Spec 006 落地）

### Context

Claude Fleet 自己创建的状态（config / hooks / layout / state）仍写在
`~/.pixel-agents/`（上游 namespace）。产品品牌已迁移，状态路径也应迁移。

### Decision

新状态根 `~/.claude-fleet/`；`server/src/migrateStateDir.ts` 一次性迁移：
幂等（new 存在即 no-op）、失败安全（copy 失败保留 old、可重试）、成功后写
migration.json 标记、**永不删除旧目录**（Alpha 期间保留）。Hook 安装器识别
legacy pixel-agents entry 并替换为 claude-fleet 路径，保留用户其他 hooks。

### Consequences

- `migrateStateDir()` 在 extension activate / CLI 启动时调用。
- 剩余 `.pixel-agents` 命中仅限：attribution / 迁移代码 / legacy 兼容 /
  globalState 旧 key 读取。

---

## ADR-009: Runtime / Resource / Observability / SCM / Strategy 分离

### Status

Accepted（2026-08-09，目标架构）

### Context

Fleet 将从 Claude Code 扩展到 Codex CLI，并预留 Gemini CLI、OpenCode、Qoder CLI 与自定义 Runtime。与此同时，Claude Code 可以使用 DeepSeek、MiniMax 等不同资源账户；PR 信息又来自 Git/SCM，而不是 Runtime 本身。

如果所有逻辑都放进一个 Agent Adapter，新增 Runtime 或 Provider 时会同时污染生命周期、计费、PR、策略和前端。

### Decision

长期扩展点拆分为：

```text
RuntimeAdapter       → CLI lifecycle / session / runtime events
ResourceAdapter      → token / cost / quota / subscription
ObservabilityAdapter → external measurement / telemetry source
SCMAdapter           → GitHub / GitLab / local Git
StrategyAdapter      → assignment / recommendation policy
```

核心 Domain 只依赖统一模型，不允许 vendor-specific `if runtime/provider === ...` 散落。

### Consequences

- `Claude Code + MiniMax` 与 `Claude Code + DeepSeek` 可共享同一个 RuntimeAdapter，但使用不同 ResourceAccount / ResourceAdapter。
- PR/CI/Review 信息进入 SCM Adapter，不塞进 Claude/Codex runtime parser。
- 新增 Runtime 不应该要求重写 Mission、Ledger、Metrics、Strategy 和前端。

---

## ADR-010: Telemetry ≠ Ledger；Token ≠ Cost ≠ Quota

### Status

Accepted（2026-08-09，目标架构）

### Context

Fleet 不只需要实时显示 Agent 状态，还要长期评估 Session、Task、PR 的时间、Token、费用、额度和质量。不同资源模式包括按量 API、Token Plan、Credit、Plus/Pro/Subscription，不能统一为一个虚假的“剩余百分比”。

### Decision

建立两套数据边界：

```text
FleetTelemetryStore → bounded realtime state
Fleet Ledger         → durable work metadata
```

并把资源维度明确拆成：

```text
Token Usage
Estimated / Actual Cost
Quota / Plan / Subscription Snapshot
```

所有数据必须带来源；可靠来源缺失时使用 `unknown/unavailable`，不猜。

### Consequences

- DeepSeek 等按量 API 可以有 estimated/actual cost；
- MiniMax 等 Token Plan 可以有 quota snapshot；
- Plus/Pro/Subscription 只有官方/Runtime 可靠暴露时才显示剩余额度；
- Ledger 默认不保存完整 Prompt / Transcript / Secret，只记录 Mission/Task/Session/PR/Usage/Quality/Decision 元信息。

---

## ADR-011: Coordinator 的自动 Launch / Assign 必须经过 Fleet Policy

### Status

Accepted（2026-08-09，目标架构）

### Context

目标工作流允许用户给出 Task List、依赖、能力要求、预算和规则，然后由 Coordinator 根据 Agent 能力、历史质量、时间成本、Token/API 成本、当前负载和剩余额度决定是否使用现有 Agent 或新开 Agent。

如果 Coordinator 可以绕开 Fleet 直接无限 spawn，会造成费用失控、资源耗尽、同 checkout 冲突和不可审计的任务分配。

### Decision

Coordinator 只能通过 Fleet Control API / MCP 请求控制动作，并受以下权限模式约束：

```text
observe
suggest
approve
autonomous
```

默认从 `suggest / approve` 开始。`autonomous` 必须有硬 Guardrails：

```text
max concurrent agents
max agents per mission
metered API budget
quota reserve
allowed runtime/provider/model
allowed repos
worktree isolation
review-before-merge
approval for destructive actions
```

每次 Assignment / Launch 决策写入 `AssignmentDecision`，保存 selected target、候选、理由、估算成本/耗时和执行模式。

### Consequences

- Recommendation 与 Execution 分离；
- Strategy 可以建议“再开一个 MiniMax-backed Claude Code Worker”，但是否直接执行取决于 Mission Policy；
- Unknown quota 不等于 unlimited；
- 所有自动调度可以回溯并评估推荐是否有效。

<!-- 新 ADR 追加在下方。 -->

## ADR-009: agentmetrics 合并进 Claude Fleet 单仓库

### Status

Accepted（2026-08-09，Spec 007）

### Context

Coordinator、Worker、Session、Worktree 和 Usage 如果分属两个仓库，容易出现两套
版本、两套 identity contract 和两套发布流程。metrics 的核心消费者就是 Fleet
Controller 工作流，但 Python collector 仍需要独立测试和 CLI 入口。

### Decision

将原 `agent-metrics-collector` 的产品源码合入 Claude Fleet 顶层 `agentmetrics/`；
保留 Python 包 `agent_metrics`、CLI `agent-metrics` 和内部目录结构。原 GitHub 仓库
作为迁移源保留，直到主仓库验证完成后再 archive。`agent-metrics-workspace` 中的
worktrees、smoke target、缓存和运行数据不进入产品仓库。

### Consequences

- 单仓库拥有 TypeScript Runtime、Python Usage Ledger 和共享 Spec。
- 不强制把 Python 重写成 TypeScript。
- 共享边界使用 JSON/identity contract，而不是跨语言 import。

## ADR-010: FleetEvent 是遥测与可视化的规范化边界

### Status

Accepted（2026-08-09，Spec 008/009）

### Context

Claude Hook、Claude JSONL、Codex JSONL 和 agentmetrics 的事件格式不同。让 UI 直接
理解这些格式会把 Provider 细节泄漏到前端，并阻碍后续加入新 Agent。

### Decision

所有输入先经过 Normalizer 生成 FleetEvent；Controller 负责幂等、排序、状态转移和
持久化；OfficeScene、FleetScene、Codex View 和 Scheduler 只消费 FleetProjection。

### Consequences

- 原有 Pixel Office 可以保留为一个 Projection。
- Fleet Command Scene 可以独立迭代，不改 Runtime。
- 原始日志不进入 UI；Usage 仍由 agentmetrics 以证据状态提供。

## ADR-011: Fleet-managed runtime creation goes through FleetRuntimeHost

### Status

Accepted (2026-08-09, target architecture; implementation deferred)

### Context

A Coordinator needs to start native Claude Code or Codex CLI instances without taking ownership
of process, terminal, workspace, and session lifecycle in an ad hoc way. Direct shell spawning
would make requestedBy, launchSource, terminal identity, policy checks, and duplicate prevention
difficult to audit.

### Decision

Fleet-managed runtime creation will go through FleetRuntimeHost. The host resolves FleetHost,
WorkspaceHost, repository/worktree, terminal, RuntimeAdapter, ProviderProfile, Model, resource
constraints, and policy before handing execution to the native CLI. The VS Code Integrated
Terminal remains the preferred human-visible execution surface.

RuntimeAdapter owns native CLI semantics. FleetRuntimeHost owns management-plane launch,
ownership, terminal/session identity, and lifecycle handoff.

### Consequences

- External and future managed Coordinators use the same control boundary.
- Native runtimes remain the source of conversation and tool behavior.
- A direct arbitrary shell command is not a managed lifecycle record.
- FleetRuntimeHost is a target abstraction; it is not implemented by this documentation change.

## ADR-012: Instance Detail and Terminal Focus are separate UX actions

### Status

Accepted (2026-08-09, target architecture; implementation deferred)

### Context

A management webview can show metadata and telemetry, but the native Coding Agent still runs
in a real VS Code terminal. Treating a webview detail panel as a terminal replacement would
hide the actual runtime and make Focus behavior ambiguous.

### Decision

Selecting an instance opens Instance Detail. Focus Terminal is a separate action that routes to
the real VS Code Integrated Terminal identified by terminal identity. Instance Detail may show
status, provider, model, session, host, workspace, worktree, recent events, and safe resource
evidence, but it is not a fake Coding Agent chat panel.

### Consequences

- Scene renderers can share selection and commands without owning runtime conversations.
- Terminal focus remains testable and provider-neutral.
- Fleet Command and Pixel Office can change scenes without restarting a Session.
- Instance Detail and Terminal Dock remain deferred UI work.

## ADR-013: Mission resolves the runtime host

### Status

Accepted (2026-08-09, target architecture; implementation deferred)

### Context

A Mission may contain WorkItems assigned to different repositories, worktrees, VS Code
workspaces, terminals, hosts, runtimes, and roles. Resolving only a runtime executable is not
enough to establish safe ownership.

### Decision

Managed execution resolves through the chain:

Mission -> WorkItem -> FleetHost -> WorkspaceHost -> repository/worktree -> terminal ->
RuntimeAdapter -> native runtime session.

Mission and WorkItem identity are recorded with hostId, workspaceId, worktree, terminalId,
sessionId, launchSource, and requestedBy whenever those values are available. A Mission can
contain multiple hosts; that does not permit concurrent writes to the same checkout without an
explicit policy decision.

### Consequences

- Host and workspace resolution are part of assignment correctness, not UI decoration.
- Assignment and launch records can explain where and why an instance was created.
- Cross-host scheduling can be added without changing RuntimeAdapter semantics.
- Mission orchestration and FleetRuntimeHost are documented targets, not current implementation.

## ADR-014: Agent Fleet is the canonical brand

### Status

Accepted (2026-08-09)

### Context

The product has grown from a Claude-specific VS Code extension into a runtime-neutral
management plane whose v1 managed runtime set includes Claude Code CLI and Codex CLI. Continuing
to describe new architecture as Claude Fleet would encode the current implementation as the
permanent product boundary.

### Decision

Agent Fleet is the canonical brand for new architecture, documentation, UI terminology, specs,
and future APIs. Existing Claude Fleet package/repository names, command IDs, configuration keys,
state paths, class names, and migration references remain compatibility or historical surfaces
until a separately approved migration is executed.

No second brand migration phase is planned. This round does not rename package metadata,
commands, persisted state, GitHub repositories, or source symbols.

### Consequences

- New documents must use Agent Fleet.
- Historical Claude Fleet references may remain when they describe existing compatibility.
- Runtime neutrality is expressed by RuntimeAdapter and FleetInstance, not by renaming native
  Claude Code concepts.
