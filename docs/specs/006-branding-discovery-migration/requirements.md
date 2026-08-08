# 006-branding-discovery-migration — Requirements

> Feature slug：`006-branding-discovery-migration`  
> 依赖：001（runtime）、005（provider registry，共享 Session/Discovery 语义）  
> 阻塞：无

---

## 目标（Goal）

完成 Pixel Agents-derived 实现 → **Claude Fleet 产品**的品牌迁移：

1. 用户可见的 "Pixel Agents" 全部改为 "Claude Fleet"；
2. 核心内部类名 / 路径 / 环境变量改为 Claude Fleet（保留 legacy 兼容）；
3. `~/.pixel-agents` 状态安全迁移到 `~/.claude-fleet`（幂等、失败安全）；
4. **Auto Discovery 完整保留并升级**：Fleet managed / CLI launched / 外部
   Claude 全部进入统一 Discovery，Restart / Switch 后不重复（upsert）；
5. 上游 MIT attribution 完整保留。

---

## 用户故事（User Stories）

- **US-1 干净品牌** —— 我在 UI、日志、命令、帮助文本中看到的都是
  "Claude Fleet"，看不到 "Pixel Agents"（除 attribution）。
- **US-2 外部 Claude 也能被看到** —— 我在普通终端手动运行 `claude`，
  Fleet 仍能发现并显示它（Provider: External / Unknown, Managed: No），
  不猜 Provider。
- **US-3 不重复** —— 我 Restart / Switch Provider 后，同一个 Session 在
  Pixel Office 中不出现两个 Agent。
- **US-4 迁移无感** —— 升级后我的旧状态还在（`~/.pixel-agents` →
  `~/.claude-fleet` 自动迁移，旧文件保留）。

---

## 功能性需求（Functional Requirements）

### FR-001 用户可见品牌

Extension UI / logs / commands / errors / help text / Debug View /
webview 中不得再显示 "Pixel Agents" 品牌（允许：attribution、
migration/legacy 兼容代码、历史文档）。

### FR-002 核心类与路径改名

- `PixelAgentsViewProvider` → `ClaudeFleetViewProvider`（文件名同步改）；
- `PIXEL_AGENTS_DEBUG` → `CLAUDE_FLEET_DEBUG`（保留
  `CLAUDE_FLEET_DEBUG ?? PIXEL_AGENTS_DEBUG` legacy fallback）；
- 用户可感知的 namespace / command id / log 前缀改为 claude-fleet；
- 不为了彻底改名做大重构；但核心产品类不得继续叫 PixelAgents。

### FR-003 状态路径迁移

- Fleet 自己创建的数据：`~/.pixel-agents/` → `~/.claude-fleet/`
  （config.json / hooks/claude-hook.js / layout.json 等）；
- 迁移要求：copy/read old → write new atomically；失败不破坏旧文件；
  不 log secret；幂等（重跑不重复、不循环）；成功后保留 legacy 文件
  一段时间，不强制删除用户旧状态。

### FR-004 Legacy Hook 迁移

- 旧 `~/.pixel-agents/hooks/claude-hook.js` → 新
  `~/.claude-fleet/hooks/claude-hook.js`；
- Claude settings.json 中的旧 Pixel hook entry 必须能被识别；
  安装 Fleet hook 时只 remove/replace 我们的 legacy entry，
  **不得删除用户其他 hooks**。

### FR-005 Attribution 保留

- `LICENSE` / `THIRD_PARTY_NOTICES.md` / README Attribution / Git History
  必须继续写明：
  "Based on Pixel Agents, Copyright (c) 2026 Pablo De Lucca, MIT License"。

### FR-006 Auto Discovery 一等公民（继承上游全部能力）

完整保留并审查：

- global session scanner / `getAllSessionRoots` / `ensureProjectScan`；
- external agent adoption / dismissal tracker / restore agents / JSONL watcher。

统一 Discovery 语义：

- Fleet managed agent（Fleet 启动）；
- 用户外部 Terminal 手动运行的 Claude Code；
- Fleet CLI 启动的 Claude Code；

全部被发现并显示在 Pixel Office。

### FR-007 外部 Agent 不猜 Provider

外部（非 Fleet 启动）agent 无法可靠知道 process env 的
Provider → 显示 `Provider: External / Unknown`、`Managed: No`。禁止猜。

### FR-008 Fleet Managed 识别 Provider

Fleet 自己启动时建立 `sessionId → providerProfileId` 持久映射；
Auto Discovery 重新发现同一 Session 时恢复
`Provider / Model / Managed By Fleet`，不重新变 Unknown。

### FR-009 去重（upsert / reattach）

- Restart / Resume 后 scanner 再看到 S1：**upsert 现有 Agent**，不新建；
- Switch Provider 后（MiniMax→DeepSeek）仍是 Agent S1，只更新
  Provider / Model / TerminalRef / Status；
- 同一 Session 唯一。

---

## 非功能性需求（Non-Functional Requirements）

- **NFR-1** 迁移幂等：重复执行无副作用。
- **NFR-2** 失败安全：任何一步失败保留旧数据，可重试。
- **NFR-3** 不 log secret。
- **NFR-4** 不删除用户旧状态（legacy 保留期≥本 Alpha 周期）。

---

## 不在范围内（Out of Scope）

- 重写上游 scanner / watcher 架构（只保留 + 去重增强）。
- 删除上游代码的历史 commit / attribution。
- 其他 Coding Agent 的 Discovery。

---

## 开放问题（Open Questions）

- `~/.pixel-agents` 保留多久 —— 暂定保留到 v0.2 或用户确认可删；
  迁移状态在 `~/.claude-fleet/migration.json` 记录。
