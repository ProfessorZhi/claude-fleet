# ROADMAP.md — Agent Fleet

> Agent Fleet evolves in dependency order. A phase is complete only when its exit criteria
> are met; dates are intentionally omitted.
>
> Product scope: [PROJECT.md](./PROJECT.md). Target architecture: [ARCHITECTURE.md](./ARCHITECTURE.md).
> Ledger and strategy design: [FLEET_LEDGER_AND_SCHEDULING.md](./FLEET_LEDGER_AND_SCHEDULING.md).

---

## Roadmap principles

1. Keep the native Coding Agent as the execution engine.
2. Keep Runtime, Role, ProviderProfile, Model, Session, Host, Terminal, Telemetry, Ledger,
   Resource, SCM, and Strategy as separate concepts.
3. Prefer repository artifacts, commits, tests, and review records over copied chat transcripts.
4. Add a new runtime through an adapter and host contract, not through provider-specific UI code.
5. Separate recommendation from execution. The default control modes are suggest and approve.
6. Preserve real terminal focus and native session continuity.
7. Treat Auto Discovery as adoption compatibility, not as Fleet lifecycle ownership.
8. Keep Pixel Office and Fleet Command as interchangeable projections over one Scene Model.
9. Do not add a future architecture label to the current implementation until the required
   control boundary actually exists.

The canonical brand is already **Agent Fleet** for new architecture and product language. Existing
Claude Fleet package, command, configuration, class, and state identifiers remain compatibility
surfaces. A second brand migration phase is not planned.

---

## Baseline complete: 001–006

The current repository baseline establishes:

- 001 multi-instance runtime foundation;
- 002 provider/model isolation;
- 003 instance status;
- 004 minimal control UI;
- 005 provider registry and native session continuity;
- 006 branding, state migration, discovery, and compatibility behavior;
- merged agentmetrics source under agentmetrics/;
- initial Fleet identity and telemetry contracts in the working tree.

The baseline is valuable, but it is not yet the v1 target control plane. In particular, current
runtime management is primarily Claude Code CLI, and the target host, Ledger, Strategy, and
Control API layers still need implementation.

---

## Phase A — Stabilize the current Claude Code runtime

**Goal:** make the current Claude Code CLI path reliable enough to be the reference adapter.

Scope:

- one executable resolver for Windows, macOS, and Linux;
- native launch, stop, restart, resume, and focus;
- no duplicate instance after discovery, resume, restart, or provider switch;
- explicit Managed versus External identity;
- Repo, workspace, worktree, host, terminal, and session metadata;
- regression tests for existing Provider Registry and Session Continuity.

Exit criteria:

- at least two Claude Code instances can run concurrently;
- each instance has an auditable native session and terminal identity;
- failed resume does not silently fork a new session;
- external discovery remains functional;
- existing Provider Registry and Pixel Office flows pass regression checks.

Status: baseline exists; stabilization and Development Host verification remain active.

---

## Phase B — Runtime-neutral domain contracts

**Goal:** make the management model independent of the native runtime without starting a
generic orchestration framework.

Scope:

- FleetInstance;
- Mission, WorkItem, Role, CoordinatorRef;
- RuntimeCapabilities;
- Managed versus External;
- host, workspace, worktree, terminal, session, and launch-source identity;
- RuntimeAdapter interface and ClaudeCodeRuntimeAdapter boundary.

Exit criteria:

- domain types do not encode Claude equals worker or Codex equals coordinator;
- unsupported runtime operations are explicit unavailable/capability errors;
- existing Claude flows can project into the neutral model;
- no Agent-to-Agent Chat Bus is introduced.

Status: runtime-neutral type contracts are present; lifecycle/host implementation is partial
and must be completed before Codex management.

---

## Phase C — FleetRuntimeHost and VS Code execution host

**Goal:** give managed runtime creation one ownership path.

Scope:

- FleetHost and WorkspaceHost resolution;
- FleetRuntimeHost launch ownership;
- VS Code Integrated Terminal binding;
- process, terminal, session, and instance identity;
- non-focus-stealing launches;
- host failure and abort behavior;
- launch audit fields: requestedBy, launchSource, policy, and assignment.

Exit criteria:

- a control request resolves Mission to host, workspace, worktree, terminal, adapter, and
  native CLI;
- all Fleet-managed launches use the host path;
- direct arbitrary shell spawning is not used as the managed lifecycle path;
- Focus Terminal reaches the real terminal.

Status: VscodeFleetRuntimeHost now owns the current Claude Code launch/focus/stop/restart/resume
entry points and persists safe host/workspace/terminal provenance; generic multi-host resolution
and native terminal identity reconciliation remain.

---

## Phase D — Unified observability

**Goal:** make every runtime signal consumable by one management and presentation layer.

Scope:

- FleetEvent normalization;
- FleetTelemetryStore;
- per-instance Snapshot;
- bounded recent event history;
- Claude Hooks, JSONL, AgentState, and metadata adapters;
- secret exclusion and unavailable-value semantics;
- Scene Model consumed by Pixel Office and Fleet Command.

Exit criteria:

- Webview and future strategy code do not parse Claude-specific raw events;
- recent history is bounded;
- error records retain message, source, and timestamp without secrets;
- real signals are distinguishable from estimated or unavailable data;
- Auto Discovery, subagent, team, completion, and status events preserve identity.

Status: contracts/specs are present in the repository; full end-to-end integration remains work.

---

## Phase E — Codex CLI RuntimeAdapter

**Goal:** add Codex CLI as the second v1 Fleet-managed runtime.

Scope:

- native Codex CLI detection and launch specification;
- Codex session/resume semantics;
- Codex JSONL/event normalization;
- Codex terminal focus and lifecycle;
- Codex provider/model/resource metadata where real signals exist;
- adapter-specific regression tests.

Exit criteria:

- Codex CLI can be launched and managed through FleetRuntimeHost;
- Codex and Claude instances share FleetInstance, Role, Mission, WorkItem, and telemetry
  contracts;
- no Codex Desktop client is mistaken for a Fleet-managed Codex CLI instance.

Status: the Codex CLI adapter and thin Codex FleetRuntimeHost are present with Windows/POSIX
resolution, launch-spec construction, JSON/JSONL normalization, ownership checks, and fake-only
regression tests. The real process/terminal bridge remains deferred. Codex Desktop is still
external and is not managed by Fleet.

---

## Phase F — Mission, WorkItem, Coordinator, and Control API

**Goal:** turn a planning request into auditable assignments without introducing a chat bus.

Scope:

- Mission as the top-level work unit;
- WorkItem dependencies and acceptance criteria;
- CoordinatorRef for External and Managed Coordinators;
- Fleet Control API extension point;
- future MCP adapter over the same API;
- create, inspect, assign, pause, resume, stop, and collect-result commands;
- repository artifacts as the durable handoff channel.

Exit criteria:

- external Codex Desktop can request Fleet operations through a controlled boundary;
- a managed Claude/Codex Coordinator uses the same boundary;
- command authorization, requestedBy, and policy decision are recorded;
- messages remain concise task references; full transcript forwarding is not required.

Status: runtime-neutral Control API contracts, mission/work-item creation, idempotent in-memory
ControlService execution, policy checks, decision Ledger records, and a local Bearer-protected
HTTP/CLI bridge are present. MCP transport, authorization service, and built-in process-spawning
implementation remain deferred.

---

## Phase G — Fleet Ledger and Resource Accounts

**Goal:** persist long-lived facts needed for history, accounting, and later strategy.

Scope:

- MissionRecord, WorkItemRecord, SessionRecord, LaunchRecord;
- PullRequestRecord, UsageRecord, QuotaSnapshot, QualitySignal;
- AssignmentDecision and AgentPerformanceAggregate;
- FleetHost, WorkspaceHost, terminal, launch source, and requester identity;
- ResourceAccount and ResourceAdapter;
- estimated versus actual time, tokens, cost, and quota;
- privacy-safe local storage and retention.

Exit criteria:

- every important assignment has a stable identity and audit trail;
- Token, Cost, and Quota remain separate;
- unavailable and estimated values preserve their source/confidence;
- no API key, authorization header, full prompt, full transcript, or secret is persisted;
- current versus historical telemetry is clearly separated.

Status: Ledger contracts and an in-memory, secret-free metadata store are present. Durable
persistence, ResourceAdapter integration, retention policy, and SCM/PR records remain deferred.

---

## Phase H — SCM, PR, and quality evidence

**Goal:** connect agent activity to reviewable repository outcomes.

Scope:

- SCMAdapter for repo, branch, worktree, diff, commit, PR, and review evidence;
- PR lifecycle records;
- test and validation evidence;
- quality signals such as acceptance, review findings, rework, regression, and merge outcome;
- worktree conflict detection only when reliably provable.

Exit criteria:

- a WorkItem can be traced to commits, tests, review, and a PR;
- quality signals distinguish implementation success from mere process activity;
- merge remains a policy-controlled human/Coordinator action.

Status: deferred.

---

## Phase I — Metrics, performance profiles, and recommendations

**Goal:** use evidence to improve assignment quality, time, and resource use.

Strategy inputs include:

- capability and role fit;
- historical quality and review outcomes;
- elapsed time and speed;
- token use, context pressure, and estimated/actual cost;
- quota reserve and rate limits;
- current load and concurrency;
- provider/model availability;
- repo/worktree risk;
- review policy and Mission constraints.

Scope:

- agent performance aggregates;
- strategy scoring and explainable weights;
- strategy accuracy: predicted versus actual time, quality, token, cost, and quota;
- recommendation records;
- candidate launch templates for a new Claude or Codex instance;
- recommendation versus execution separation.

Exit criteria:

- recommendations include reason, alternatives, constraints, and expected impact;
- a recommendation may propose starting a new runtime instance;
- no recommendation starts a process without Control API policy approval;
- low-confidence or missing data is surfaced rather than hidden;
- strategy can be evaluated against actual outcomes.

Status: partial. `FleetStrategyAdapter` and the `recommend_assignment` Control API
action now provide bounded, explainable, side-effect-free recommendations and
record `AssignmentDecision` metadata. Durable directive history, provider-specific
resource adapters, strategy accuracy evaluation, and any automatic scheduler
remain deferred; no recommendation starts a process by itself.

---

## Phase J — Fleet Command, Instance Detail, and Terminal Dock

**Goal:** provide a coherent management UI while preserving runtime semantics.

Scope:

- Fleet Command as the default scene;
- Pixel Office as a fully supported alternative scene;
- shared Scene Model and selection state;
- responsive Fleet List, Scene, Telemetry/Instance Detail, and Recent Events layout;
- stable pixel vessel identity;
- Agent behavior mapping for spawn, working, waiting, idle, error, completion, discovery,
  subagent, teams, restart, resume, and provider switch;
- Instance Detail separate from Focus Terminal;
- Terminal Dock or equivalent real terminal navigation.

Exit criteria:

- selecting a vessel selects the correct instance;
- Instance Detail shows actual metadata or unavailable;
- Focus Terminal opens the actual VS Code terminal;
- switching scenes does not alter runtime or session state;
- no Three.js, WebGL, or 3D rewrite is required for the first implementation.

Status: Fleet Command is a target scene; do not claim the architecture update implements it.

---

## Phase K — Policy-controlled Control Plane execution

**Goal:** connect recommendations, resource limits, runtime hosting, and user approval safely.

Scope:

- Control API and future MCP implementation;
- observe, suggest, approve, and autonomous modes;
- budgets, concurrency limits, quota reserve, approved runtime/provider/model;
- worktree and review/merge guardrails;
- stop conditions, abort behavior, and audit trails;
- bounded scheduling and queueing.

Exit criteria:

- default operation is suggest or approve;
- autonomous execution cannot exceed budget, quota, concurrency, runtime, workspace, or review
  policy;
- every launch/stop/assignment decision has an audit record;
- scheduling is explainable and reversible where possible.

Status: deferred. This is not an automatic scheduler implementation.

---

## Post-v1 runtime expansion

After Claude Code CLI and Codex CLI are stable through the same host and adapter boundaries,
evaluate:

- Gemini CLI;
- OpenCode;
- Qoder CLI;
- Custom Agent Runtime;
- additional ResourceAdapter and ObservabilityAdapter implementations;
- optional external management clients.

No runtime is added by embedding its conversation engine inside Agent Fleet.

---

## Current non-goals

The following are intentionally outside the current roadmap implementation update:

- replacing Claude Code or Codex;
- a generic distributed agent framework;
- Agent-to-Agent chat transport;
- automatic PR merge;
- a full trace platform;
- cloud backend or mandatory database;
- quota guessing;
- unrestricted autonomous process spawning;
- another Agent Fleet branding migration;
- VSIX packaging or GitHub release work.

---

## Related documents

- [PROJECT.md](./PROJECT.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [FLEET_LEDGER_AND_SCHEDULING.md](./FLEET_LEDGER_AND_SCHEDULING.md)
- [WORKFLOW_CODEX_CLAUDE.md](./WORKFLOW_CODEX_CLAUDE.md)
- [ALPHA_RELEASE.md](./ALPHA_RELEASE.md)
- [MANUAL_TEST_ALPHA.md](./MANUAL_TEST_ALPHA.md)
- [spec index](./specs/README.md)
