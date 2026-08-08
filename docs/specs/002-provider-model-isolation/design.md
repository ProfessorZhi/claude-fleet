# 002-provider-model-isolation — Design

> Feature slug：`002-provider-model-isolation`  
> 关联：[`requirements.md`](./requirements.md)  
> ADR：参见 [`.agent/knowledge/decisions.md`](../../../.agent/knowledge/decisions.md) ADR-002

---

## Context

在 001 中 Claude Fleet 已经可以同时跑多个 Claude Code 实例（每个独立 `cwd` / `sessionId` /
Terminal）。本 Feature 要叠加**每实例独立的 Provider / Model 配置**，并保证：

- 两个实例可以分别走 Anthropic 官方与自建 Gateway；
- 一个实例的配置变化**不得**影响另一个实例；
- Secret 安全不外泄。

Claude Code 的相关官方机制（基于 [Claude Code Docs](https://code.claude.com/docs/en/)）：

| 机制                                  | 行为                                               | 是否适合"per-instance 隔离"     |
| ------------------------------------- | -------------------------------------------------- | ------------------------------- |
| `ANTHROPIC_BASE_URL` env              | 覆盖 API endpoint；process-scope，启动时读取       | ✅ 适合                         |
| `ANTHROPIC_API_KEY` env               | 设为 `X-Api-Key` header；**覆盖**用户登录          | ✅ 适合（Custom Provider）      |
| `ANTHROPIC_AUTH_TOKEN` env            | Bearer token                                       | ✅ 适合（OAuth-style Provider） |
| `ANTHROPIC_MODEL` env                 | 默认 Model                                         | ⚠️ 可被 `--model` 覆盖          |
| `claude --model <id>` flag            | 覆盖 `ANTHROPIC_MODEL`；session-scope              | ✅ 适合                         |
| `claude --session-id <uuid>`          | 强制 session id                                    | ✅ 已在用                       |
| `CLAUDE_CONFIG_DIR` env               | 覆盖 `~/.claude/`；影响 settings/hooks/credentials | ⚠️ 见 ADR-002                   |
| `~/.claude/settings.json` `env` block | **覆盖** shell env（counter-intuitive）            | ❌ 反而是**障碍**               |

> **关键问题**：用户如果已经在 `~/.claude/settings.json` 设置了 `env.ANTHROPIC_API_KEY`，
> 该值会**覆盖**我们 per-terminal 注入的 env。这正是为什么 002 必须显式决策
> `CLAUDE_CONFIG_DIR` —— 见 ADR-002。

---

## ADR-002 摘要

完整 ADR 见 [`.agent/knowledge/decisions.md`](../../../.agent/knowledge/decisions.md)。

**Decision（002 MVP）**：

> 采用**方案 A：仅使用 per-terminal env + `--model`**。MVP **不**为每个 Instance 强制
> 独立的 `CLAUDE_CONFIG_DIR`。

**理由**：

- Provider endpoint / auth / model 三件事已经可以通过 process-scope env + CLI flag
  完全隔离；
- 强制 `CLAUDE_CONFIG_DIR` 会同时隔离登录、hooks、credentials、transcript 检测，反而
  增加 MVP 复杂度与回归风险；
- 001 已建立的 hooks 安装机制（在用户级 `~/.claude/settings.json`）继续工作；多个
  实例共享同一份 hooks 是**期望行为**（同一 Extension 的多个 Instance）；
- 如果未来遇到"用户在 `~/.claude/settings.json` 设了 `env.ANTHROPIC_API_KEY` 覆盖了
  per-terminal env"的具体 case，再单独 Spec 升级到方案 B。

**已知限制（写入 design）**：

- 如果用户在 `~/.claude/settings.json` 的 `env` block 设了 `ANTHROPIC_*`，可能覆盖
  per-terminal env。这是 Claude Code 官方语义（"settings file value applies"），不是
  Claude Fleet 的 bug。
- 文档明确告知用户：本 Feature 不修改 `~/.claude/settings.json`；如果用户需要在 Claude
  Code 全局关闭某个 env，需要自行清理该文件。

---

## 高层形态

```text
┌──────────────────────── Claude Fleet Extension (VS Code Host) ─────────────────────────┐
│                                                                                        │
│   + Agent                                                                              │
│     ↓                                                                                  │
│   ┌────────────────────────────────────────────────────────────────┐                  │
│   │  Launch Flow (NEW in 002)                                     │                  │
│   │  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────┐ │                  │
│   │  │ 1. Pick Repo    │→│ 2. Pick Provider │→│ 3. Pick Model │ │                  │
│   │  └─────────────────┘  └──────────────────┘  └───────────────┘ │                  │
│   └────────────────────────────────────────────────────────────────┘                  │
│     ↓                                                                                  │
│   InstanceLaunchConfig { cwd, providerProfileId, modelId }                            │
│     ↓                                                                                  │
│   resolveClaudeLaunchConfig(...)    ← 纯函数，可单测                                  │
│     ↓                                                                                  │
│   { env, args, safeMetadata }                                                          │
│     ↓                                                                                  │
│   launchNewTerminal(... InstanceLaunchConfig ...)                                      │
│     ↓                                                                                  │
│   vscode.window.createTerminal({ name, cwd, env })   ← 关键：env 现在每实例独立      │
│     ↓                                                                                  │
│   terminal.sendText([claude, --model ..., --session-id ...].join(' '))                │
│                                                                                        │
│   Provider Profiles ↔ VS Code globalState（non-secret）                                │
│   Provider Secrets  ↔ VS Code SecretStorage                                             │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 模块职责

> 能扩展上游已有模块就**不**新建第二套。

| 模块                                | 职责                                                                        | 来源                                             |
| ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| `ProviderProfile` (type)            | Provider 配置的 non-secret 字段                                             | **本 Feature 新增**（在 `core/src/`）            |
| `ModelProfile` (type)               | Model ID + display name                                                     | **本 Feature 新增**                              |
| `InstanceLaunchConfig` (type)       | `cwd` + `providerProfileId` + `modelId`                                     | **本 Feature 新增**                              |
| `resolveClaudeLaunchConfig(...)`    | 纯函数：解析 Profile + Secret → `env, args, safeMetadata`                   | **本 Feature 新增**                              |
| `ProviderProfileStore`              | 在 VS Code globalState 上读写 Provider Profiles                             | **本 Feature 新增**（用现有 `globalState` 即可） |
| `SecretStorageProvider`             | 封装 `vscode.SecretStorage` 的读写 + `secretRef` 引用                       | **本 Feature 新增**                              |
| `LaunchAgentFlow`                   | `+ Agent` 命令的 QuickPick / InputBox 流程                                  | **本 Feature 新增**                              |
| `claudeProvider.buildLaunchCommand` | 扩展入参：接受 `modelId` + `env`，返回带 `--model` 的 args                  | **扩展**                                         |
| `launchNewTerminal`                 | 扩展入参：接受 `InstanceLaunchConfig`，把 env 传给 `createTerminal`         | **扩展**                                         |
| `AgentState`                        | 增加 `providerProfileId` / `modelId` / `providerDisplayName`（不含 secret） | **扩展**                                         |
| `PersistedAgent`                    | 同上                                                                        | **扩展**                                         |

> ❌ 不新建 `FleetInstanceManagerV2` / `FleetAgentState` / 第二个 Runtime。

---

## 数据 / 状态形态

### `ProviderProfile`（Agent-neutral，仅描述"如何调用 LLM endpoint"）

```ts
export type AuthMode = 'inherit' | 'apiKey' | 'authToken';

export interface ProviderProfile {
  id: string; // stable id (e.g. uuid)
  name: string; // user-visible display name
  kind: 'anthropic-compatible';
  baseUrl?: string; // optional; absent = inherit Anthropic default
  authMode: AuthMode; // 'inherit' | 'apiKey' | 'authToken'
  secretRef?: string; // ref into SecretStorage; ONLY when authMode != 'inherit'
  customHeaders?: Record<string, string>; // optional, e.g. for gateway extra headers
  /** Default Model if a new Instance picks this Profile and the user doesn't override. */
  defaultModelId?: string;
}
```

**Important invariants**：

- `secretRef` 不含 plaintext secret；
- `customHeaders` 不应包含 `authorization` / `x-api-key`（这些由 auth mode 处理）；后续
  schema validate 时强制。

### `ModelProfile`

```ts
export interface ModelProfile {
  id: string; // arbitrary string, passed verbatim to `claude --model`
  displayName?: string; // optional, for UI
}
```

> MVP 不需要 Model registry / enum。`--model` 接受任何合法字符串。

### `InstanceLaunchConfig`

```ts
export interface InstanceLaunchConfig {
  cwd: string;
  providerProfileId: string;
  modelId?: string;
  /** Pre-resolved env override (advanced; default = use Profile + resolve) */
  envOverride?: Record<string, string>;
}
```

### `ResolvedLaunchConfig`（resolveClaudeLaunchConfig 的返回）

```ts
export interface ResolvedLaunchConfig {
  /** Per-instance env passed to vscode.window.createTerminal */
  env: Record<string, string>;
  /** Args appended to `claude` invocation */
  args: string[];
  /** Safe, persistable metadata for AgentState / Webview DTO */
  safeMetadata: {
    providerProfileId: string;
    providerDisplayName: string;
    modelId?: string;
  };
}
```

> `env` **不**写入 AgentState / PersistedAgent / Webview。只在 `createTerminal` 时使用。

---

## 接口

### `resolveClaudeLaunchConfig(...)`

```ts
function resolveClaudeLaunchConfig(
  profile: ProviderProfile,
  modelId: string | undefined,
  cwd: string,
  sessionId: string,
  secretLookup: (ref: string) => string | undefined,
): ResolvedLaunchConfig;
```

这是 **纯函数**（除 secretLookup 是注入依赖），所有隔离测试打在这里。

### `ProviderProfileStore`

```ts
interface ProviderProfileStore {
  list(): ProviderProfile[];
  get(id: string): ProviderProfile | undefined;
  upsert(p: ProviderProfile): Promise<void>;
  remove(id: string): Promise<void>;
}
```

实现：包 `context.globalState`。

### `SecretStorageProvider`

```ts
interface SecretStorageProvider {
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | undefined>;
  delete(ref: string): Promise<void>;
}
```

实现：直接走 `vscode.SecretStorage`。

### 扩展的 `claudeProvider.buildLaunchCommand`

```ts
function buildLaunchCommand(
  sessionId: string,
  cwd: string,
  opts?: {
    bypassPermissions?: boolean;
    modelId?: string;
    env?: Record<string, string>;
  },
): { command: string; args: string[]; env?: Record<string, string> };
```

- `args` 包含 `--session-id <id>` + 可选 `--model <id>` + 可选 `--dangerously-skip-permissions`；
- `env` 直接透传（每实例独立）。

### 扩展的 `launchNewTerminal`

```ts
async function launchNewTerminal(
  ...existingArgs,
  launchConfig: InstanceLaunchConfig,
  bypassPermissions?: boolean,
  suppressShow?: boolean,
): Promise<void>;
```

> 注意入参顺序：原函数末尾的两个可选参数保持位置，新增 `launchConfig` 作为
> 第一个"非共享"参数以避免 positional args 爆炸。

---

## 失败模式

| 场景                                                      | 应对                                       |
| --------------------------------------------------------- | ------------------------------------------ |
| Provider Profile 不存在                                   | 报错给 UI，阻止 launch；不 crash           |
| `authMode != 'inherit'` 但 `secretRef` 缺失               | UI 提示"请先在 Provider 配置中填入 Secret" |
| `authMode != 'inherit'` 但 SecretStorage 返回 `undefined` | 同上 + log（不含 secret）                  |
| `baseUrl` 非合法 URL                                      | schema 校验失败，阻止保存                  |
| Model 为空 + Inherit Profile                              | 允许（继承用户全局 Model）                 |
| Model 为空 + Custom Provider                              | 阻止保存 / 阻止 launch                     |
| `vscode.window.createTerminal` 失败                       | error log；UI 提示                         |
| Claude CLI 不存在 / 启动失败                              | terminal 输出走 VS Code 现有错误流         |

---

## 取舍

### 选：方案 A —— 仅 per-terminal env + `--model`

**优点**：简单、可单测、与 001 已有的 hooks / transcript 检测机制兼容。

**代价**：

- 用户在 `~/.claude/settings.json` 设了 `env.ANTHROPIC_*` 会覆盖 per-terminal env（官方
  行为；ADR-002 已记录）。
- 不解决"用户希望 Custom Provider 不影响其他 Claude Code 进程"的全场景（因为非 VS Code
  终端里的 `claude` 也读 `~/.claude/settings.json`，与本 Feature 无关）。

### 弃：方案 B —— per-instance `CLAUDE_CONFIG_DIR`

**为何不**：

- 强制独立 config dir 会同时隔离：登录、hooks、credentials、transcript、skills；
- hooks 安装必须重做（每个 dir 一份）—— 增加维护成本；
- transcript detection 也得改 —— 当前上游通过 `~/.claude/projects/<dir>/` 找 jsonl，
  per-instance CLAUDE_CONFIG_DIR 会让 Instance 的 transcript 散落到不同位置；
- 当前没有任何证据表明方案 A 不够用。

### 弃：方案 C —— 共享基础 config + instance overlay

实现成本最高，且对 MVP 收益不明确。暂不考虑。

---

## 验证策略

| 检查                 | 命令                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Type check           | `npm run check-types`                                                                                                                 |
| Build                | `npm run build`                                                                                                                       |
| Lint                 | `npm run lint`                                                                                                                        |
| Unit tests           | `npm test`（server 部分）                                                                                                             |
| Isolation tests      | 新增于 `server/src/__tests__/resolveClaudeLaunchConfig.test.ts` 等                                                                    |
| Secret-leakage check | `grep -rE 'sk-(live\|test)?[A-Za-z0-9_-]{16,}\|ANTHROPIC_API_KEY=[^\s]*[A-Za-z0-9_-]{16,}' dist/ webview-ui/src adapters server core` |
| Manual smoke         | VS Code Extension Dev Host 中真实创建 2 个 Instance                                                                                   |

---

## 风险与缓解

| 风险                                                               | 缓解                                                                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 上游 `buildLaunchCommand` / `launchNewTerminal` 后续修改影响扩展点 | 改动尽量小；测试覆盖纯函数 `resolveClaudeLaunchConfig`                                             |
| Secret 误入 log                                                    | 显式 grep 检查；type 系统避免 `string` 类型的 secret 与 `Record<string,string>` 混在同一个数据结构 |
| `vscode.SecretStorage` 在某些环境不可用                            | 启动时探测；不可用时回退"只允许 Inherit Provider"，UI 提示                                         |
| `ANTHROPIC_*` env 与用户 `~/.claude/settings.json` env 冲突        | ADR-002 显式记录限制；用户文档说明                                                                 |

---

## 后续 Spec 衔接

- **003-instance-status**：基于 001 的状态识别增强（更精确的 hook 解析）。
- **004-minimal-control-ui**：在 002 启动流程基础上补齐更完整的 UI（如 Profile 管理面板、
  Instance 列表、状态过滤）。
- **未来跨 Coding Agent**：当 Codex / Gemini CLI 接入时，每个 Runtime 自己定义
  Provider 能力（参见 requirements §"Provider 与 Coding Agent 不要混淆"）。

002 设计原则：**保持 provider 抽象干净（不写死厂商），所有逻辑走可测纯函数。**
