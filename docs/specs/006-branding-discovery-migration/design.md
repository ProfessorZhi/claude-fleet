# 006-branding-discovery-migration — Design

> Context：[requirements.md](./requirements.md)；ADR-007（Discovery 一等公民）、
> ADR-008（~/.pixel-agents → ~/.claude-fleet 迁移）。

---

## 高层形态

```text
Branding
├── 用户可见字符串      → 全部 Claude Fleet（webview/log/命令/错误/文档）
├── 核心符号            → ClaudeFleetViewProvider、CLAUDE_FLEET_DEBUG(legacy fallback)
├── 状态路径            → ~/.claude-fleet/（migration from ~/.pixel-agents）
└── Attribution         → 保留 Pixel Agents (MIT, Pablo De Lucca)

Discovery
├── Global Session Scanner（上游保留）
├── External Adoption（上游保留）
├── Codex Session Scanner（~/.codex/sessions，workspace-scoped）
├── Fleet launch 登记 sessionId→provider 映射（005 提供）
├── Upsert：按 sessionId 去重（restart/switch 后不重复）
└── 外部 agent → Provider: External/Unknown, Managed: No
```

## 核心决策

### D1. 改名清单（FR-001/002）

按 grep 结果分类（实现时逐条执行）：

- **A. 用户可见**：webview 字符串、log 前缀、错误消息、命令标题
  （`Pixel Agents:` → `Claude Fleet:`）、panel title、README/CHANGELOG
  产品名 —— 全部改。
- **B. Fleet 自有 namespace/path**：`~/.pixel-agents/` → `~/.claude-fleet/`；
  `pixel-agents.*` globalState keys（如无用户兼容需求则直接改，有则
  迁移/别名）。
- **C. 内部 code symbol**：`PixelAgentsViewProvider` → `ClaudeFleetViewProvider`
  （文件同步改名）；`PIXEL_AGENTS_DEBUG` → `CLAUDE_FLEET_DEBUG`（读时
  `process.env.CLAUDE_FLEET_DEBUG ?? process.env.PIXEL_AGENTS_DEBUG`，
  标注 legacy fallback）。其余不影响产品的 symbol 不做大规模改名
  （避免无谓 diff，保留上游同步性）。
- **D. Third-party attribution**：LICENSE / THIRD_PARTY_NOTICES.md /
  README Attribution / .agent/references/pixel-agents.md —— **保留不动**。

### D2. 状态路径迁移（FR-003）

新状态根：`~/.claude-fleet/`（`os.homedir()` 解析）。

迁移器（新模块 `server/src/migrateStateDir.ts`，纯函数 + fs）：

```text
migrateStateDir(oldDir, newDir, log):
  1. old 不存在 → no-op（幂等）
  2. new 存在 → no-op（幂等；不覆盖新状态）
  3. 复制 old 树 → new（递归 copy，排除已知大缓存目录）
  4. copy 成功后写 new/migration.json { from, at, fileCount }
  5. 任何失败：不删除 old，返回失败；可重试
  6. 成功：保留 old（不删除）
```

- hook 脚本复制后，旧 `~/.claude/settings.json` 中指向
  `~/.pixel-agents/hooks/claude-hook.js` 的 entry：安装新 hook 时
  **替换为指向 `~/.claude-fleet/hooks/claude-hook.js`**；若 entry 非我们
  的（路径不匹配 pixel-agents hooks），一律保留（FR-004）。
- `fileStateAdapter` 的 `stateFilePath` 从 `~/.pixel-agents/agents.json`
  迁移到 `~/.claude-fleet/agents.json`；`layoutPersistence`、
  `configPersistence`、`claudeHookInstaller` 同步。

### D3. Discovery 保留 + Upsert（FR-006/007/008/009）

- 保留上游 `startProjectScan` / `startExternalScanning` / JSONL watcher /
  dismissal tracker / restore 逻辑，**不重写**。
- 新增去重增强：AgentState 增加持久化 `sessionId` 索引（005 已有
  sessionId 字段）；Discovery 命中已存在 `sessionId` 的 agent 时：
  - 若 store 已有该 sessionId → **upsert 现有 Agent**（更新
    terminalRef / status / provider / model），不新建 id；
  - 若没有 → 按现状新建。
- Fleet launch 的 instance：`managedByFleet=true` + `providerProfileId`
  持久化（005）；rediscovery 时恢复，不落回 Unknown。
- 外部 agent：`managedByFleet` 不设置 → UI 显示
  `Provider: External / Unknown`、`Managed: No`。
- Codex CLI 没有 Claude hooks 协议，因此单独读取 `session_meta` 和有界事件尾部，
  只生成安全状态投影；不解析 prompt/response，也不把 Codex envelope 当 Claude JSONL。
- 去重 key = `sessionId`（唯一）；无 sessionId 的兜底 = 既有 jsonlFile
  key（现状）。

### D4. UI 变更（FR-001/006/008）

- Debug View Agent 卡片新增字段：`Session`（短 ID）、`Managed`
  （Fleet / External）；Provider 显示
  `External / Unknown` 或 profile 显示名。
- webview/panel 标题与空状态文案改为 Claude Fleet。

---

## 模块职责

| 模块                                           | 职责                                     | 位置                                                |
| ---------------------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| migrateStateDir                                | old→new 安全迁移                         | `server/src/migrateStateDir.ts`（新）               |
| fileStateAdapter / layout / config persistence | 新路径                                   | 既有文件（路径常量改）                              |
| claudeHookInstaller                            | 新 hook 路径 + legacy entry 替换         | 既有文件（扩展）                                    |
| Discovery upsert                               | sessionId 去重                           | `agentRuntime.ts` / `fileWatcher.ts`（增强）        |
| Codex session scanner                          | Codex 外部 session 只读发现              | `server/src/providers/codex/codexSessionScanner.ts` |
| ClaudeFleetViewProvider                        | 改名                                     | `adapters/vscode/`（重命名）                        |
| DEBUG env                                      | CLAUDE_FLEET_DEBUG ?? PIXEL_AGENTS_DEBUG | `agentStateStore.ts` 等（读处）                     |

---

## 失败模式（Failure Modes）

| 场景                                          | 行为                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| old 存在、new 存在                            | no-op，不覆盖新状态                                                                                           |
| copy 中断                                     | old 保留，new 部分写入 → 下次启动检测 new 不完整（migration.json 缺失）→ 清空 new 重试（仅当 new 是我们写的） |
| settings.json hook entry 替换                 | 只替换匹配 pixel-agents hooks 路径的 entry，其余保留                                                          |
| discovery 遇同一 sessionId 但 terminal 名不同 | upsert 更新 terminalRef，不新建                                                                               |

---

## 取舍（Trade-offs）

- **保留旧状态文件**：迁移成功后不删 `~/.pixel-agents`（FR-003/NFR-4），
  用户随时可回退；成本是磁盘双份，可接受（Alpha 周期）。
- **不全局重命名**：只改用户可见 + 核心产品类；上游同步性优先于
  命名洁癖（ADR-001 的"暂不改"决策被本轮 supersede，但**仅限** A/B/C 类）。
- **upsert 按 sessionId**：sessionId 是 Claude Code 原生的稳定标识，
  比 terminal 名可靠（terminal 名随 index 变）。
