# Reference — Pixel Agents

> 本文件记录 Claude Fleet 对上游 Pixel Agents 项目的引用信息。  
> 详细架构决策见 [`.agent/knowledge/decisions.md`](../knowledge/decisions.md) ADR-001。

---

## Repository

| 字段                        | 值                                                |
| --------------------------- | ------------------------------------------------- |
| **名称**                    | Pixel Agents                                      |
| **上游 URL**                | https://github.com/pixel-agents-hq/pixel-agents   |
| **本地克隆路径（sibling）** | `../pixel-agents-upstream`（仓库根目录外部）      |
| **Commit SHA**              | `9794e075d3cf1a1407766a93d3cac87813393705`        |
| **Branch**                  | `main`                                            |
| **Version**                 | `1.4.0`（来自 upstream `package.json`）           |
| **License**                 | MIT — Copyright (c) 2026 Pablo De Lucca           |
| **Publisher（upstream）**   | `pablodelucca`（**不**沿用，Claude Fleet 留 TBD） |

> ⚠️ 每次 Claude Fleet 仓库"重新同步 upstream"时，必须**更新本文件**的 Commit SHA
> 与"复用的模块列表"，并**保留** License 与原作者版权。

---

## 为什么选择它

- 已有 **多 Claude Code Terminal**：每个 terminal 对应一个独立 Agent / Session，
  不需要从零实现 multi-instance Runtime。
- 已有 **Claude Code hooks / transcript 状态检测**：`SessionStart` / `PreToolUse` /
  `PermissionRequest` / `Stop` 等事件已经被用于驱动 AgentState。
- 已有 **Pixel-style Canvas UI**：Webview + Canvas + sprite 动画。
- 已有 **VS Code Extension 宿主**：命令、Panel、globalState、文件持久化等都已接通。
- 已有 **多 workspace 支持**：可以区分 multi-root 中的 Agent。

总结：显著缩短 Claude Fleet MVP 时间。代价是必须跟踪 upstream 演进 + 保留
MIT attribution。

---

## 当前计划复用的模块（Claude Fleet 第一版基线）

> 这是 001 / Phase 2 这一轮的复用清单。后续 Spec 可能会新增或替换某些模块。

| 模块                                     | 上游路径                                                              | 用途                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Extension Host (activate)                | `adapters/vscode/extension.ts`                                        | VS Code Extension 入口                                                                                         |
| Multi-instance launch                    | `adapters/vscode/agentManager.ts` 中的 `launchNewTerminal`            | 创建新 Claude Code Instance；**Spec 002** 扩展其接受 `InstanceLaunchConfig` 并按 Provider Profile 解析 env     |
| View Provider                            | `adapters/vscode/PixelAgentsViewProvider.ts`                          | Webview Panel 宿主；**Spec 002** 持有 `ProviderProfileStore` / `SecretStorageProvider`                         |
| Terminal Adapter                         | `adapters/vscode/vscodeTerminalAdapter.ts`                            | 与 `vscode.window.createTerminal` 交互                                                                         |
| State Migration                          | `adapters/vscode/migrateVsCodeState.ts`                               | 上游已有迁移逻辑；保留兼容                                                                                     |
| Constants / 命令 ID                      | `adapters/vscode/constants.ts`                                        | 命令 / 配置 / 持久化 key 常量（**重命名**见 design）                                                           |
| Server Runtime                           | `server/src/`                                                         | Hook / AgentState / Persistence / HTTP / WebSocket                                                             |
| AgentState / Store                       | `server/src/agentStateStore.ts`、`server/src/types.ts`                | Instance 状态管理；**Spec 002** 增加 `providerProfileId` / `providerDisplayName` / `modelId` 字段（非 secret） |
| Hook Runtime                             | `server/src/hookEventHandler.ts`、`server/src/providers/hook/claude/` | Claude Code hook 事件处理                                                                                      |
| Claude Provider                          | `server/src/providers/hook/claude/claude.ts`                          | `buildLaunchCommand` **Spec 002** 扩展接受 `modelId`，输出 `--model <id>`                                      |
| Layout / Config Persistence              | `server/src/{layoutPersistence,configPersistence}.ts`                 | 用户级布局 / 配置                                                                                              |
| File Watcher                             | `server/src/fileWatcher.ts`                                           | JSONL / transcript 监听                                                                                        |
| Webview UI                               | `webview-ui/src/`                                                     | Pixel Canvas + 组件                                                                                            |
| Shared Core                              | `core/src/`                                                           | Provider 接口 / Adapter / Message / Asset Loader                                                               |
| **Spec 002 新增** ProviderProfile types  | `core/src/providerProfiles.ts`                                        | Agent-neutral Profile types + validator                                                                        |
| **Spec 002 新增** Launch Config Resolver | `server/src/launchConfig.ts`                                          | 纯函数 `resolveClaudeLaunchConfig` → env + args + safeMetadata                                                 |
| **Spec 002 新增** SecretStorage Provider | `adapters/vscode/secretStorageProvider.ts`                            | 包装 `vscode.SecretStorage`，**仅**存储 Provider secrets                                                       |
| **Spec 002 新增** ProviderProfileStore   | `adapters/vscode/providerProfileStore.ts`                             | 用 VS Code globalState 存储 non-secret Profile                                                                 |
| **Spec 002 新增** Launch Flow            | `adapters/vscode/launchAgentFlow.ts`                                  | `+ Agent` QuickPick / InputBox 流程                                                                            |
| Assets                                   | `webview-ui/public/assets/`                                           | Pixel sprite / tiles / 字体（必须保留）                                                                        |
| Build                                    | `esbuild.js` + `tsconfig.json` + `eslint.config.mjs`                  | 构建工具链                                                                                                     |

---

## 与 Claude Fleet 的关系

### 我们是 fork / 二次开发，不是重写

- Claude Fleet 仓库的代码基线就是上游 Pixel Agents 的某个 commit。
- 后续 Claude Fleet 的所有改动都在此基础上做。
- **License**：上游是 MIT；Claude Fleet 在仓库内**保留** `LICENSE`（原文），
  并新增 `THIRD_PARTY_NOTICES.md` 说明二次开发关系。
- **品牌**：产品层 brand 改为 Claude Fleet（命令 ID、displayName、UI 文案），
  但**不得**删除上游的 attribution。

### 不复用的部分

- `docs/` 顶层目录：上游有自己的 docs，但 Claude Fleet 的 `docs/` 是 ROADMAP / Spec
  的载体（参见 [`docs/specs/README.md`](../../docs/specs/README.md)）。Claude Fleet
  的 `docs/` 不被 upstream `docs/` 替换。
- `CLAUDE.md`：上游的 `CLAUDE.md` 是给上游开发者用 Claude Code 时读的，不应覆盖
  Claude Fleet 自己的 Claude 适配层。
- `README.md`：合并 Claude Fleet 的 + 上游的"原始来源"段。
- `.gitignore`：合并。
- upstream 的 `.github/`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、
  `CHANGELOG.md`、`CONTEXT.md` 等：保留（属于 upstream 资产），但**不主动改写**。

### 命名空间迁移策略

参见 [`docs/specs/001-multi-instance-runtime/design.md`](../../docs/specs/001-multi-instance-runtime/design.md)
中的"命名空间策略"表。简述：

| 类别                              | 策略                                                 |
| --------------------------------- | ---------------------------------------------------- |
| `package.json` name / displayName | 替换为 Claude Fleet                                  |
| `package.json` publisher          | **留 TBD**（不擅自发布）                             |
| Command ID（`pixel-agents.*`）    | 替换为 `claude-fleet.*`                              |
| 内部 namespace（变量 / 文件夹）   | 替换为 `claude-fleet.*`                              |
| Persistence namespace             | **保留上游 key** 作为 fallback，避免破坏已有用户状态 |
| Config keys                       | 替换为 `claudeFleet.*`，**保留**旧 key 作为 fallback |
| Logs / Debug channel              | 替换为 `Claude Fleet`                                |
| LICENSE 文本 / 原作者版权         | **不可改**                                           |
| THIRD_PARTY_NOTICES               | 新增                                                 |

---

## 更新本文件

每次"重新同步 upstream"或第一次正式 baseline 导入完成后，必须：

1. 更新上面的 **Commit SHA** 与 **Version**；
2. 校对"当前计划复用的模块"是否仍然准确；
3. 校对"不复用的部分"是否仍然准确；
4. 在 commit message 或 PR 描述里说明 upstream SHA 的变化。
