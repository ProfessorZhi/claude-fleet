# 002-provider-model-isolation — Requirements

> Feature slug：`002-provider-model-isolation`  
> Phase：Phase 3（Provider / Model 独立配置与隔离）—— ROADMAP Phase 1 Spec Set 的第二个 Feature  
> 依赖：[`001-multi-instance-runtime`](../001-multi-instance-runtime/)（必须先有 Runtime）  
> 阻塞：003（Instance Status 增强）、未来 Codex / Gemini 接入

---

## 目标（Goal）

让同一 VS Code 工作区里并行的多个 Claude Code Instance **各自拥有独立**的 Provider 和 Model
配置；一个 Instance 的配置变化不得影响其他 Instance。Provider 配置属于 Instance Launch
Context，不写入用户全局 `~/.claude/settings.json`。

---

## 用户故事（User Stories）

- **US-1 多 Provider 并行** —— 我希望在同一个 VS Code 里同时跑两个 Claude Code 实例，
  一个走 Anthropic 官方登录，另一个走自建 Gateway，两个互不污染。
- **US-2 每实例选 Model** —— 我希望每个实例在创建时选自己的 Model（如 `claude-opus-4`
  vs 自定义 model id），而不是被全局 `model` 设置影响。
- **US-3 自定义 Provider** —— 我希望配置一个 Custom Provider（自定义 base URL + API Key），
  用于第三方 Anthropic-compatible endpoint。
- **US-4 安全存储 Secret** —— 我添加 Provider 时输入的 API Key 不应该出现在任何
  Git 跟踪文件 / log / Webview 消息 / 全局 settings 中。
- **US-5 切换语义清晰** —— 我修改 Provider Profile 后，已经运行的实例继续按 launch-time
  配置运行；只有新启动的实例才使用新 Profile。
- **US-6 一键停止 / 重启** —— 当我希望某个实例换 Provider，我能"停止 + 重新创建"，
  而不需要重启 VS Code。
- **US-7 UI 可见** —— Pixel UI 上能看出每个实例当前用的是哪个 Provider / Model。

---

## 功能性需求（Functional Requirements）

### FR-001 Per-Instance Provider Profile

每个 Claude Code Instance 必须绑定一个 **Provider Profile**：

- Provider Profile 包含：`id`、`name`、`baseUrl`（可选）、`authMode`、`secretRef`（可选）、
  `customHeaders`（可选）；
- 创建实例时必须能选择 Profile；
- 同一 Profile 可被多个实例复用。

### FR-002 Per-Instance Model

每个 Instance 必须能指定一个 **Model ID**：

- Model ID 是任意合法字符串（不限 enum）；
- Model ID 在启动时通过 `claude --model <id>` 传入；
- 不同实例可以使用不同 Model ID，互不影响。

### FR-003 Provider Profile Management

MVP 必须支持两类 Provider：

| Profile 类型            | 行为                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| **Anthropic / Inherit** | 不覆盖 `ANTHROPIC_BASE_URL`；不注入 API Key；继承用户当前 Claude Code 登录；Model 仍可选 |
| **Custom Provider**     | 用户配置：name、base URL、authMode（`apiKey` 或 `authToken`）、secret、Model ID          |

> 第一版**不**预置 MiniMax / DeepSeek / Kimi 等 preset；Custom Provider 是验证架构的
> 最小入口。如果用户需要，可自行添加。

### FR-004 Secret 安全

- Provider 的 secret 必须通过 **VS Code SecretStorage** 存储；
- `ProviderProfile` 中只保存 `secretRef`，**绝不**保存 plaintext secret；
- secret 仅在启动 terminal 时进入 process environment；
- secret **不得**出现在：persisted state、log、Webview DTO、AgentState。

### FR-005 Instance Launch Config

每个实例在创建时携带 **InstanceLaunchConfig**：

```text
{
  cwd: string,
  providerProfileId: string,
  modelId?: string,
}
```

启动时由 `resolveClaudeLaunchConfig(...)` 解析为：

```text
{
  env: Record<string, string>,   // ANTHROPIC_* 等
  args: string[],                // claude --model ... --session-id ...
  safeMetadata: { providerDisplayName, modelId, ... }   // 可序列化、不含 secret
}
```

### FR-006 启动流程变更

`+ Agent` 不再直接启动 Claude Code。改为：

```text
+ Agent
   ↓
QuickPick: 选择 Repo / Workspace Folder
   ↓
QuickPick: 选择 Provider Profile（Create new "Custom Provider" 也是选项）
   ↓
InputBox / QuickPick: 选择或输入 Model ID
   ↓
Launch
```

如果当前只有一个 workspace，直接使用该 cwd，不弹 QuickPick。

### FR-007 不污染用户全局配置

MVP 严格不修改 `~/.claude/settings.json` 的以下字段：

- `env.ANTHROPIC_BASE_URL`
- `env.ANTHROPIC_API_KEY`
- `env.ANTHROPIC_AUTH_TOKEN`
- `model`

> 唯一可能改 `~/.claude/settings.json` 的内容是 **Pixel Agents / Claude Fleet 自己的
> hooks**（属于 001 已有的能力），不属于本 Feature 范围。

### FR-008 编辑 / 删除 Provider Profile 语义

| 操作         | 对已运行实例                          | 对新启动实例               |
| ------------ | ------------------------------------- | -------------------------- |
| 编辑 Profile | 无影响                                | 生效                       |
| 删除 Profile | 无影响（继续按 launch-time 配置运行） | 创建时不允许选择该 Profile |

不实现"运行中 hot swap Provider"。

### FR-009 UI 元数据

Pixel UI 上每个 Instance 必须展示：

- Repo（cwd basename）
- Provider（display name）
- Model
- Session ID（截短显示）
- Status

实现方式最小：tooltip / detail panel / sprite 上方的 label。

### FR-010 错误处理

- Provider Profile 不存在 → 错误信息提示用户，不 crash Extension；
- Secret 缺失 → 提示"请先在 Provider 配置中填入 Secret"；
- baseUrl 非合法 URL → 校验失败，阻止保存；
- Model 为空 → 在 Inherit 模式下允许为空；Custom Provider 下要求非空；
- SecretStorage 读取失败 → 错误日志（不含 secret 内容）+ UI 提示；
- Claude CLI 启动失败 → terminal 输出走 VS Code 现有错误流。

---

## 非功能性需求（Non-Functional Requirements）

- **NFR-001 隔离性**（最重要）：两个 Instance 启动后，进程环境必须**互不可见**，
  即 A 改 env 不影响 B。
- **NFR-002 安全性**：secret 永不出现在任何持久化 / 日志 / Webview 数据中。
- **NFR-003 测试性**：所有隔离 / 解析逻辑走**纯函数**（`resolveClaudeLaunchConfig`），
  可单元测试，不依赖 GUI / 文件系统副作用。
- **NFR-004 向后兼容**：001 已有的"直接 `+ Agent` 自动 launch" 行为保留为可选
  （Inherit Profile + 单一 workspace 时自动选择）。
- **NFR-005 复用上游**：不创建第二个 Runtime / AgentState / launchNewTerminal；
  仅扩展 `claudeProvider.buildLaunchCommand` 与 `launchNewTerminal` 的入参。

---

## 不在本 Feature 范围内（Out of Scope）

明确**不做**的事：

- ❌ LiteLLM 自动安装 / OpenAI ↔ Anthropic 协议转换
- ❌ MiniMax / DeepSeek / Kimi / 任何第三方 Provider 的 preset
- ❌ Codex / Gemini CLI / Antigravity 的 Provider 接入（属 Phase 5）
- ❌ 运行中 hot swap Provider / Model
- ❌ Provider Marketplace / 账号系统 / Token 用量计费
- ❌ 持久化 SQLite（用 VS Code globalState 即可）
- ❌ 多人协作 / 云端同步 / Worktree Manager / Docker

---

## 开放问题（Open Questions）

- **OQ-1**：`~/.claude/settings.json` 的 `env` block 会覆盖 shell env；本 Feature 是否
  必须用 per-instance `CLAUDE_CONFIG_DIR` 才能保证完全隔离？ → 走 ADR-002。
- **OQ-2**：hooks 仍然安装在用户级 `~/.claude/settings.json`；这对多实例隔离有副作用吗？
  → 评估；hooks 是 Claude Fleet 自己的内容（同一份），多个实例共享无害。
- **OQ-3**：Custom Provider 的 Model 字段是必填还是可选？ → 必填（与 Inherit 不同）。

---

## Exit Criteria

- ✅ 至少 2 个 Instance 并行运行时，分别使用不同 Provider Profile / Model；
- ✅ `resolveClaudeLaunchConfig` 纯函数有 5+ 单元测试覆盖：env 隔离、model args、
  secret ref、错误情况；
- ✅ 启动后修改 Profile A 不得改变 Instance B 的 env（已有实例的行为）；
- ✅ Provider Profile 非 Secret 信息持久化在 VS Code globalState；
- ✅ Secret 走 VS Code SecretStorage；执行 `grep -r "ANTHROPIC_API_KEY\|sk-\|sk_live\|sk_test" dist/ webview-ui/src adapters server core`
  在已 build 产物中**零命中**（除 mock/test fixture）。
- ✅ `npm run check-types` / `npm run build` / `npm run lint` 通过；新增 isolation
  tests 全部通过；不破坏 001 已有测试。
- ✅ LICENSE 与 Pixel Agents attribution 仍保留。
