# 006-branding-discovery-migration — Tasks

> 按序执行；完成后打勾。

## T1. 品牌 grep 盘点

- [ ] `git grep -n -i "pixel.agents"` 等四组 grep，产出 A/B/C/D 分类清单
      （存档到实现 commit message / handoff）。

## T2. A 类用户可见改名

- [ ] webview / panel title / 命令标题 / log 前缀 / 错误消息
      "Pixel Agents" → "Claude Fleet"（排除 D 类 attribution）。
- [ ] README / CHANGELOG 产品名更新（Attribution 段保留）。

## T3. C 类核心符号改名

- [ ] `PixelAgentsViewProvider.ts` → `ClaudeFleetViewProvider.ts`
      （类名 + import + 注册点全部更新）。
- [ ] `PIXEL_AGENTS_DEBUG` → `CLAUDE_FLEET_DEBUG ?? PIXEL_AGENTS_DEBUG`
      （legacy fallback 标注）。

## T4. 状态路径迁移（FR-003/004）

- [ ] 新模块 `server/src/migrateStateDir.ts`（幂等 / 失败安全 /
      no secret / 保留 old）+ 单测。
- [ ] fileStateAdapter / layoutPersistence / configPersistence /
      claudeHookInstaller 路径改 `~/.claude-fleet/`。
- [ ] hook installer：识别并替换 legacy pixel-agents hook entry，
      保留用户其他 hooks；单测覆盖。
- [ ] 迁移单测：old→new、幂等、new 存在 no-op、失败保留 old。

## T5. Discovery Upsert（FR-006~009）

- [ ] Discovery 按 sessionId upsert（已有 sessionId 则更新不新建）。
- [ ] Fleet launch 登记 managedByFleet + provider 映射（005 提供字段）。
- [ ] 外部 agent：Provider External/Unknown、Managed No。
- [ ] 单测：rediscovery upsert、外部 adoption、同 session 重启不重复、
      switch provider 不重复、unknown provider 显示。

### T5.1 Codex CLI session discovery

- [x] 扫描 `~/.codex/sessions/**/*.jsonl` 的 `session_meta` 与有界事件尾部。
- [x] 按当前 workspace `cwd` 过滤，提取 session/model/provider/状态，禁止把 Codex
      envelope 送入 Claude transcript parser。
- [x] 外部 Codex session 以只读、secret-free AgentState 投影出现，并覆盖 scanner 单测。
- [x] 外部 Codex 投影关闭后遵守 dismissal cooldown，避免下一轮扫描立即复活。

## T6. UI 字段

- [ ] Agent 卡片：Session 短 ID、Managed（Fleet/External）、
      Provider 显示（External/Unknown 或 profile 名）。

## T7. Brand asset migration and extension icon

- [x] 新 Logo（科幻舰队原画 1254×1254）→ `assets/branding/claude-fleet-key-art.png`。
- [x] 派生 Extension icon 512×512 → `assets/branding/icon.png`（lanczos 缩放）。
- [x] `package.json` icon → `assets/branding/icon.png`；旧根目录 `icon.png` 删除。
- [x] `assets/branding/README.md` 品牌索引；README 顶部加入 key art（720px）。
- [x] `.vscodeignore` 确认 icon 打包包含（不排除 assets/）。

## T8. 验证

- [ ] `git grep -n -i "pixel.agents"` 剩余命中仅限：attribution /
      migration 代码 / legacy 兼容 / 历史文档。
- [ ] 确认无 `PixelAgentsViewProvider` / `PIXEL_AGENTS_DEBUG` /
      新写入 `~/.pixel-agents` / UI 的 Pixel Agents 品牌。
- [ ] check-types / lint / test / build 全绿。
