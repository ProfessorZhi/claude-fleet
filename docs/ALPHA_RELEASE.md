# ALPHA_RELEASE.md — v0.1 Alpha Release 状态

> 当前版本状态：**READY FOR MANUAL VSIX ACCEPTANCE**
> （Windows 自动验证与真实 Claude Dev Host launch smoke 已完成；等待用户安装 VSIX 做最终人工验收）。

## 当前状态（2026-08-09）

| 项                           | 状态                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation               | ✅ 001–006 实现完成（005 Provider Registry & Session Continuity；006 Branding & Discovery Migration）                                                 |
| Automated Validation         | ✅ check-types / lint / format / build；server 498 + webview 70 tests；package contract + npm verify 通过；VSIX inventory + extension-host smoke 通过 |
| Windows E2E                  | ✅ Extension Host 69/69 across 3 shards；standalone 8 项因本机缺少 Playwright Chromium 未运行（不在 Extension Alpha contract）                        |
| Real Claude Dev Host Smoke   | ✅ resolver → `claude.cmd` → `Claude Code #1` → real `claude.exe` process；trust prompt 不自动化                                                      |
| Development Host Manual Test | ✅ 最小真实 launch 已通过；完整人工清单仍留给 VSIX acceptance                                                                                         |
| VSIX Packaging               | ✅ 已重新生成 `release/claude-fleet-0.1.0.vsix`，等待用户安装验收                                                                                     |
| GitHub Release               | ⏳ PENDING                                                                                                                                            |
| Marketplace                  | ⏳ PENDING                                                                                                                                            |

## VSIX 状态

> `release/claude-fleet-0.1.0.vsix` 已由本轮最终源码重新生成。用户安装前应确认文件时间戳与本轮构建一致。

## 状态机

```text
Implementation Complete
  → Automated Validation Complete
  → Real Claude Dev Host Smoke Complete
  → VSIX Packaging（npm run vsix 覆盖旧包）
  → [VSIX 安装测试通过]
  → GitHub Pre-release（tag v0.1.0-alpha.N + 上传 VSIX）
  → Marketplace Publish
```

**Development Host 测试通过前：不打包 VSIX、不创建 Release。**

## 本版本范围

- 001 multi-instance-runtime — ✅
- 002 provider-model-isolation — ✅
- 003 instance-status — ✅（Alpha scope）
- 004 minimal-control-ui — ✅（Alpha scope）
- 005 provider-registry-session-continuity — ✅（本轮新增：ProviderDefinition≠Profile、New Agent 只显示 configured、Restart=Resume、Switch Provider、CLI providers/launch）
- 006 branding-discovery-migration — ✅（本轮新增：PixelAgents→ClaudeFleet 品牌、~~/.pixel-agents→~~/.claude-fleet 迁移、Discovery upsert、Branding assets）

不在此版本：Codex / Gemini / Antigravity 支持、Marketplace 发布、Pixel Office 前端重构。

## Release Blocker 记录

- Restart 使用**原始 Repo cwd**（不再从 transcript projectDir 推导）——已修复（`fix: preserve repo cwd across agent restart`）。
- Restart 默认 **Resume 原 Session**（Claude Code 原生 `--resume`），New Session 才创建 fresh session（005）。
- Provider 注入失败（用户无官方账号时落入 Claude 官方 Login 选择）→ 视为 **BLOCKER**，见 MANUAL_TEST Test 7。
