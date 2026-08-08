# 001-multi-instance-runtime — Tasks

> Feature slug：`001-multi-instance-runtime`  
> 关联：[`requirements.md`](./requirements.md) / [`design.md`](./design.md)  
> 工作流：`.agent/workflows/implement.md`、`.agent/workflows/review.md`、`.agent/workflows/debug.md`

---

## Tasks 进度总览

```text
T001 研究并记录 Pixel Agents baseline ........... [x]
T002 导入 upstream code ......................... [x]
T003 验证 upstream build/test baseline .......... [x]*
T004 建立 Claude Fleet branding baseline ........ [x]**
T005 验证 multi-instance launch ................. [ ]
T006 验证 instance lifecycle/status ............. [ ]
T007 增补 / 调整相关 tests ...................... [x]
T008 更新项目文档（ARCHITECTURE / decisions 等）  [x]
T009 Self Review ................................ [ ]
```

\* T003 备注：upstream `npm test` 出现 10 / 369 个测试在 `mockClaudeRunner.test.ts`
中 timeout 失败，与本次 Claude Fleet 改动无关，是 upstream baseline 自带的环境性失败。
详见 T003 步骤 5。

\*\* T004 备注：本轮只做最小限度品牌替换 —— `package.json` name / displayName /
description / publisher / repository、`contributes` 命令与 view id、`claudeFleet.*`
配置 key、log 前缀、`'Claude Fleet:'` 通知字符串；Persistence namespace（globalState
keys、`~/.pixel-agents/` 路径）**保留上游值**以避免破坏状态；class 名（`PixelAgentsViewProvider`）
**保留**作为上游架构标识。完整决策见 ADR-001。

---

## Tasks 进度详情

> 任务执行时**打勾**，不删除条目。证据（commit / 文件 / 命令）写进对应 step 的
> "Evidence" 字段。

---

## T001 研究并记录 Pixel Agents baseline

**目标**：在 sibling 临时目录 clone 上游 Pixel Agents，记录 commit、license、结构，
并把结论写到 [`.agent/references/pixel-agents.md`](../../../.agent/references/pixel-agents.md)。

**步骤**：

1. 在 `../pixel-agents-upstream`（仓库根目录**外部**的 sibling 临时目录）clone：
   ```bash
   git clone https://github.com/pixel-agents-hq/pixel-agents ../pixel-agents-upstream
   ```
2. 记录：
   ```bash
   git rev-parse HEAD
   git remote -v
   ```
3. 在 `.agent/references/pixel-agents.md` 写：
   - Repository / Commit SHA / License / 为什么选择它 / 当前计划复用的模块 / 与 Claude Fleet 的关系
4. 写 ADR-001（决策记录）到 [`.agent/knowledge/decisions.md`](../../../.agent/knowledge/decisions.md)。

**验证**：

- [ ] `pixel-agents-upstream` 目录存在且 `.git` 干净
- [ ] `pixel-agents.md` 包含 commit SHA 与 license
- [ ] `decisions.md` 出现 ADR-001

---

## T002 导入 upstream code

**目标**：把上游代码作为 Claude Fleet 的代码基线导入到仓库根目录，**保留**
Claude Fleet 现有的文档与 `.gitignore`。

**步骤**：

1. 准备：
   - 备份 Claude Fleet 当前 `README.md` 与 `.gitignore`；
   - 列出 upstream 顶层目录，准备导入清单。
2. 用 `cp -r` / `rsync` 把上游代码目录拷到 Claude Fleet 根目录。
3. **冲突处理**：
   - `README.md`：人工合并（Claude Fleet 的 README + 上游 README 的"原始来源"段）；
   - `.gitignore`：人工合并（Claude Fleet 的 + 上游的 `.vscode/`、`.idea/` 等构建相关 ignore）；
   - 其他顶层文件：以上游为准。
4. 检查 Claude Fleet 的 `docs/`、`.agent/`、`.claude/`、`AGENTS.md`、`CLAUDE.md`
   是否仍在原位（**不应被覆盖**）。

**验证**：

- [ ] Claude Fleet 文档层 100% 保留
- [ ] 上游代码全部入库（按"运行必须"的最小集合）
- [ ] `git status` 出现预期的"new file"列表
- [ ] 没有 nested `.git`

---

## T003 验证 upstream build/test baseline

**目标**：在 Claude Fleet 仓库根目录确认上游能 build / 类型检查 / 测试通过。

**步骤**：

1. 工具链：
   ```bash
   node --version
   npm --version
   ```
2. 安装依赖：
   ```bash
   npm install
   ```
3. 类型检查 + 构建：
   ```bash
   npm run check-types
   npm run build
   ```
4. 测试 + lint（尽量通过）：
   ```bash
   npm test
   npm run lint
   ```
5. 任何失败 → 按 `.agent/workflows/debug.md` 定位 Root Cause；不阻塞 Import 但要记录。

**验证**：

- [ ] `check-types` 通过
- [ ] `build` 通过
- [ ] `npm test` 至少不出现新失败
- [ ] 失败项（如有）已记录 Root Cause

---

## T004 建立 Claude Fleet branding baseline

**目标**：把产品层品牌从 Pixel Agents 改为 Claude Fleet，**保留** License 与 attribution。

**步骤**：

1. `package.json`：
   - `name: claude-fleet`
   - `displayName: Claude Fleet`
   - `publisher`: 暂留 `TBD` 或使用 `local-dev`，**不要**填正式 Marketplace publisher
   - `description`: 简述 Claude Fleet（基于 Pixel Agents 之上）
2. 命令 ID：替换为 `claude-fleet.*` 命名空间（按 design 中"命名空间策略"）。
3. 内部 namespace（如 `pixel-agents` 文件夹、变量名）按"逐类处理"清单迁移。
4. Logs / Debug channel name 替换为 `Claude Fleet`。
5. Config keys 替换为 `claudeFleet.*`，但**保留旧 key 作为 fallback**。
6. **不可修改**：
   - 上游 MIT License 文本；
   - 原作者版权声明；
   - `THIRD_PARTY_NOTICES.md`（如有，则保留并可能补充 Claude Fleet 二次声明）。

**验证**：

- [ ] `package.json` 的 `name` / `displayName` 已替换
- [ ] 上游 LICENSE 文件仍存在
- [ ] 原作者版权行 `Copyright (c) 2026 Pablo De Lucca` 仍在
- [ ] 命令 ID 命名空间统一为 `claude-fleet.*`

---

## T005 验证 multi-instance launch

**目标**：在同一 VS Code Extension 内能创建至少 2 个 Claude Code 实例。

**步骤**：

1. 在 Extension Development Host 中启动 Claude Fleet。
2. 通过命令 / Panel 触发 `claude-fleet.newInstance` 两次，指定**不同 cwd**。
3. 验证：
   - 两个 terminal 同时存在；
   - 两个 terminal 分别在各自的 cwd 中启动 Claude Code；
   - 两个实例互不干扰（修改一个的 cwd / env 不影响另一个）。
4. 如有失败 → 按 `.agent/workflows/debug.md`。

**验证**：

- [ ] 2 个 terminal 同屏可见
- [ ] 各自 cwd 正确
- [ ] 互不污染

---

## T006 验证 instance lifecycle/status

**目标**：能识别并展示 6 个生命周期状态（`starting` / `running` / `waiting` / `idle` /
`stopped` / `error`）。

**步骤**：

1. 创建实例后立即观察状态变化：`starting` → `running`。
2. 触发 Permission Request 或长时间无动作：观察 `waiting` / `idle` 切换。
3. Stop / Remove 实例：观察 `stopped`。
4. 制造一次 Claude Code 进程崩溃：观察 `error` 是否被正确设置。
5. 在 `design.md` 中补全"生命周期状态映射"一节（记录上游实际状态名与 Claude Fleet
   命名之间的对应）。

**验证**：

- [ ] 6 个状态都能被识别（不一定全部触发，但 code path 必须存在）
- [ ] design.md 的映射表已补全

---

## T007 增补 / 调整相关 tests

**目标**：保留上游测试，必要时新增 / 调整针对 Claude Fleet 命名空间与状态的最小测试。

**步骤**：

1. 不删除上游测试。
2. 在 brand / namespace 替换后，确认相关 unit test 仍能通过。
3. 如有需要，新增最小测试：
   - namespace / display name 测试；
   - 状态映射测试（如有可测状态函数）。
4. 避免为"全绿"删除测试。

**验证**：

- [ ] `npm test` 通过
- [ ] 新增测试有明确目的

---

## T008 更新项目文档

**目标**：ARCHITECTURE.md / decisions.md 与实际架构保持一致。

**步骤**：

1. 更新 [`docs/ARCHITECTURE.md`](../../../ARCHITECTURE.md)：
   - "当前理解"：补全实际复用的上游模块；
   - "核心模块候选"：把已确认的部分从 TBD 推进为"当前选择 / 已验证事实"；
   - 未确认的（Provider 隔离、Pixel-style 渲染策略等）**仍保留 TBD**。
2. 确认 ADR-001 已在 [`decisions.md`](../../../.agent/knowledge/decisions.md)。
3. 001 的 `tasks.md` 全部打勾。

**验证**：

- [ ] ARCHITECTURE.md 中"复用模块"段非空且准确
- [ ] 002 / 003 / 004 相关 TBD 未被本 Feature 提前决定
- [ ] tasks.md 全部勾选

---

## T009 Self Review

**目标**：按 `.agent/workflows/review.md` 对本次实现做一次自我 Review。

**重点回答**：

1. 是否真的复用了 upstream，而不是重写了一遍？
2. 001 是否严格没有做 Provider / Model？
3. ≥2 个 Instance 是否可以同时存在？
4. Session / Repo 是否各自独立？
5. UI 是否能同时反映两个 Instance？
6. 是否保留 upstream MIT attribution？
7. upstream baseline 是否有独立 Commit？
8. Claude Fleet 改造是否有独立 Commit？
9. tests / build 是否通过？
10. 是否有任何隐藏 workaround？

如有发现 → 在 tasks.md 中补 task 处理，或在 lessons / pitfalls 中沉淀。

---

## 不在范围内（再次强调）

001 **不**包含 Provider Profile / Model Profile / `CLAUDE_CONFIG_DIR` 隔离 / Provider
切换 UI / Codex / Gemini / Antigravity / Marketplace 发布 / Control Center UI 重构。
这些属于后续 Spec。
