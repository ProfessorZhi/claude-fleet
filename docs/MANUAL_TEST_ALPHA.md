# Claude Fleet v0.1 Alpha Manual Smoke Test

> 给用户的手动测试清单。测试前先确认已打包最新 VSIX
> （`release/claude-fleet-0.1.0.vsix`），且本机 `claude` CLI 可用
> （`claude --version`）。

## 安装

```text
VS Code
→ Extensions（Ctrl+Shift+X）
→ ⋯（更多操作）
→ Install from VSIX...
→ 选择 release/claude-fleet-0.1.0.vsix
→ 等待安装完成，重载窗口
```

## 测试清单

- [ ] 1. Claude Fleet Panel 打开（命令面板 `Claude Fleet: Show Panel`，
      或点击 Activity Bar 的 Claude Fleet 图标）
- [ ] 2. New Agent（`Claude Fleet: New Agent…`）→ 选择 Repo → 启动成功
- [ ] 3. Inherit Provider（内置 "Anthropic (Inherit)"）正常启动一个 Agent
- [ ] 4. Custom Provider（`Manage Providers…` 创建 → New Agent 选择）正常启动
- [ ] 5. 创建两个 Agent（各自选择不同 Repo）
- [ ] 6. 两个 Agent Provider / Model 不同（Debug View 卡片显示各自
      Repo / Provider / Model / Status）
- [ ] 7. Focus（点击 Agent 角色，或 `Claude Fleet: Focus Agent` →
      对应 Terminal 被聚焦）
- [ ] 8. Restart（Debug View 卡片 `Restart` 按钮，或
      `Claude Fleet: Restart Agent`）
- [ ] 9. Stop（Debug View 卡片 `Stop` 按钮，或 `Claude Fleet: Stop Agent` →
      Terminal 真正关闭，其他 Agent 不受影响）
- [ ] 10. Missing Secret fail-closed（删除某 Custom Provider 的 Secret 后
      Restart 该 Agent → 启动被拒绝并提示，不产生半个 Agent）

## Restart 特别检查（本轮 cwd 修复的关键验证）

- [ ] Restart 后 Repo 仍然是原来的 Repo（不是 `~/.claude/projects/...`）
- [ ] Restart 后 Provider 不变
- [ ] Restart 后 Model 不变
- [ ] Restart 会生成新 Session（不恢复旧对话）

## 回归检查（可选）

- [ ] 重载窗口后 Agent 状态恢复（Persist / Restore）
- [ ] 旧版本（无 cwd 字段）persisted state 不 crash
