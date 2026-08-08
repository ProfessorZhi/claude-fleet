# 001-multi-instance-runtime — Design

> Feature slug：`001-multi-instance-runtime`  
> 关联：[`requirements.md`](./requirements.md)  
> ADR：参见 [`.agent/knowledge/decisions.md`](../../../.agent/knowledge/decisions.md) ADR-001

---

## Context

本 Feature 是 Claude Fleet MVP Spec Set 的第一个落地 Feature，对应 ROADMAP Phase 2
（Claude Code 多实例 Runtime）。当前 Claude Fleet 仓库只有文档与工作流骨架，
**没有业务代码**。

经过对上游 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) 的调研
（详见 [`.agent/references/pixel-agents.md`](../../../.agent/references/pixel-agents.md)
与 ADR-001），结论是：

> Claude Fleet 第一阶段**直接扩展** Pixel Agents 的 Runtime，而不是从零重写
> VS Code Extension。这样能立刻获得：多 Claude Code Terminal、状态检测、Pixel UI、
> Webview、Hooks 等等已经存在的能力。

本 Feature 的设计目标：

1. 把 Pixel Agents 上游代码作为 Claude Fleet 的代码基线**导入**到仓库；
2. 保留 Pixel Agents 已有的 multi-instance Runtime，**不**重写 Instance Manager；
3. 把产品层品牌从 "Pixel Agents" 替换为 "Claude Fleet"，但**保留**上游 License 与
   attribution；
4. 完成 001 Exit Criteria 中的"≥ 2 个实例"与生命周期状态展示。

---

## 高层形态

```
┌──────────────────────── Claude Fleet Extension (VS Code Host) ────────────────────────┐
│                                                                                       │
│   ┌──────────────────────────── VS Code Side ─────────────────────────────┐          │
│   │                                                                       │          │
│   │   Extension Activation                                                │          │
│   │     └─ activate(context)                                              │          │
│   │                                                                       │          │
│   │   ClaudeFleetService  (扩展自 Pixel Agents 的 ClaudeCodeService /     │          │
│   │                        AgentStateStore 等 —— 命名依上游实际结构而定) │          │
│   │                                                                       │          │
│   │   ┌─── Instance A ──────────────┐    ┌─── Instance B ─────────────┐  │          │
│   │   │ cwd: <repo A>              │    │ cwd: <repo B>              │  │          │
│   │   │ sessionId: <sa>            │    │ sessionId: <sb>            │  │          │
│   │   │ AgentState { status, ... } │    │ AgentState { status, ... } │  │          │
│   │   │ Terminal A                 │    │ Terminal B                 │  │          │
│   │   └────────────────────────────┘    └─────────────────────────────┘  │          │
│   │                                                                       │          │
│   │   Webview Panel  ◄───── postMessage({type, instanceId, ...}) ─────►   │          │
│   │                                                                       │          │
│   └───────────────────────────────────────────────────────────────────────┘          │
│                                                                                       │
│   ┌──────────────────────── Webview (Pixel UI) ─────────────────────────┐            │
│   │  Canvas: rooms / sprites                                              │           │
│   │    • Sprite A   ← mapped to Instance A                                │           │
│   │    • Sprite B   ← mapped to Instance B                                │           │
│   │  Click sprite → focus Instance's terminal in VS Code                 │           │
│   └───────────────────────────────────────────────────────────────────────┘          │
│                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

> 上图只是高层草图。具体模块名（`ClaudeCodeService` / `AgentStateStore` 等）以
> Pixel Agents 上游实际命名为准，本文件不预先替换。参见上游源码。

---

## 模块职责（基于上游的实际结构，按需命名）

以下描述的是"Claude Fleet 应承担什么职责"。如果上游已经实现了对应职责，**直接复用**，
不另建平行抽象。

| 模块                                 | 职责                                                                                | 来源                |
| ------------------------------------ | ----------------------------------------------------------------------------------- | ------------------- |
| Extension Host (activate)            | 注册命令、初始化 Service、激活 Webview Panel                                        | 上游已有            |
| `ClaudeCodeService` / 运行时 Service | 创建 / 跟踪 / 关闭 Claude Code 实例；维护 `AgentState`                              | 上游已有            |
| `AgentState`                         | 描述单个实例（`id` / `cwd` / `status` / `transcript` / …）                          | 上游已有            |
| `AgentStateStore`                    | 维护所有 `AgentState`；状态变更通知 Webview                                         | 上游已有            |
| VS Code Terminal Adapter             | `vscode.window.createTerminal({name, cwd})`；hook / transcript 读取                 | 上游已有            |
| Hook Runtime                         | Claude Code `SessionStart` / `PreToolUse` / `PermissionRequest` / `Stop` 等事件处理 | 上游已有            |
| Webview Transport                    | Extension Host ↔ Webview 的 `postMessage` 协议                                      | 上游已有            |
| Pixel UI（Canvas）                   | Sprite 渲染、点击交互、状态动画                                                     | 上游已有            |
| Branding / Display                   | Product Name、displayName、命令标题等品牌字段                                       | **本 Feature 改造** |
| License & Attribution                | 上游 MIT 文本、原作版权、Claude Fleet 二次声明                                      | **本 Feature 改造** |

> 能扩展上游 `AgentState` 就不要建立第二套状态系统。能扩展上游 Service 就不要新建
> `FleetInstanceManagerV2` 这种平行抽象。

---

## 数据 / 状态形态

### Instance（以 `AgentState` 为基础）

字段（最小集，以上游已有为准；下列字段如上游不存在，**允许**最小增量补齐）：

| 字段         | 类型              | 含义                                                              |
| ------------ | ----------------- | ----------------------------------------------------------------- |
| `id`         | string            | 实例唯一 ID（Claude Fleet 用 `cf-<n>` 命名空间）                  |
| `cwd`        | string            | 实例工作目录 / Repo 绑定                                          |
| `sessionId`  | string            | Claude Code Session ID                                            |
| `status`     | enum              | `starting` / `running` / `waiting` / `idle` / `stopped` / `error` |
| `terminal`   | `vscode.Terminal` | 该实例对应的 VS Code Terminal                                     |
| `transcript` | (上游原有)        | 实例的 transcript / hook 记录                                     |

> 具体内部字段命名以**上游实际代码**为准。本 Feature 只保证：
>
> - 每个实例独立持有自己的 `cwd` / `sessionId` / `status`；
> - 两个实例的状态互不影响。

### 状态持久化

本 Feature **不引入**持久化机制。实例状态跟随 VS Code Extension 的生命周期。
（持久化是后续 Spec 的事。）

---

## 接口（Interfaces）

### 扩展命令（Claude Fleet 命名空间）

| Command ID                    | 作用                                             |
| ----------------------------- | ------------------------------------------------ |
| `claude-fleet.openPanel`      | 打开 Claude Fleet Webview Panel                  |
| `claude-fleet.newInstance`    | 创建一个新的 Claude Code 实例（可选 `cwd` 参数） |
| `claude-fleet.focusInstance`  | 把焦点切到指定实例                               |
| `claude-fleet.stopInstance`   | 停止指定实例                                     |
| `claude-fleet.removeInstance` | 移除指定实例                                     |

> Command ID 是否一次性全部替换为 `claude-fleet.*`，由本 Feature 决定。
> 默认策略见后文"命名空间策略"。

### Webview Message Protocol

直接复用上游已有的 message protocol。Claude Fleet 这一版**不**改动 message 协议，
以免引入不必要的兼容层。

---

## 失败模式（Failure Modes）

| 场景                                | 应对                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| 上游 `npm install` 失败             | 记录错误 + Root Cause，决定 fix 还是 defer；不在本 Feature 范围 |
| 单个实例的 Claude Code 进程崩溃     | `AgentState.status → error`；其他实例不受影响                   |
| `cwd` 路径不存在                    | `status → error`；UI 显示明确错误原因                           |
| `vscode.window.createTerminal` 失败 | 走 `status → error`；记录到 Extension log                       |
| Webview 与 Extension Host 通信断开  | Webview 端降级展示"Disconnected"；Host 端重连由上游机制保证     |

---

## 取舍（Trade-offs）

### 选：直接扩展 Pixel Agents Runtime

**优点**：立刻拿到 multi-instance、hooks、transcript、Pixel UI、webview 等一整套
已能工作的能力，显著缩短 MVP 时间。  
**代价**：

- 必须保留 MIT License 与原作者版权（不可移除）；
- 必须跟踪 upstream 演进；
- 上游命名空间 / 配置 key 决定暂时保留还是迁移，需要在 design 中明示。

### 弃：从零重写 Extension

Phase 1 重写一个完整 VS Code Extension + 多实例 Runtime + Hook + Webview +
Pixel UI 成本极高、收益相对低。001 的目标只是"多实例能跑起来"。

### 弃：新建 `FleetInstanceManagerV2`

上游 `AgentStateStore` + `launchNewTerminal` 已经基本能表达 Claude Fleet
"Instance"概念。新建第二套抽象只会带来双状态机、双事件、双消息协议，徒增维护成本。

---

## 命名空间策略（命名迁移 vs 保留）

按"逐类处理"原则：

| 类别                                                               | 策略                                                               | 说明                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Product branding（displayName、面板标题、UI 文案）                 | 替换为 Claude Fleet                                                | 用户面                                                                  |
| `package.json` 的 `name` / `displayName`                           | 替换                                                               | 用户面                                                                  |
| `package.json` 的 `publisher`                                      | 暂留 `TBD`，不擅自填                                               | 防止误发布到 Marketplace                                                |
| Command ID（`claude-fleet.*`）                                     | **本期替换**                                                       | 用户面 API，越早稳定越好                                                |
| View ID（`claude-fleet.panelView`）                                | **本期替换**                                                       | 用户面                                                                  |
| 内部 namespace（变量名、文件夹名 `pixel-agents` → `claude-fleet`） | **本期替换**                                                       | 跟随命令 ID 一起                                                        |
| Persistence namespace（webview 持久化 key、globalState key）       | **保留上游值**                                                     | 不破坏已有用户状态（见下方决策记录）                                    |
| Logs / Debug channel 名称                                          | 替换为 `Claude Fleet`                                              | 便于用户搜索                                                            |
| License / Attribution 文本                                         | **不可改**                                                         | MIT 原文 + 原作者版权保留；可新增 Claude Fleet 二次声明                 |
| Config keys（`pixel-agents.*`）                                    | **本期替换**为 `claudeFleet.*`，但**保留**旧 key 作为兼容 fallback | 防止配置丢失（详见命名迁移决策）                                        |
| Class 名（`PixelAgentsViewProvider` 等）                           | **本期保留**                                                       | 改名会牵动大量引用；属于"内部架构标识"，暂不影响用户面                  |
| AsyncAPI 协议 title                                                | **本期保留**                                                       | 不影响运行；后续 spec 决定                                              |
| Hook script 标识（`CLAUDE_HOOK_SCRIPT_NAME = 'claude-hook.js'`）   | **本期保留**                                                       | 改名会破坏 Claude Code `~/.claude/settings.json` 中已有的 hook 标识检测 |

### Persistence namespace 保留决策

> 001 本期**不**主动把 `pixel-agents.*` 这类 globalState key 与 `~/.pixel-agents/`
> 路径改为 `claude-fleet.*`。
>
> 理由：
>
> - 直接改名会**清空所有用户的现有状态**（layout / sound on/off / always-show-labels 等）；
> - 已有 Pixel Agents 用户升级到 Claude Fleet 后会丢失状态；
> - Claude Fleet 当前是 fork，理论上仍接收"从 Pixel Agents 升级"的用户；
> - 后续可以单独 Spec 设计"state migration"路径，而不是在 001 顺手做。
>
> 影响：
>
> - `~/.pixel-agents/config.json` 等磁盘文件路径**保持上游**；
> - `pixel-agents.soundEnabled` 等 globalState key **保持上游**；
> - 用户面字符串（命令、displayName、config key）**改**为 Claude Fleet。

> 命名迁移的实际改动以"最小破坏"为原则。任何把上游 namespace 替换为 Claude Fleet
> 的 PR 都需要明确列出"为什么现在替换"。

---

## 生命周期状态映射（与上游现状相关）

> 本节在 Research 阶段补全。下表是预期映射的**占位**：

| Claude Fleet 期望状态 | 上游可能命名（占位）     | 备注                       |
| --------------------- | ------------------------ | -------------------------- |
| `starting`            | `starting` / `init`      | 实际名以 Research 结果为准 |
| `running`             | `running` / `thinking`   |                            |
| `waiting`             | `waiting` / `permission` |                            |
| `idle`                | `idle`                   |                            |
| `stopped`             | `stopped` / `closed`     |                            |
| `error`               | `error` / `crashed`      |                            |

如果上游状态命名已经与 Claude Fleet 一致，本节退化为纯引用。**不要**为对齐命名
大规模重写上游状态机。

---

## 验证策略

| 检查               | 命令                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| 类型检查           | `npm run check-types`                                                                           |
| Lint               | `npm run lint`                                                                                  |
| 单元测试           | `npm test`                                                                                      |
| 构建               | `npm run build`                                                                                 |
| 运行时验证（手动） | VS Code Extension Development Host 启动 → 开 Panel → 创建 2 个 Instance → Focus / Stop / Remove |

详见 [`tasks.md`](./tasks.md)。

---

## 风险与缓解

| 风险                                      | 缓解                                                                |
| ----------------------------------------- | ------------------------------------------------------------------- |
| 上游 Pixel Agents 当前 commit 跑不起来    | 先在 sibling 临时目录 `../pixel-agents-upstream` 跑通；不阻塞即继续 |
| 上游命名空间与 Claude Fleet 命名空间冲突  | 命名迁移策略表 + 兼容 fallback                                      |
| 上游某个 hook / transcript 接口与预期不符 | 在 design 中显式记录差异，按"最小改动扩展"处理                      |
| 上游 License 与 Claude Fleet 计划不兼容   | 上游是 MIT，Claude Fleet 同样按 MIT 处理；详见 ADR-001              |
| Scope creep（顺手做 Provider）            | 在 tasks.md 中显式列出"Out of Scope"，每次 commit 前自检            |

---

## 后续 Spec 衔接

- **002-provider-model-isolation**：在 001 Runtime 上叠加 Provider / Model 隔离，
  不会重写 Instance 模型。
- **003-instance-status**：在 001 状态识别基础上增强（更精确的 hook / transcript
  解析等）。
- **004-minimal-control-ui**：在 001 控制命令基础上补齐更完整的 UI（如 Instance 列表、
  状态过滤等）。

001 设计原则：**为后续 Spec 留好扩展点，而不是替它们做决定。**
