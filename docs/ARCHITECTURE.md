# ARCHITECTURE.md — Claude Fleet

> "系统当前长什么样"。  
> 产品说明见 [`PROJECT.md`](./PROJECT.md)；阶段规划见 [`ROADMAP.md`](./ROADMAP.md)。
>
> 本文件在 Phase 0 故意保持轻量。架构未定型之前，不要假装它已经定型。

---

## 架构目标

- **天生面向多 Agent。** 不应该有任何架构决策把 Claude Code 写死成唯一 Agent；
  Codex、Gemini CLI、Antigravity 等 Coding Agent 必须可以在不重写宿主的前提下加入。
- **强隔离。** 每个实例的 Repo / Provider / Model / 配置默认互不污染。
- **实时可观测。** UI 反映 Agent 状态的延迟必须低到让"同时驱动多个 Agent"这件事
  是可用的，而不是令人抓狂的。
- **本地优先，VS Code 为锚点。** 产品形态是 VS Code Extension；核心功能不应依赖云端。
- **可视化层可扩展。** Pixel-style 只是同一种状态的其中一种渲染，未来允许有其他渲染
  形态而不复制状态本身。

---

## 当前理解（Phase 0 → Phase 2）

经过对上游 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) 的调研
（见 [`.agent/references/pixel-agents.md`](../.agent/references/pixel-agents.md)
与 ADR-001），Claude Fleet 第一阶段**直接基于** Pixel Agents 上游代码进行二次开发，
作为 VS Code Runtime 与可视化基线。

### 高层形态（基于上游实际结构）

```
┌──────────────── Claude Fleet Extension (VS Code Host) ────────────────────────┐
│                                                                              │
│   adapters/vscode/                                                           │
│   ├── extension.ts                — activate / deactivate                   │
│   ├── agentManager.ts             — launchNewTerminal (Multi-Instance)        │
│   ├── PixelAgentsViewProvider.ts  — Webview Panel 宿主                       │
│   ├── vscodeTerminalAdapter.ts    — vscode.window.createTerminal             │
│   ├── migrateVsCodeState.ts       — 旧状态迁移                                │
│   └── constants.ts                — 命名空间常量                              │
│                                                                              │
│   server/                                                                    │
│   ├── src/agentStateStore.ts      — AgentState / AgentStateStore             │
│   ├── src/agentRuntime.ts         — Runtime 生命周期                          │
│   ├── src/hookEventHandler.ts     — Hook 事件分发                              │
│   ├── src/fileWatcher.ts          — JSONL / transcript 监听                  │
│   ├── src/httpServer.ts           — Fastify + WebSocket                       │
│   ├── src/{layoutPersistence,configPersistence}.ts — 持久化                  │
│   └── src/providers/hook/claude/  — Claude Code Provider 实现               │
│                                                                              │
│   core/                                                                      │
│   ├── src/provider.ts             — Provider 接口                            │
│   ├── src/adapter.ts              — State Adapter 接口                       │
│   ├── src/transport.ts            — 消息传输接口                              │
│   ├── src/messages.ts             — 协议消息模型                              │
│   └── src/schemas.ts              — Zod schema                               │
│                                                                              │
│   webview-ui/                                                                │
│   ├── src/App.tsx                 — Canvas 主应用                            │
│   ├── src/components/             — 弹窗 / 列表 / 控件                        │
│   ├── src/office/                 — Pixel Office 渲染                        │
│   └── src/transport/              — WebSocket / postMessage                  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

每个 Agent 实例在概念上：

```
┌──────────────── Claude Fleet Instance ────────────────┐
│  Repo binding  │  Provider  │  Model  │  环境变量    │
│  Agent Runtime (Claude Code via claudeProvider)      │
│  Status / Progress Stream                            │
└──────────────────────────────────────────────────────┘
```

---

## 核心模块候选

> 表中**当前选择**列基于 ADR-001，已经从 TBD 推进为"复用上游"。

| 模块                     | 职责                                                                         | 状态                                           |
| ------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| VS Code Extension Host   | `adapters/vscode/extension.ts`                                               | **当前选择**：复用上游                         |
| Instance Manager         | `adapters/vscode/agentManager.ts` 的 `launchNewTerminal` + `AgentStateStore` | **当前选择**：复用上游；按需扩展字段           |
| Provider 抽象            | `core/src/provider.ts`、`server/src/providers/index.ts`                      | **当前选择**：复用上游；Claude 是首个 Provider |
| Claude Provider          | `server/src/providers/hook/claude/`                                          | **当前选择**：复用上游；默认 Claude Code       |
| Repo Binder              | `getProjectDirPath` + Claude session dir 映射                                | **当前选择**：复用上游                         |
| Status / Event Stream    | `AgentStateStore` + `hookEventHandler` + Webview transport                   | **当前选择**：复用上游                         |
| Pixel-style 可视化       | `webview-ui/src/office/`                                                     | **当前选择**：复用上游；不在 001 重做 UI       |
| Provider / Model 隔离    | 独立的 `CLAUDE_CONFIG_DIR` / env 注入                                        | TBD（Phase 3 / Spec 002）                      |
| 持久化策略（State 放哪） | 上游默认走 `~/.pixel-agents/`                                                | TBD（决定是否迁移到 Claude Fleet 命名空间）    |
| 跨 Coding Agent 接入     | Provider subdirectory 抽象                                                   | TBD（Phase 5）                                 |

---

## 外部项目依赖 / 参考

> 当前阶段会重点研究以下项目 / 方向，但尚未正式引入依赖。

- **Pixel Agents** —— Pixel-style 多人多 Agent 房间的视觉与交互参考。
- **Claude Code** —— 第一阶段被管理的 Coding Agent 运行时。
- **Provider / Model 隔离** —— 每个实例独立的 Provider / Model 配置策略。
- **VS Code Extension** —— 宿主能力来源（Webview、命令、TreeView、状态栏、Workspace APIs）。
- **多 Session 管理** —— 同时维护多个独立 Session 的生命周期与隔离。

> 不在 Phase 0 阶段执行具体实现，也不引入 npm 依赖；以上只是研究方向。

---

## 关键技术问题（Open Questions）

这些是 Phase 1（MVP Spec Set）阶段必须给出方向的问题：

- Agent Runtime 进程模型：child process？VS Code workspace 连接？SDK 嵌入？各自的
  隔离 / 可观测性 / 性能 trade-off 是什么？
- 持久化状态放哪里：VS Code `globalState`、磁盘 JSON / SQLite、或者干脆不持久化。
- Provider / Model / 环境隔离如何强制：独立进程 / 独立配置上下文 / 独立容器。
- Pixel-style 可视化的形态：渲染技术栈、布局模型、交互模型，以及它如何映射 Agent 状态。
- Coding Agent 调用方式：CLI、SDK，还是两者都支持。
- Codex / Gemini CLI / Antigravity 接入策略：仅 Provider 抽象，还是更通用的 Agent Adapter。

---

## 已确认架构决策

ADRs 集中记录在 [`.agent/knowledge/decisions.md`](../.agent/knowledge/decisions.md)。

| ADR     | 标题                                                                    | 状态     |
| ------- | ----------------------------------------------------------------------- | -------- |
| ADR-001 | 以 Pixel Agents 作为 Claude Fleet 第一阶段 VS Code Runtime 与可视化基础 | Accepted |

- ADR-001 已记录：Claude Fleet 第一阶段直接复用 Pixel Agents 上游代码作为基线。
