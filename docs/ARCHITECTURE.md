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

## 当前理解（Phase 0）

我们仍然在非常早期。宿主是 VS Code Extension。每个 Agent 实例在概念上长这样：

```
┌──────────────── Claude Fleet 实例 ────────────────┐
│  Repo binding  │  Provider  │  Model  │  环境变量  │
│  Agent Runtime (当前是 Claude Code, 未来可插拔)   │
│  Status / Progress Stream                        │
└──────────────────────────────────────────────────┘
```

具体的运行时模型（子进程 vs workspace 连接 vs SDK 嵌入）、状态如何持久化、UI 如何映射
到这些状态，目前都是 **TBD**，将由 MVP Spec Set 阶段确认。

---

## 核心模块候选

| 模块 | 职责 | 状态 |
|---|---|---|
| VS Code Extension Host | 拥有 UI、命令、生命周期 | TBD |
| Instance Manager | 启动 / 跟踪 / 终止 Agent 实例 | TBD |
| Provider 抽象 | 可插拔的 Provider + Model 配置 | TBD |
| Repo Binder | 把每个实例绑定到一个 Repo，并保证隔离 | TBD |
| Status / Event Stream | 把实时状态推送到 UI | TBD |
| Pixel-style 可视化 | 对实时状态的一种渲染 | TBD |

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

本文只保留一句摘要。Phase 0 当前尚未生成 ADR。

- *(none yet)* — ADRs 将在 MVP Spec Set 阶段产出。