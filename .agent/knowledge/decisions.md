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

<!-- 新 ADR 追加在下方。 -->
