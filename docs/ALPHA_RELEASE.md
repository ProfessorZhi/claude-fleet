# ALPHA_RELEASE.md — v0.1 Alpha Release 状态

> 当前版本状态：**Code Complete / Awaiting Manual GUI Smoke Test**
> （等待用户手动 GUI 测试，**尚未 Released**）。

## 当前状态（2026-08-08）

| 项                   | 状态                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Code Complete        | ✅ 001–004 实现完成                                                                                          |
| Automated Validation | ✅ check-types / lint / build 通过；unit tests 通过（4 个已知 Windows mock-claude spawn 环境失败与改动无关） |
| VSIX Packaged        | ✅ `release/claude-fleet-0.1.0.vsix`                                                                         |
| Manual GUI Test      | ⏳ **PENDING** — 用户本人执行，清单见 [`MANUAL_TEST_ALPHA.md`](./MANUAL_TEST_ALPHA.md)                       |
| GitHub Release       | ⏳ PENDING — 手动测试通过后再 tag + Pre-release + 上传 VSIX                                                  |
| Marketplace          | ⏳ PENDING — 未发布                                                                                          |

## 状态机

```text
Code Complete
  → Automated Validation Complete
  → VSIX Packaged
  → [用户手动 GUI 测试通过]
  → GitHub Pre-release（tag v0.1.0-alpha.N + 上传 release/claude-fleet-0.1.0.vsix）
  → Marketplace Publish
```

**下一轮（手动测试通过后）该做什么**：`git tag v0.1.0-alpha.1` →
`gh release create`（Pre-release）→ 上传 VSIX。**手动测试通过前不要创建 Release。**

## 本版本范围

- 001 multi-instance-runtime — ✅
- 002 provider-model-isolation — ✅
- 003 instance-status — ✅（Alpha scope）
- 004 minimal-control-ui — ✅（Alpha scope）

不在此版本：Codex / Gemini / Antigravity 支持、Marketplace 发布、Pixel UI 重构。

## Release Blocker 记录

- Restart 使用**原始 Repo cwd**（不再从 transcript projectDir 推导）——已修复，
  见 commit `fix: preserve repo cwd across agent restart`。
- Legacy persisted state（无 `cwd` 字段）兼容，Restart 仅对 legacy 走
  projectDir fallback。
