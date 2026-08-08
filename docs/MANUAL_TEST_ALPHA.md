# Claude Fleet v0.1 Alpha Manual Smoke Test

> 给用户的手动测试清单。本机需已安装 Claude Code CLI（`claude --version`）。

## 阶段一：Development Host Smoke Test（F5，不依赖 VSIX）

> 当前 VSIX 为 **STALE**（005/006 开发前的旧包），不要用于测试。
> 使用 VS Code Extension Development Host 加载当前源码。

```text
1. 打开 claude-fleet 仓库（F:\funny_project\Claude Fleet）
2. 终端运行 npm run build
3. VS Code：
   Run and Debug
   → Run Extension
   → F5
4. 新窗口（Extension Development Host）：
   Activity Bar → Claude Fleet 图标 / 命令面板 → Claude Fleet: Show Panel
```

### Test 1 — Branding

- [ ] VS Code Panel 名字是 Claude Fleet
- [ ] Command Palette 搜索 Claude Fleet
- [ ] 没有用户可见 Pixel Agents
- [ ] Logs / errors 正常使用 Claude Fleet

### Test 2 — Empty State

- [ ] Claude Fleet Panel 正常加载
- [ ] Pixel Office 正常
- [ ] 没 Agent 时 Empty State 正常

### Test 3 — Provider Registry

- [ ] New Agent 不直接显示 Anthropic Inherit
- [ ] 提示 No Provider Profiles configured
- [ ] 有 Add Provider
- [ ] Manage Providers 能看到 Add Provider 与支持的 Provider definitions

### Test 4 — Add DeepSeek

- [ ] Add Provider → DeepSeek → 输入 Profile Name → 输入 API Secret
- [ ] Secret 输入时不显示
- [ ] 保存成功
- [ ] New Agent Provider Picker 出现 DeepSeek Profile

### Test 5 — Anthropic visibility

- [ ] 未配置 Anthropic Account 时，New Agent 中不出现 Anthropic Account
- [ ] Add Provider 页面可以出现 Anthropic Account（可配置渠道）

### Test 6 — Start Native Claude

- [ ] 选择 Repo + DeepSeek Profile + Model + New Session → Launch
- [ ] 出现**原生 Claude Code Terminal**（不是 Fleet 模拟聊天 UI）

### Test 7 — No Anthropic Login

- [ ] 配置正确的 DeepSeek Profile 启动后**不出现**：

```text
Welcome to Claude Code
Select login method
1 Claude account
2 Anthropic Console
3 third-party platform
```

- [ ] 直接进入原生 Claude Code

> 如果仍然出现 → **BLOCKER — Provider credential injection failed**，停止后续测试并回报。

### Test 8 — Native Claude behavior

- [ ] Claude Code TUI 是原生的
- [ ] /help 能用
- [ ] 原生 commands 能用
- [ ] CLAUDE.md 正常
- [ ] MCP / Skills 不受影响

### Test 9 — Two Providers

- [ ] 配置 DeepSeek + MiniMax 两个 Profile，启动两个 Agent
- [ ] 同时存在、Provider 显示不同、Model 显示不同、两个 Terminal 独立

### Test 10 — Auto Discovery

在另一个普通 Terminal 手动运行 `claude`：

- [ ] Claude Fleet 自动发现
- [ ] Pixel Office 出现 Agent
- [ ] Managed = External
- [ ] Provider 无法可靠识别时显示 Unknown

### Test 11 — Restart Conversation

Fleet Agent 中问一句话 → 得到回答 → Restart：

- [ ] same Repo
- [ ] same Session
- [ ] previous conversation still exists

### Test 12 — Switch Provider

DeepSeek → Switch Provider → MiniMax：

- [ ] Repo 不变
- [ ] Session 不变
- [ ] previous conversation remains
- [ ] Provider 更新、Model 更新

> 若 Claude Code 拒绝 Resume：必须出现明确错误，**不能**静默 new session。

---

## 阶段二：VSIX 安装测试（Development Host 通过后）

> 只有阶段一全部通过后，才执行 `npm run vsix` 并安装新包测试。

```text
VS Code
→ Extensions（Ctrl+Shift+X）
→ ⋯（更多操作）
→ Install from VSIX...
→ 选择 release/claude-fleet-0.1.0.vsix
→ 重载窗口
```

- [ ] 安装后 Panel / New Agent / Provider 流程与阶段一一致
- [ ] Restart 后 Repo 仍然是原来的 Repo（不是 `~/.claude/projects/...`）
- [ ] Restart 后 Provider / Model 不变
- [ ] Restart 会生成新 Session（当用户选择 New Session 时）
- [ ] Missing Secret fail-closed（删除某 Provider Secret 后 Restart → 启动被拒绝并提示）
- [ ] 重载窗口后 Agent 状态恢复（Persist / Restore）
- [ ] 旧版本（无 cwd 字段）persisted state 不 crash
