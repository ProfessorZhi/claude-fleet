# 001-multi-instance-runtime — Requirements

> Feature slug：`001-multi-instance-runtime`  
> Phase：Phase 2（Claude Code 多实例 Runtime）—— ROADMAP Phase 1 Spec Set 的第一个 Feature  
> 依赖：暂无前置 Feature（这是 MVP Spec Set 的第一个落地 Feature）  
> 阻塞：002（Provider / Model 隔离）、003（Instance Status）、004（Control UI）

---

## 目标（Goal）

基于上游 Pixel Agents 已有的 VS Code Extension、多 Claude Code Terminal、状态检测
与 Pixel UI 能力，建立 Claude Fleet 的**第一版 Claude Code 多实例 Runtime**，
使 Claude Fleet 能够作为 VS Code Extension 启动，并同时创建、识别、展示多个
独立 Claude Code Session。

---

## 用户故事（User Stories）

- **US-1 启动 Claude Fleet** —— 作为开发者，我希望在 VS Code 中启动 Claude Fleet
  Extension，以便在统一工作区里管理多个 Claude Code 实例，而不是开多个终端。
- **US-2 创建第一个实例** —— 我希望能在 Claude Fleet 里创建一个 Claude Code 实例，
  并让它运行在我的目标 Repo 上。
- **US-3 创建第二个实例** —— 我希望能在不重启的前提下，再创建一个 Claude Code 实例，
  让两个实例**同时**运行在不同的 Repo / Session 上。
- **US-4 区分实例** —— 我希望在 UI 上能一眼分辨这两个实例（位置 / 状态 / Repo）。
- **US-5 关注实例** —— 我希望能"聚焦"到任意一个实例的 terminal / 状态，以便查看
  它在做什么。
- **US-6 停止实例** —— 我希望能停止或移除一个实例，**不影响**其他仍在运行的实例。
- **US-7 错误不互相波及** —— 当某个实例出错或退出时，其他实例必须继续稳定运行。

---

## 功能性需求（Functional Requirements）

### FR-001 VS Code Extension

Claude Fleet 必须可以作为 VS Code Extension 启动（Extension Development Host 形式）。

- 在 VS Code 中加载后，Extension 必须被 VS Code 正常激活；
- 提供一个用于查看 / 控制实例的入口（命令、面板、TreeView、Webview 等之一即可）。

### FR-002 多实例

在同一 VS Code Workspace 中，必须可以同时启动并存在 **至少 2 个 Claude Code 实例**。

- 两个实例必须能**并发运行**；
- 两个实例的状态必须能被独立观察；
- 操作一个实例不得阻塞另一个实例的 UI 响应。

### FR-003 Repo / Working Directory 绑定

每个实例必须拥有自己的 `cwd` / Repo 绑定：

- 创建实例时必须能指定其工作目录（Repo 根目录）；
- 实例的 terminal 与状态读取必须使用自己的 cwd；
- 两个实例绑定到不同 Repo 时，必须互不污染（状态、文件读写路径等）。

### FR-004 独立 Session

每个 Claude Code 实例必须拥有独立 Session：

- 实例之间不共享同一个 Claude Code Session；
- Session 边界与 cwd 绑定关系由实现层保证（具体策略见 `design.md`）。

### FR-005 生命周期状态识别

Extension 必须能够识别并暴露每个实例的基础生命周期状态：

| 状态       | 含义（最小可用定义）                                      |
| ---------- | --------------------------------------------------------- |
| `starting` | 实例已创建、terminal 已开、Claude Code 尚未就绪           |
| `running`  | Claude Code 正常运行（transcript 写入、tool call 处理中） |
| `waiting`  | 实例在等用户确认（Permission Request / Hook 阻塞等）      |
| `idle`     | 实例没有新动作（transcript 静止一段时间，但仍存活）       |
| `stopped`  | 实例被主动停止 / 移除，或 Claude Code 已退出              |
| `error`    | 实例发生不可恢复错误（terminal 异常退出、hook 错误等）    |

> 如果上游 Pixel Agents 内部状态命名与上表不同，**不要**为了强行对齐而大规模重写。
> 在 `design.md` 中记录映射关系，由 UI 层做翻译。

### FR-006 多实例 UI

UI 必须能同时展示多个实例：

- 至少能看到**两个**实例的标识与最新状态；
- 本阶段**允许**直接复用 Pixel Agents 现有 Pixel UI；
- 不要求重新设计最终 UI；
- 必须能区分"实例 A vs 实例 B"（通过位置 / 编号 / 标签任意一种）。

### FR-007 基础控制

至少支持下列操作：

| 操作          | 含义                                         |
| ------------- | -------------------------------------------- |
| Launch        | 创建一个新的 Claude Code 实例（带可选 cwd）  |
| Focus         | 把焦点切到指定实例对应的 terminal / 状态视图 |
| Stop / Remove | 停止或移除一个实例，且**不影响**其他实例     |

> 上游 Pixel Agents 中 `stop` 与 `remove` 的语义可能不同（如 `stop` 关 terminal /
> `remove` 同时清理状态）。具体语义与映射在 `design.md` 中解释。

---

## 非功能性需求（Non-Functional Requirements）

- **NFR-001 可靠性**：一个实例的 terminal 异常退出**不得**影响其他实例或整个 Extension 的稳定性。
- **NFR-002 可观察性**：每个实例的状态变化必须可被 UI 与日志看到（Pixel 状态、Webview
  message、debug log 等）。
- **NFR-003 复用性**：必须**优先复用**上游 Pixel Agents 已有的 multi-instance 能力
  （terminal、agent state、hook、webview），而不是另起炉灶创建第二套状态系统。
- **NFR-004 Attribution**：上游 MIT License 与原作者版权声明必须保留。
- **NFR-005 构建可验证**：本 Feature 完成后，至少 `npm run check-types` 与
  `npm run build` 必须能通过；`npm test` 与 `npm run lint` 尽量通过。

---

## 不在本 Feature 范围内（Out of Scope）

明确**不做**的事，避免 scope creep：

- ❌ Provider Profile / Model Profile / Provider 切换 UI
- ❌ MiniMax / DeepSeek / Kimi 等非 Anthropic Provider 的接入
- ❌ `CLAUDE_CONFIG_DIR` / 环境变量级别的 Provider 隔离（属 Phase 3 / Spec 002）
- ❌ 完整 Control Center UI 重构
- ❌ 跨 Coding Agent 支持（Codex / Gemini CLI / Antigravity）
- ❌ Marketplace 发布
- ❌ 任务看板 / Git Worktree 自动管理 / Docker Sandbox / 云端同步

> 这些将在后续 Spec 中按 ROADMAP 阶段推进。

---

## 开放问题（Open Questions）

> 这些问题在 `design.md` 中应给出当前决定；如果暂时无法决定，标记为 TBD 并说明
> defer 原因。

- **OQ-1**：上游 Pixel Agents 的 `AgentState` / `AgentStateStore` 是否已经能直接表达
  Claude Fleet 的"Instance"概念？还是需要增量新增字段？ → 在 design 中确认。
- **OQ-2**：上游 `launchNewTerminal` 是否已经能作为 Claude Fleet Phase 2 的 Launch
  实现？还是需要包一层？ → 在 design 中确认。
- **OQ-3**：Pixel UI 中"room / sprite"与 Claude Fleet "Instance"如何一一对应？ → 在
  design 中确认。
- **OQ-4**：实例的 `cwd` 选择 UX（用户每创建一次手动选？记住上次？）本期如何处理？→
  本期允许沿用上游默认行为。

---

## Exit Criteria

本 Feature 完成的判定（与 ROADMAP Phase 2 的 Exit Criteria 对齐）：

- ✅ Claude Fleet 能作为 VS Code Extension 启动；
- ✅ 同一 Extension 内可以并行启动 **≥ 2 个** Claude Code 实例；
- ✅ 两个实例的 Repo / Session 互不污染；
- ✅ 能分别 Launch / Focus / Stop / Remove 每个实例；
- ✅ 至少能识别并展示 `starting` / `running` / `waiting` / `idle` / `stopped` /
  `error` 这 6 个生命周期状态（或上游命名映射后等价的状态）；
- ✅ 上游 MIT License 与 Pixel Agents attribution 保留；
- ✅ `npm run check-types` 与 `npm run build` 通过。
