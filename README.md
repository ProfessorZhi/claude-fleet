<p align="center">
  <img src="assets/branding/claude-fleet-key-art.png" width="720" alt="Claude Fleet" />
</p>

# Claude Fleet

> **当前状态：v0.1 Alpha** — 早期测试版本。
> 在一个 VS Code 工作区里同时运行、管理多个 Claude Code 实例。

Claude Fleet 是一个本地优先的 Coding Agent Control Plane：当前以 VS Code 扩展为执行
现场，统一管理多个 **Claude Code / Codex CLI** 实例，并为未来的其他 Agent 提供统一的
Repo、Worktree、Provider、Model、Session 与 Telemetry 关联。Claude Code 仍是当前真实
Runtime 基线，Codex CLI 已具备本地登录复用和生命周期控制边界。
当前默认 Scene 是 Pixel Office，Fleet Command 作为正式可选 Scene 保留；可在 Settings
中切换当前 Scene 并设置下次打开时的默认 Scene。两者共用 Agent 生命周期、Focus、Subagent
和 Auto Discovery，Fleet Command 负责舰队控制中心投影。

基于 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)（MIT）二次开发。

---

## 核心能力

- **多 Claude Code Instance** — 同时运行多个 Agent，互不干扰
- **混合 Runtime** — New Agent 可选择 Claude Code 或 Codex CLI；Provider/Model 与角色分离
- **每 Instance 独立 Repo** — 每个 Agent 绑定自己的工作目录
- **每 Instance 独立 Provider** — 每个 Agent 可以使用不同的
  Anthropic-compatible 端点（Custom Provider）
- **每 Instance 独立 Model** — 每个 Agent 可以指定不同的 model id
- **SecretStorage 安全存储** — Provider Secret 保存在 VS Code SecretStorage，
  不进入配置 / 日志 / UI
- **Pixel 状态可视化** — 实时看到每个 Agent 在做什么
- **Fleet Telemetry** — 统一关联 Claude/Codex 事件、Session、Task 和 Usage
- **agentmetrics** — 记录 Token、时间、API-equivalent cost 和账户级 Quota 证据
- **Focus / Stop / Restart** — 聚焦 Terminal、真正停止、保留配置重启
- **Coordinator Control Plane** — Mission/WorkItem、推荐、受控分配、bounded 任务投递、
  结果回收、Token/时间/Quota 记录和只读 SCM/PR/CI 证据

## 安装

### 从 VSIX 安装（Alpha 推荐）

本地构建产物固定位于：

```text
release/claude-fleet-0.1.0.vsix
```

VS Code 命令面板 → `Extensions: Install from VSIX...` → 选择
`release/claude-fleet-0.1.0.vsix`。

或命令行：

```bash
code --install-extension release/claude-fleet-0.1.0.vsix
```

> 公开 Alpha 将发布到 **GitHub Releases**（届时从 Releases 页面下载 VSIX
> 即可）；当前版本尚未上传，请使用本地 `release/` 产物。
> 安装方式选择见 [`docs/MANUAL_TEST_ALPHA.md`](./docs/MANUAL_TEST_ALPHA.md)。

## 使用

1. **打开 Claude Fleet** — 命令面板运行 `Claude Fleet: Show Panel`
   （或点击 Activity Bar 的 Claude Fleet 图标）
2. **New Agent** — 命令面板运行 `Claude Fleet: New Agent…`
   （或点击空状态中的 `+ New Agent` 按钮）
3. **选择 Repo** — 选择 Workspace 文件夹
4. **选择 Provider** — 使用内置 "Anthropic (Inherit)"（沿用你的 Claude Code
   登录），或选择已有的 Custom Provider / 现场创建
5. **选择 Model** — 选择 Provider 默认模型或输入任意 model id
6. **Launch** — Agent 启动，默认出现在当前设置的 Scene 中（当前产品默认是 Pixel Office）；
   Fleet Command 可在 Settings 中切换或设为默认；Debug View 显示
   Repo / Provider / Model / Status

### 管理多个 Agent

| 操作                   | 方式                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Focus（聚焦 Terminal） | 点击 Agent 角色，或 `Claude Fleet: Focus Agent`                                                             |
| Stop（停止）           | Debug View 中 Agent 卡片的 `Stop` 按钮，或 `Claude Fleet: Stop Agent`                                       |
| Restart（重启）        | Debug View 中 Agent 卡片的 `Restart` 按钮，或 `Claude Fleet: Restart Agent`（保留 Repo / Provider / Model） |
| Manage Providers       | `Claude Fleet: Manage Providers…`（列出 / 创建 / 删除 Custom Provider）                                     |

### Custom Provider

Claude Fleet 支持任何 **Anthropic-compatible** 端点：

1. `Claude Fleet: Manage Providers…` → `+ Create Custom Provider…`
2. 填写 Name / Base URL / Auth Mode（API Key 或 Auth Token）/ Secret / 默认 Model ID
3. 创建后即可在 New Agent 流程中选择

删除 Custom Provider 时，对应的 Secret 会一并从 SecretStorage 删除。

## 当前边界

- Claude Code 是当前真实运行基线；Codex CLI 的真实启动依赖本机已安装并完成登录的 `codex`
  命令，缺少 CLI 时控制面会明确返回 unavailable，不会伪造成功
- Coordinator Scheduler 是显式、幂等、有上限的 `plan/tick` 执行器，不是无限后台自治循环
- 任务投递只发送 `workItemId/title/objective/acceptanceCriteria` 四个 bounded 字段，不传
  raw transcript、任意 Prompt 或 Secret
- SCM/PR/CI 适配器是只读 provider 边界；没有真实连接器或凭据时返回 unavailable
- 尚未正式发布到 VS Code Marketplace（当前通过 VSIX 分发）
- Restart 不恢复原 Claude Session（重新开启新 Session）
- 每个实例沿用你的 `~/.claude/settings.json`（含 hooks）；若其中设置了
  `env.ANTHROPIC_*`，会覆盖实例级 env（Claude Code 官方行为）
- 正式版可能需要重新安装 / 迁移状态

## 前置要求

- VS Code ≥ 1.105
- **Claude Code CLI**（使用 Claude Runtime 时，`claude` 必须在 PATH 中）：
  ```bash
  claude --version
  ```
  未安装时，New Agent / Restart 会提示：

> Claude Fleet: Claude Code CLI not found. Please install Claude Code and ensure `claude` is available in PATH.

使用 Codex Runtime 时，同理要求本机 `codex` CLI 已安装并可复用现有登录状态；不会在测试或
控制面流程中自动消耗真实 API 额度。

## 开发

```bash
npm install
npm run check-types
npm run lint
npm test
npm run build
npm run vsix      # 固定产出 release/claude-fleet-0.1.0.vsix
npm run vsix:ls   # 预览 VSIX 将包含的内容

# Mixed Claude/Codex fake control-plane contract；不启动真实 Agent
npx tsx --test e2e/contracts/mixed-control-plane.contract.test.ts

# 工作区 node_modules 存在 extraneous/invalid 时使用；不清理 node_modules
node scripts/package-vsix-portable.mjs
node scripts/verify-vsix-package.mjs release/claude-fleet-0.1.0.vsix
```

`node scripts/package-vsix-portable.mjs` 等价于本地 `vsce package
--no-dependencies`，用于生成不携带 `node_modules` 的 VSIX。普通
`npm run vsix` / `npm run vsix:ls` 仍保留为常规入口，但可能受工作区依赖
树的 extraneous/invalid 状态影响。

## 许可证与 Attribution

- Claude Fleet 基于 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)
  （MIT，Copyright (c) 2026 Pablo De Lucca）二次开发
- 详见 [`LICENSE`](./LICENSE) 与 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)
