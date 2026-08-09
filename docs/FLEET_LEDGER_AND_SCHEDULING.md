# FLEET_LEDGER_AND_SCHEDULING.md — Agent Fleet

This document defines the durable evidence and decision layer for Agent Fleet. It is a target
architecture for local-first coordination; it does not implement a database, scheduler, or
autonomous dispatch loop by itself.

---

## 1. Purpose

Agent Fleet needs more than a live status panel. It needs to answer, after a Mission finishes:

- what was requested;
- which WorkItems were assigned;
- which native runtime, ProviderProfile, Model, host, workspace, worktree, terminal, and
  Session executed them;
- how long the work took;
- how many tokens were observed;
- what cost or quota evidence exists;
- what tests, reviews, PRs, and quality signals resulted;
- why an assignment was selected;
- whether the original estimate was accurate;
- whether a new instance should have been recommended.

The data flow is:

```text
native signals
  -> FleetEvent
  -> FleetTelemetryStore
  -> Fleet Ledger
  -> Metrics / Performance Profiles
  -> Strategy Recommendation
  -> policy-controlled execution
```

The layers are intentionally separate:

- Telemetry: current and recent observable state.
- Ledger: durable records and evidence references.
- Metrics: derived measurements.
- Strategy: explainable recommendations.
- Execution: a separate Control API and FleetRuntimeHost operation.

---

## 2. Core identity

### 2.1 Mission

Mission is the top-level unit of work. It may span repositories, hosts, runtimes, Sessions,
WorkItems, Pull Requests, and review cycles.

A Mission should identify:

```text
missionId
title
objective
requester
coordinatorRef
repoScope
createdAt
startedAt
completedAt
status
policyMode
budget
reviewPolicy
resultSummary
```

A Mission is not a single CLI session. One Mission may contain a managed Claude Code
Coordinator, a Codex CLI reviewer, several Claude workers, and external evidence.

### 2.2 WorkItem

A WorkItem is a bounded assignment within a Mission:

```text
workItemId
missionId
parentWorkItemId
title
objective
inputs
acceptanceCriteria
dependencies
repo
branch
worktree
allowedRuntimeTypes
allowedRoles
providerModelConstraints
budgetConstraints
reviewPolicy
assignedInstanceId
status
createdAt
startedAt
completedAt
resultReferences
```

WorkItems should be small enough to review and independently retry. A new runtime should be
requested through a new AssignmentDecision rather than silently expanding an existing WorkItem.

### 2.3 FleetInstance and Session

FleetInstance is the managed identity of a native runtime process/session binding. Session is the
native runtime conversation identity. They are related but not interchangeable.

An Instance record should preserve:

```text
instanceId
runtimeType
role
managedByFleet
missionId
workItemId
sessionId
providerProfileId
providerDisplayName
modelId
status
parentAgentId
leadAgentId
hostId
workspaceId
repo
worktree
branch
terminalId
terminalName
launchSource
requestedBy
createdAt
lastActivityAt
endedAt
```

Runtime is not Role. A Claude Code CLI or Codex CLI instance may be a coordinator, worker,
reviewer, debugger, or researcher according to the Mission and policy.

### 2.4 Host, workspace, and terminal identity

A Ledger record must distinguish where the runtime is managed:

```text
FleetHost
  hostId, hostType, hostDisplayName, controllerVersion

WorkspaceHost
  workspaceId, hostId, workspacePath, repo, worktree, branch

Terminal
  terminalId, terminalName, terminalKind, ownerInstanceId

Launch metadata
  launchSource, requestedBy, policyMode, controlRequestId
```

The preferred execution surface is the VS Code Integrated Terminal. Terminal identity is not
just a display label; it is needed to route Focus Terminal, detect duplicate launches, diagnose
host failures, and explain how a Session was created.

launchSource examples include Fleet UI, Control API, MCP, external adoption, restart, resume,
or manual discovery. requestedBy identifies the Coordinator, user, or system policy that
requested the action. These values must not contain secrets.

---

## 3. Ledger records

The first local implementation may use a file-backed or in-memory boundary, but the logical
records are stable.

### 3.1 MissionRecord

```text
MissionRecord
  missionId
  objective
  coordinatorRef
  policyMode
  status
  timestamps
  budget
  repoScope
  resultSummary
```

### 3.2 WorkItemRecord

```text
WorkItemRecord
  workItemId
  missionId
  assignment
  acceptanceCriteria
  dependencyIds
  estimated
  actual
  status
  resultReferences
```

### 3.3 SessionRecord

```text
SessionRecord
  sessionId
  instanceId
  runtimeType
  role
  managedByFleet
  providerProfileId
  modelId
  hostId
  workspaceId
  repo
  worktree
  terminalId
  launchSource
  requestedBy
  startedAt
  endedAt
  resumeCount
  status
```

### 3.4 LaunchRecord

LaunchRecord makes process creation auditable without storing a transcript:

```text
LaunchRecord
  controlRequestId
  missionId
  workItemId
  instanceId
  sessionId
  runtimeType
  role
  hostId
  workspaceId
  terminalId
  launchSource
  requestedBy
  policyMode
  providerProfileId
  modelId
  decisionId
  createdAt
  outcome
  error
```

### 3.5 PullRequestRecord

```text
PullRequestRecord
  pullRequestId
  missionId
  workItemIds
  repo
  branch
  baseBranch
  commitIds
  reviewStatus
  checks
  mergeStatus
  createdAt
  mergedAt
```

Automatic merge is not implied. Merge status is evidence for review and policy.

### 3.6 UsageRecord

UsageRecord captures a real usage observation:

```text
UsageRecord
  usageId
  missionId
  workItemId
  instanceId
  sessionId
  resourceAccountId
  runtimeType
  providerProfileId
  modelId
  source
  inputTokens
  cachedInputTokens
  outputTokens
  totalTokens
  durationMs
  costAmount
  costCurrency
  quotaUnits
  observedAt
  availability
  confidence
  estimateOrActual
  evidenceRef
```

A record may contain only a subset of fields. Missing values are unavailable. Never derive a
cost or quota value merely because token counts or a model name exist.

### 3.7 QuotaSnapshot

```text
QuotaSnapshot
  quotaSnapshotId
  resourceAccountId
  provider
  plan
  window
  limit
  remaining
  resetAt
  used
  unit
  source
  availability
  confidence
  observedAt
```

Subscription quota, metered API cost, token-based credits, and local capacity are different
resources. Do not combine them into one percentage without a defined ResourceAdapter.

### 3.8 QualitySignal

Quality is evidence, not a single subjective score:

```text
QualitySignal
  qualityId
  missionId
  workItemId
  instanceId
  source
  signalType
  value
  confidence
  evidenceRef
  observedAt
```

Examples:

- acceptance criteria passed;
- tests passed or failed;
- review finding count and severity;
- regression introduced;
- rework required;
- PR accepted, rejected, or merged;
- user correction required;
- behavior remained within scope.

### 3.9 AssignmentDecision

Every assignment or recommendation should be explainable:

```text
AssignmentDecision
  decisionId
  missionId
  workItemId
  requestedBy
  decidedBy
  mode
  selectedInstanceId
  proposedLaunch
  candidates
  factors
  constraints
  expected
  actual
  decision
  createdAt
  completedAt
```

decision may be recommend, approved, rejected, deferred, executed, failed, or cancelled.
proposedLaunch may contain a RuntimeAdapter, role, provider/model, host, workspace, worktree,
terminal, and budget template for a new instance. It is not itself a launch command.

---

## 4. Time and performance measurements

Keep at least these time dimensions separate:

```text
queueTime
startupTime
activeTime
waitingTime
blockedTime
reviewTime
reworkTime
wallClockTime
```

A worker may have high wall-clock time but low active time because it was waiting for a user,
quota window, test environment, or another WorkItem. Strategy must not treat all elapsed time
as model speed.

Where possible, record estimated and actual values:

```text
Estimated:
  expectedActiveMs
  expectedWallClockMs
  expectedTokens
  expectedCost
  expectedQuotaUnits

Actual:
  activeMs
  wallClockMs
  totalTokens
  costAmount
  quotaUnits
```

This supports strategy accuracy:

```text
timeAccuracy = compare(expectedTime, actualTime)
tokenAccuracy = compare(expectedTokens, actualTokens)
costAccuracy = compare(expectedCost, actualCost)
quotaAccuracy = compare(expectedQuota, actualQuota)
qualityAccuracy = compare(expectedQuality, observedQuality)
```

Accuracy metrics must include source and confidence. A missing actual value cannot be scored as
zero.

---

## 5. Token, Cost, Quota, and ResourceAccount

### Token

Token is model input/output accounting when a native signal exposes it. Cached input tokens
should remain distinguishable when available.

### Cost

Cost is billed or estimated monetary amount. API-equivalent cost may be useful for comparison,
but it must be labeled as estimated or equivalent rather than confused with a subscription bill.

### Quota

Quota is a provider, plan, credit, rate-limit, or capacity constraint. It may be a rolling
window, weekly budget, subscription limit, or local concurrency reserve.

### ResourceAccount

ResourceAccount identifies the resource authority used by an instance:

```text
ResourceAccount
  resourceAccountId
  provider
  accountType
  profileId
  plan
  currency
  quotaPolicy
  costPolicy
  privacyClass
  enabled
```

ResourceAdapter is responsible for obtaining evidence. Examples:

- metered API account;
- token/credit plan;
- Claude subscription usage if a reliable source exists;
- local capacity/concurrency;
- optional Cockpit or other external quota source, if explicitly selected later.

The Ledger stores source, timestamp, availability, confidence, and estimateOrActual. It never
stores API keys, authorization headers, SecretStorage values, complete environment variables,
or raw credentials.

---

## 6. Agent performance profile

A performance profile is a derived view, not a second source of truth:

```text
AgentPerformanceAggregate
  profileId
  runtimeType
  providerProfileId
  modelId
  role
  sampleCount
  capabilityEvidence
  medianActiveTime
  medianWallClockTime
  qualityRate
  reviewReworkRate
  tokenEfficiency
  costEfficiency
  quotaEfficiency
  contextPressure
  failureRate
  strategyAccuracy
  confidence
  updatedAt
```

The profile may be keyed by runtime, provider, model, role, or a controlled combination. It must
not claim that one agent is universally better from a small or biased sample.

Performance input should distinguish:

- what the agent can do;
- how quickly it did it;
- how much it consumed;
- how often it required rework;
- how reviewers evaluated the result;
- how much confidence the evidence deserves.

---

## 7. Strategy and recommendation

StrategyAdapter consumes evidence and policy. It does not own process creation.

Inputs include:

```text
Mission objective and constraints
WorkItem dependencies and acceptance criteria
runtime capabilities
role fit
historical quality
time and queue pressure
token and context pressure
cost and quota
current load and concurrency
provider/model availability
host/workspace/worktree risk
review and merge policy
user preference
```

The result should contain:

```text
Recommendation
  recommendationId
  workItemId
  selectedCandidate
  alternatives
  proposedLaunchTemplate
  expectedTime
  expectedQuality
  expectedTokens
  expectedCost
  expectedQuota
  factors
  constraints
  confidence
  expiresAt
```

A recommendation may say:

```text
Reuse instance A
Start a new Claude Code instance with profile P
Start a new Codex CLI reviewer
Delay until quota window reset
Split WorkItem into two isolated worktrees
Require human approval
```

A launch template is data, not a direct shell command:

```text
LaunchTemplate
  runtimeType
  role
  providerProfileId
  modelId
  resourceAccountId
  hostId
  workspaceId
  repo
  worktree
  terminalPolicy
  sessionMode
  budget
  reviewPolicy
```

Strategy should account for an overloaded or context-heavy instance. Starting another instance
can be better than extending a degraded Session, but only when concurrency, quota, worktree,
review, and budget policy permit it.

Strategy accuracy is evaluated later against the actual Ledger records. A recommendation that
was not executed must not be scored as an execution failure.

---

## 8. Control modes and scheduling guardrails

The control plane supports four conceptual modes:

```text
observe
  collect/display only

suggest
  recommend but never execute

approve
  execute after explicit approval

autonomous
  execute within an approved policy envelope
```

The default is suggest or approve.

### Coordinator resource directives

The primary Coordinator may issue a time-bounded resource directive when the
user deliberately changes the optimization objective. Examples include:

- a Codex or Claude quota window is close to reset, so throughput may be
  increased for approved work;
- a provider/model price changes, so that provider should be throttled or
  avoided;
- a model has temporary capacity, so the StrategyAdapter may prefer it while
  still respecting role, quality, review, and worktree constraints.

These are policy inputs, not hidden instructions injected into a runtime. A
directive must identify its requester, target runtime/provider/model/resource
account, objective, priority, reason, and expiry. It is evaluated together
with current quota, cost, quality, concurrency, context, and repository risk.
It may change a recommendation or an approved policy envelope, but it cannot
silently bypass approval, launch an unregistered runtime, or fabricate quota.

Conceptually:

```text
Coordinator message
  -> ResourceDirective
  -> StrategyAdapter evaluates candidates
  -> recommendation / policy patch
  -> approve or bounded autonomous execution
  -> Ledger records directive, decision, and actual outcome
```

The current implementation now includes a runtime-neutral `ResourceDirective`,
an in-memory `FleetStrategyAdapter`, and a `recommend_assignment` Control API
action. This slice ranks eligible existing instances, can propose a compatible
new launch template, records the recommendation in the Ledger, and never starts
a process. Durable directive history, provider-specific ResourceAdapters,
strategy accuracy evaluation, and autonomous scheduling remain deferred.

Autonomous mode is not a general “let agents do anything” switch. It requires:

- maximum concurrent instances;
- token, cost, and wall-clock budget;
- quota reserve and reset behavior;
- approved runtime/provider/model/resource account;
- allowed host, workspace, repository, branch, and worktree rules;
- required tests and review policy;
- stop conditions for errors, budget exhaustion, quota exhaustion, or repeated rework;
- audit of requestedBy, decidedBy, launchSource, and policy decision;
- a clear cancellation and recovery path.

A scheduler, when eventually implemented, should operate on WorkItems and AssignmentDecisions.
It should not inspect animation or guess progress from file timestamps.

The first scheduling loop should be bounded and explainable:

```text
load Mission / WorkItems
  -> read current Telemetry
  -> read Ledger history and ResourceAccounts
  -> produce Recommendation
  -> request approval or apply an approved policy
  -> launch through Fleet Control API / FleetRuntimeHost
  -> observe FleetEvents
  -> record actual outcome
  -> compare estimate versus actual
```

This is a target flow, not an implementation claim.

---

## 9. Adapter boundaries

Keep adapter families independent:

```text
RuntimeAdapter
  launches, resumes, stops, focuses, discovers, and normalizes a native runtime

ResourceAdapter
  reads account, usage, cost, quota, capacity, and rate-limit evidence

ObservabilityAdapter
  converts hooks, JSONL, traces, and external metrics to FleetEvent

SCMAdapter
  reads repo, worktree, branch, commit, diff, PR, review, and merge evidence

StrategyAdapter
  scores candidates, explains recommendations, and evaluates strategy accuracy
```

An external observability or quota tool must be integrated through an adapter. Do not make the
UI or Ledger depend on a vendor-specific schema.

---

## 10. Telemetry versus Ledger

Telemetry is bounded and live:

```text
FleetEvent
  -> FleetTelemetryStore
  -> InstanceSnapshot
  -> recent events
  -> Scene Model
```

Ledger is durable and historical:

```text
FleetEvent / runtime metadata / ResourceAdapter / SCMAdapter / review evidence
  -> normalized records
  -> Mission / WorkItem / Session / Usage / Quality / Assignment history
```

Telemetry may be discarded or compacted. Ledger records need retention and privacy policy.
Neither layer should store a full transcript by default.

---

## 11. Privacy and storage

Local-first storage should be sufficient for the first implementation.

Persist:

- stable IDs;
- timestamps;
- runtime/provider/model display metadata;
- repo/worktree/host/workspace/terminal identity;
- safe status, error, usage, quality, and assignment evidence;
- source, confidence, and estimate/actual markers;
- references to commits, tests, PRs, and external evidence.

Do not persist by default:

- API keys;
- OAuth or auth tokens;
- SecretStorage values;
- Authorization headers;
- complete environment variables;
- full prompts or transcripts;
- unrelated user files;
- raw provider responses containing credentials.

Retention, redaction, and export rules should be explicit before a cloud sync or shared service is
considered.

---

## 12. Development order

Implement in this order:

1. stabilize ClaudeCodeRuntimeAdapter and executable resolution;
2. finish runtime-neutral FleetInstance, Mission, WorkItem, Role, and host identities;
3. implement FleetRuntimeHost and VS Code terminal ownership;
4. normalize Claude and then Codex events through FleetEvent;
5. add CodexRuntimeAdapter;
6. add Mission/WorkItem Control API extension point;
7. add local Ledger records and ResourceAdapters;
8. add SCM/PR and quality evidence;
9. add StrategyAdapter and explainable recommendations;
10. add Instance Detail, Terminal Dock, and shared Scene Model projections;
11. add policy-controlled scheduling only after evidence and guardrails are reliable.

Do not implement a full Scheduler before stable identities, reliable usage evidence, worktree
ownership, and review records exist.

---

## 13. Current non-goals

This document does not authorize:

- a database or cloud telemetry backend;
- a distributed tracing platform;
- a generic agent chat bus;
- direct unrestricted process spawning;
- automatic PR merge;
- quota estimation from token counts alone;
- cost estimation from model name alone;
- a new observability vendor dependency;
- Codex Desktop as a Fleet-managed runtime;
- VSIX packaging or release.

Related architecture decisions are appended to [.agent/knowledge/decisions.md](../.agent/knowledge/decisions.md).
