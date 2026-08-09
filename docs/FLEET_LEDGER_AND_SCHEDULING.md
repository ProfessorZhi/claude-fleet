# Fleet Ledger & Scheduling Architecture

> 本文定义 Claude Fleet / future Agent Fleet 的长期工作记录、资源/额度建模、效率指标、推荐与调度边界。
> 它是 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的专项设计文档。

---

## 1. 目标

Agent Fleet 不只回答“现在谁在工作”，还要回答：

- 过去每个 Agent 做过哪些任务、提交了哪些 PR；
- 每个任务/PR 花了多少时间；
- 消耗了多少 Token、API 成本或订阅额度；
- PR 质量如何、返工多少、CI/Review 表现如何；
- 哪个 Agent / Runtime / Provider 更适合下一项任务；
- 当前资源是否足够，是否应该新开一个 Agent；
- Coordinator 在用户授权范围内，能否直接启动新的 Worker 并分配任务。

因此分为四个明确层次：

```text
Telemetry  →  现在发生什么
Ledger     →  历史发生过什么
Metrics    →  谁更快 / 更省 / 质量更好
Strategy   →  下一步任务应该给谁、是否应该新开 Agent
```

---

## 2. Fleet Ledger：长期元信息账本

Fleet Ledger 是本地、结构化、可查询的长期工作记录。

默认只保存元信息，不保存完整 Prompt、完整聊天 Transcript 或 Secret。

建议一等记录：

```text
MissionRecord
WorkItemRecord
SessionRecord
PullRequestRecord
UsageRecord
QuotaSnapshot
QualitySignal
AssignmentDecision
AgentPerformanceAggregate
```

### WorkItemRecord

```ts
interface WorkItemRecord {
  id: string;
  missionId: string;
  title: string;
  status: 'pending' | 'running' | 'review' | 'done' | 'failed' | 'cancelled';
  assignedInstanceId?: string;
  requiredCapabilities?: string[];
  priority?: number;
  dependsOn?: string[];

  assignedAt?: string;
  startedAt?: string;
  firstEditAt?: string;
  firstCommitAt?: string;
  completedAt?: string;
}
```

### PullRequestRecord

```ts
interface PullRequestRecord {
  id: string;
  missionId?: string;
  workItemId?: string;
  instanceId?: string;

  repository: string;
  number?: number;
  branch?: string;
  url?: string;

  openedAt?: string;
  reviewStartedAt?: string;
  approvedAt?: string;
  mergedAt?: string;
  closedAt?: string;

  commitCount?: number;
  filesChanged?: number;
  additions?: number;
  deletions?: number;

  ciRuns?: number;
  ciFailures?: number;
  reviewRounds?: number;
  reviewFindingCount?: number;
  reworkCount?: number;

  outcome?: 'merged' | 'closed' | 'rejected' | 'reverted' | 'open';
}
```

Ledger 应允许从 Git / GitHub / GitLab 等 SCM Adapter 补充这些字段，而不是让 Runtime Adapter 自己理解 PR。

---

## 3. 时间指标

Fleet 需要区分：

```text
Wall-clock time
Agent active time
Waiting time
Review time
PR cycle time
```

可派生指标包括：

```text
Time to first tool
Time to first edit
Time to first commit
Time to PR
Time to CI green
Time to review
Time to merge
Total work-item cycle time
```

并行 Mission 还可以计算：

```text
Total Agent Time
Wall Clock Time
Parallelism / Parallel Gain
```

所有指标都必须有真实时间戳来源；没有可靠信号时显示 unavailable。

---

## 4. Token、Cost 与 Quota 必须分开

不同 Provider / Account 的资源模式不同，不能用一个 `remainingPercent` 粗暴统一。

统一抽象建议：

```ts
interface UsageRecord {
  instanceId: string;
  sessionId?: string;
  runtimeType: string;
  resourceAccountId?: string;
  modelId?: string;

  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;

  estimatedCost?: number;
  actualCost?: number;
  currency?: string;
  source: 'runtime' | 'provider-api' | 'derived' | 'manual';
}
```

### 4.1 Metered API

例如按量 API 类资源账户。

Fleet 可以记录：

```text
Token usage
Estimated cost
Actual billed cost（如果 Provider API 可靠提供）
Budget remaining
```

`estimatedCost` 与 `actualCost` 必须分开。

如果只有 Token 和价格表：

```text
source = derived
```

如果 Provider 官方接口返回真实费用：

```text
source = provider-api
```

### 4.2 Token Plan / Credit Plan

某些 Provider 不是纯按量费用，而是 Token Plan / Credit Plan / 周期额度。

统一为：

```ts
interface QuotaSnapshot {
  resourceAccountId: string;
  kind: 'token-plan' | 'subscription' | 'credit' | 'rate-limit' | 'budget' | 'unknown';

  used?: number;
  remaining?: number;
  limit?: number;
  unit?: 'tokens' | 'credits' | 'requests' | 'currency' | 'percent';

  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  window?: string;

  source: 'provider-api' | 'runtime' | 'manual' | 'derived';
  capturedAt: string;
  confidence: 'authoritative' | 'estimated' | 'manual';
}
```

例如 MiniMax Token Plan 可以通过对应 Resource Adapter 提供额度信息；拿不到可靠信息时就显示 unavailable，不猜。

### 4.3 Plus / Pro / Subscription

Plus / Pro 等订阅制使用上限可能不是简单 Token Billing。

原则：

- 官方 / Runtime 能可靠给出剩余额度或百分比时才记录；
- 无可靠接口时显示 unknown / unavailable；
- 不允许仅根据已用 Token 伪造“剩余 37%”；
- Subscription quota 与 API cost 是两套不同指标。

---

## 5. ResourceAccount：把资源与 Runtime 解耦

Runtime 和计费资源不是同一概念。

例如：

```text
Claude Code Runtime + DeepSeek API profile
Claude Code Runtime + MiniMax Token Plan profile
Codex CLI Runtime + subscription/account
```

因此建议增加：

```ts
interface ResourceAccount {
  id: string;
  displayName: string;
  ownerType: 'runtime-account' | 'provider-profile' | 'custom';
  ownerRef: string;
  billingMode: 'metered-api' | 'token-plan' | 'subscription' | 'credit' | 'unknown';
  enabled: boolean;
}
```

Resource Adapter 负责：

```text
readUsage()
readQuota()
estimateCost()
```

不要把 DeepSeek / MiniMax / Subscription 判断散落在 Strategy Engine 内。

---

## 6. Quality：质量必须可解释

Fleet 不应让模型凭感觉给 PR 打一个神秘分数。

Quality 由可解释 Signal 组成：

```text
CI first-pass result
Tests added / changed
Review finding count
Review severity
Review rounds
Rework count
Regression introduced
PR merged / rejected / reverted
Human rating
Coordinator rating
```

可以存在可选 Composite Score，但必须保留 breakdown：

```text
Quality 86/100
+ CI passed first attempt
+ Review approved
+ Tests added
- 2 minor findings
- 1 follow-up fix
```

历史比较优先使用原始指标，不依赖单个总分。

---

## 7. Agent Performance Profile

Metrics Engine 可以从 Ledger 聚合每个 Runtime / Model / Provider / Agent Template 的历史表现：

```text
Task count
PR count
Merge rate
First-pass CI rate
First-pass review rate
Median task time
Median time-to-PR
Median PR cycle time
Median token usage
Median API cost
Rework rate
Failure rate
Capability-specific history
```

需要按任务类型 / capability 分桶，避免“前端做得快”被错误推导成“任何任务都快”。

---

## 8. Strategy Engine：决策层输入

Strategy Engine 不是单纯比较模型排行榜。

对一个 Work Item 的候选对象，至少考虑：

```text
Capability match
Historical task quality
Historical speed
Estimated wall-clock time
Estimated token usage
Estimated API cost
Current workload
Current context headroom
Remaining quota / budget
Quota reset time
Provider / Runtime availability
Repo / Worktree conflict risk
User policy
Task priority / deadline
```

候选不仅可以是“现有 Agent”，还可以是“新建一个 Agent 的 Launch Template”。

例如：

```text
Candidate A
Existing Claude #2 / DeepSeek

Candidate B
Launch new Claude Code / MiniMax profile

Candidate C
Existing Codex #1
```

这允许 Recommendation Engine 给出：

> 建议再开一个 MiniMax-backed Claude Code Worker：当前 Claude #2 正忙，MiniMax 额度充足，历史同类前端任务中位耗时更短，且不会增加按量 API 成本。

必须同时展示依据和不确定性。

---

## 9. Recommendation Panel

Fleet UI 应有独立建议栏，而不是把策略藏在后台。

示例：

```text
SUGGESTIONS

Launch Claude Worker · MiniMax
Reason:
- 2 independent tasks are ready
- existing workers are busy
- MiniMax quota is healthy
- similar tasks historically complete faster

Expected:
- ~18–25 min
- subscription/token-plan usage
- no DeepSeek API spend

[Launch] [Dismiss] [Details]
```

也可以建议：

```text
Use existing Codex Reviewer
Delay low-priority task until quota reset
Switch new worker from DeepSeek to MiniMax
Do not parallelize: same checkout conflict
Stop idle Agent
```

Recommendation 不是强制执行。

---

## 10. Coordinator 是否可以自己开启 Agent

可以，但必须通过 Fleet Control Plane，并受 Policy 约束。

建议四种权限模式：

```text
observe       只能读状态 / Ledger
suggest       可以生成建议，但不能执行
approve       可以请求 launch / assign，用户确认后执行
autonomous    在用户预先定义的边界内直接执行
```

默认建议：

```text
suggest 或 approve
```

`autonomous` 只有在用户明确配置预算和规则后启用。

Coordinator 不直接自己 `spawn` 随意进程；它调用 Fleet 的统一 Control API / MCP：

```text
fleet.list_candidates()
fleet.get_resource_status()
fleet.recommend_assignment()
fleet.launch_instance()
fleet.assign_work_item()
fleet.stop_instance()
fleet.get_metrics()
```

这样所有自动启动都有统一 Ledger、预算和审计记录。

---

## 11. 只给任务清单和规则，能否让主线程自己调度

目标上可以。

用户提供：

```text
Task List
+ Dependencies
+ Capabilities
+ Priority
+ Resource / Cost Rules
+ Concurrency Rules
+ Approval Policy
```

Coordinator 可以循环：

```text
Read ready tasks
→ query Fleet candidates/resources
→ select existing instance or launch template
→ assign task
→ observe status / PR / metrics
→ review results
→ update task state
→ repeat
```

建议任务策略文件概念：

```yaml
mission:
  max_concurrent_agents: 4
  coordinator_mode: approve

resources:
  max_metered_api_cost_usd: 10
  reserve_quota_percent: 15

allowed:
  runtimes: [claude-code, codex-cli]
  provider_profiles: [deepseek-main, minimax-main]

git:
  require_separate_worktree_for_parallel_writers: true

review:
  require_review_before_merge: true
```

这只是目标 Schema 示例；具体字段由后续 Spec 定义。

---

## 12. Guardrails：防止自动 Agent 无限扩张

自动调度必须有硬边界：

```text
max concurrent agents
max agents per mission
metered API budget
quota reserve
allowed runtime / provider / model
allowed repos
allowed commands / actions
worktree isolation
require review before merge
require approval for destructive actions
```

如果资源数据未知：

```text
unknown quota != unlimited quota
```

Strategy 必须保守处理未知资源。

---

## 13. AssignmentDecision 也要进入 Ledger

每次人工或自动任务分配都记录简要决策元信息：

```ts
interface AssignmentDecision {
  id: string;
  missionId: string;
  workItemId: string;
  selectedTarget: string;
  mode: 'manual' | 'recommended' | 'coordinator-auto';
  consideredTargets?: string[];
  reasons: string[];
  estimatedCost?: number;
  estimatedDurationMs?: number;
  createdAt: string;
}
```

这样后面可以评估：

```text
推荐是否准确
自动分配是否真的更快
是否因为省 Token 导致更多返工
哪个 Strategy 更适合当前项目
```

---

## 14. Adapter 架构

为长期扩展到 Gemini CLI、OpenCode、Qoder CLI、自定义 Agent，扩展点拆成：

```text
RuntimeAdapter
  Claude Code / Codex / Gemini CLI / OpenCode / Qoder / Custom

ResourceAdapter
  metered API / token plan / subscription / custom account

ObservabilityAdapter
  runtime events / external observability tools

SCMAdapter
  GitHub / GitLab / local Git / future SCM

StrategyAdapter
  balanced / speed / quality / cost / custom
```

核心 Domain 不允许出现：

```text
if runtime === claude ...
if provider === minimax ...
```

这类 vendor-specific 逻辑应被 Adapter 吸收。

---

## 15. 建议的最终数据流

```text
Claude / Codex / Gemini / OpenCode / Qoder / Custom
                         │
                   RuntimeAdapter
                         │
                         ▼
                    FleetEvent
                         │
             ┌───────────┴────────────┐
             ▼                        ▼
      FleetTelemetryStore         Fleet Ledger
        realtime state           durable metadata
             │                        │
             └───────────┬────────────┘
                         ▼
                    Metrics Engine
                         │
          Resource / SCM / Quality Signals
                         │
                         ▼
                    Strategy Engine
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
     Recommendation Panel       Coordinator API/MCP
                                     │
                                     ▼
                           Launch / Assign / Stop
```

---

## 16. Privacy / Storage

默认长期保存：

```text
IDs
Runtime / model / provider display metadata
Task metadata
timestamps
Token / cost / quota snapshots
Git commit / PR metadata
CI / review outcome
quality signals
assignment decisions
```

默认不保存：

```text
API keys
Auth tokens
SecretStorage values
full environment
full prompts
full conversations
full source files
```

原生 Session / Transcript 仍由对应 Runtime 管理。

Ledger 的具体持久化实现（JSON / SQLite / other local store）由后续实现 Spec 决定，但 Domain API 必须先与存储实现解耦。

---

## 17. 开发顺序

不要一次做全自动调度。

建议顺序：

```text
1. FleetEvent / Telemetry
2. Fleet Ledger 元信息
3. Usage / ResourceAccount / QuotaSnapshot
4. Git / PR / CI metrics
5. Metrics Engine
6. Recommendation Panel（只建议）
7. Mission task list + policy
8. Fleet Control API / MCP
9. Coordinator approve-mode launch / assign
10. bounded autonomous scheduling
11. Strategy plugins / historical optimization
```

先记录事实，再做推荐；先做推荐，再做自动执行。

---

## 18. 核心原则

```text
事实和估算分开
Token / Cost / Quota 分开
Runtime 和 Resource Account 分开
Telemetry 和 Ledger 分开
Ledger 和 Strategy 分开
Recommendation 和 Execution 分开
Runtime 和 Role 分开
Unknown 不等于 Unlimited
所有自动执行必须可审计
```
