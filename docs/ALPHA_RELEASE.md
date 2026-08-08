# ALPHA_RELEASE.md — v0.1 Alpha Release 状态

> 当前版本状态：**Implementation Complete / Awaiting Extension Development Host Manual Test**
> （等待用户手动 Development Host 测试，**尚未 Released**）。

## 当前状态（2026-08-08）

| 项                           | 状态                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Implementation               | ✅ 001–006 实现完成（005 Provider Registry & Session Continuity；006 Branding & Discovery Migration）                  |
| Automated Validation         | ✅ check-types / lint / build 通过；472/476 unit tests 通过（4 个已知 Windows mock-claude spawn 环境失败，与改动无关） |
| Development Host Manual Test | ⏳ **PENDING** — 用户本人执行（F5 → Run Extension），清单见 [`MANUAL_TEST_ALPHA.md`](./MANUAL_TEST_ALPHA.md) 阶段一    |
| VSIX Packaging               | 🔒 **BLOCKED until Development Host test passes**                                                                      |
| GitHub Release               | ⏳ PENDING                                                                                                             |
| Marketplace                  | ⏳ PENDING                                                                                                             |

## VSIX 状态

> ⚠️ **`release/claude-fleet-0.1.0.vsix` 是 STALE — previous build（005/006 开发前）。**
> 不要用于当前手动测试。Development Host 测试通过后重新 `npm run vsix` 生成新包。

## 状态机

```text
Implementation Complete
  → Automated Validation Complete
  → [用户 Extension Development Host 手动测试通过]
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
- Restart 默认 **Resume 原 Session**（Claude Code 原生 `--resume`），不再默认 fresh session（005）。
- Provider 注入失败（用户无官方账号时落入 Claude 官方 Login 选择）→ 视为 **BLOCKER**，见 MANUAL_TEST Test 7。
