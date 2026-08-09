# ARCHITECTURE.md — Agent Fleet

> Agent Fleet 是本地 Coding Agent Control Plane：管理真实 Coding Agent Runtime 的实例、配置、Session、终端、遥测、历史和控制边界。它不替代任何 Coding Agent。
>
> 产品范围见 [PROJECT.md](./PROJECT.md)，阶段计划见 [ROADMAP.md](./ROADMAP.md)，长期 Ledger 与调度设计见 [FLEET_LEDGER_AND_SCHEDULING.md](./FLEET_LEDGER_AND_SCHEDULING.md)。

---

## 1. Canonical identity

The canonical product and repository brand is **Agent Fleet**.

The following identifiers remain compatibility or historical surfaces until a deliberate product migration is specified:

- GitHub repository and npm package names containing claude-fleet.
- VS Code command IDs, configuration keys, extension classes, debug flags, and state paths containing Claude Fleet.
- Historical Pixel Agents / Claude Fleet migration references.
- Existing user state and persisted metadata.

New architecture documents, feature specs, UI copy, and new APIs must use Agent Fleet. This round does not perform a package, command, configuration, persisted-state, or GitHub rename.

---

## 2. Positioning and boundaries

Agent Fleet owns the management plane:

- runtime instance identity and lifecycle ownership;
- provider/profile/model selection and launch metadata;
- repository, workspace, worktree, host, and terminal binding;
- session continuity and native resume;
- normalized events and current telemetry;
- durable task/session/PR/usage/quality/assignment history;
- policy-aware recommendations and, later, approved execution;
- presentation projections such as Fleet Command and Pixel Office.

The native runtime owns agent behavior:

- conversation and reasoning;
- tool execution and permissions;
- hooks, JSONL, subagents, teams, and session history;
- native CLI semantics and provider-specific behavior.

The boundary is intentionally explicit:

```text
Agent Fleet manages the runtime.
The native CLI remains the Coding Agent.
```

Agent Fleet is not a Claude Code replacement, Codex replacement, conversation engine,
agent-to-agent chat bus, distributed orchestration framework, or automatic merge authority.

---

## 3. Current implementation versus v1 target

### Current implementation baseline

The repository currently contains:

- a VS Code Extension host under adapters/vscode;
- TypeScript core contracts and provider/profile/session logic under core;
- the Claude Fleet server and Claude Code hook/JSONL integration under server;
- the existing Pixel Office webview scene under webview-ui;
- the merged Python measurement and usage project under agentmetrics;
- runtime-neutral Fleet identity, FleetInstance, Mission, WorkItem, and RuntimeAdapter type
  contracts, plus a preliminary FleetEvent/Telemetry pipeline in the local worktree.
- a side-effect-free FleetStrategyAdapter with ResourceDirective input and explainable
  `recommend_assignment` Control API responses recorded as AssignmentDecision metadata.
- a thin VscodeFleetRuntimeHost boundary for current Fleet-managed Claude Code launch, focus,
  stop, restart, and resume entry points, including safe ownership metadata.

The currently reliable Fleet-managed runtime is **Claude Code CLI**. Existing capabilities include
multiple Claude instances, provider profiles, launch resolution, native session resume,
provider switching, auto discovery, status projection, and terminal focus.

Codex CLI now has a runtime adapter, a thin Codex FleetRuntimeHost boundary, and an in-memory
ControlService path covered by fake-only tests. Its real process/terminal bridge is not yet
connected, so Codex execution is not claimed as production-ready.

The current local codebase still contains legacy Claude Fleet names. They are documented as
compatibility surfaces; this architecture document does not claim that code-brand migration is complete.

### v1 target

The v1 managed runtime set is:

```text
Claude Code CLI
Codex CLI
```

Both are RuntimeAdapters behind the same runtime-neutral FleetInstance model. v1 does not
make a runtime-specific assumption in the Mission, WorkItem, Role, Ledger, Strategy, or UI layers.

The following are target abstractions and are not all implemented in the current baseline:

- generic FleetRuntimeHost lifecycle and multi-host resolution;
- Fleet Control API MCP surface and remote transport beyond the local HTTP boundary;
- managed Coordinator instances;
- durable Mission and WorkItem orchestration;
- durable Fleet Ledger persistence (the current store is in-memory);
- ResourceAccount and provider-specific Quota adapters;
- SCM and PR quality adapters;
- strategy accuracy evaluation and durable ResourceDirective history;
- Instance Detail and Terminal Dock management UI;
- policy-controlled autonomous execution and scheduling.

---

## 4. Target system topology

```text
External Coordinator
  Codex Desktop or another approved client
        |
        | Fleet Control API / MCP
        v
Control Plane
  Mission / WorkItem / Role / Policy / Strategy
        |
        v
FleetRuntimeHost
  FleetHost -> WorkspaceHost -> VS Code Integrated Terminal
        |
        v
RuntimeAdapter
  Claude Code CLI | Codex CLI | future runtime
        |
        +--> Native runtime process and session
        +--> FleetEvent Normalizer
        +--> Resource / usage evidence
        +--> SCM / worktree evidence
        |
        v
Telemetry Store -> UI projections
Fleet Ledger    -> history, metrics, recommendations, audit
```

The UI is a management projection. The terminal remains the runtime interaction surface. A
scene must never parse provider-specific raw logs directly.

---

## 5. Runtime-neutral domain model

The domain layer uses runtime-neutral concepts. A simplified FleetInstance contains:

```text
instanceId
missionId
workItemId
runtimeType
role
hostId
workspaceId
repo
worktree
sessionId
terminalId
managedByFleet
providerProfileId
providerDisplayName
modelId
resourceAccountId
status
parentAgentId
leadAgentId
createdAt
lastActivityAt
```

The domain separates:

- Runtime: the native executable and its adapter.
- Role: coordinator, worker, reviewer, debugger, researcher, or another assigned function.
- ProviderProfile: a configured connection/account profile.
- Model: the selected runtime model identifier.
- Session: a native conversation/session identity.
- Mission: the top-level unit of work.
- WorkItem: an assignable unit within a Mission.
- Host: the process/terminal/workspace location that owns execution.
- Telemetry: current and recent observable state.
- Ledger: long-lived historical facts and derived records.
- Recommendation: a proposed decision, not an executed action.

Runtime is not Role. Any managed Claude or Codex instance may eventually hold any role. The
current implementation may still use Claude workers in the existing workflow, but the target
model must not encode Claude equals worker or Codex equals coordinator.

---

## 6. RuntimeAdapter boundary

Each native runtime is integrated through a RuntimeAdapter rather than reimplemented inside
the control plane.

The target adapter boundary includes:

```text
id
displayName
runtimeType
capabilities
detect()
getVersion()
buildLaunchSpec()
launch()
stop()
focus()
restart()
resume()
discover()
observe()
normalizeEvent()
```

A capability is explicit and testable. Unsupported operations return unavailable or a clear
capability error; they are not simulated by guessing from UI state.

The v1 adapters are:

- ClaudeCodeRuntimeAdapter for claude or its platform-specific launcher.
- CodexRuntimeAdapter for codex or its platform-specific launcher.

Future adapters are deferred but fit the same boundary:

- Gemini CLI;
- OpenCode;
- Qoder CLI;
- Custom Agent Runtime.

All Claude executable discovery and launch checks must use one resolver. On Windows the resolver
may resolve claude.cmd or claude.exe; on macOS/Linux it may resolve claude. It must use PATH
and supported installation discovery without hardcoding a user name or changing the system PATH.

---

## 7. Fleet host and terminal ownership

A FleetRuntimeHost is the target owner of managed runtime creation. It is intentionally
separate from RuntimeAdapter:

- FleetHost identifies the Fleet controller and host process.
- WorkspaceHost resolves repository, workspace, worktree, and workspace path.
- FleetRuntimeHost owns the launch request, terminal binding, process identity, and lifecycle
  handoff to the RuntimeAdapter.
- RuntimeAdapter knows how to describe and operate the native CLI.
- The VS Code Integrated Terminal is the preferred human-visible execution surface.

The target launch flow is atomic from the control plane perspective:

```text
Mission / WorkItem
  -> resolve FleetHost
  -> resolve WorkspaceHost and worktree
  -> resolve RuntimeAdapter
  -> resolve provider/profile/model/resource
  -> create or bind VS Code Integrated Terminal
  -> launch native CLI
  -> record instance/session/terminal identity
  -> consume normalized events
```

A direct arbitrary shell spawn from a Coordinator is not the target lifecycle path. A
Coordinator requests a launch through the Fleet Control API; the host enforces policy and
records ownership before or together with process creation.

Default UX requirements:

- launch in a new integrated terminal without stealing focus;
- allow the user to focus that real terminal explicitly;
- preserve terminal identity across status updates;
- stop/restart the managed process without pretending the terminal is a chat panel;
- never create a duplicate instance on native session resume.

Mission resolution must support multiple hosts:

```text
Mission
  -> FleetHost
  -> WorkspaceHost
  -> Repo / Worktree
  -> Terminal
  -> RuntimeAdapter
```

The same Mission may contain instances on different workspaces or hosts. Cross-host support is
a resolution and accounting problem, not permission to share a checkout unsafely.

---

## 8. Coordinator topologies

### External Coordinator

The current workflow commonly starts with Codex Desktop as an external Coordinator:

```text
Codex Desktop primary thread
        |
        | planning, task assignment, review
        v
Git / Specs / Tasks / Commits / Tests
        |
        v
Agent Fleet in VS Code
        |
        +--> Claude Code CLI workers
        +--> future Codex CLI workers
```

Codex Desktop is not currently a Fleet-managed runtime instance. The current extension does
not launch, stop, monitor, or visualize the Codex Desktop client.

The target external path is:

```text
Codex Desktop
  -> Fleet Control API or MCP
  -> policy and resource checks
  -> FleetRuntimeHost
  -> native Claude/Codex CLI
```

### Managed Coordinator

The v1 target also permits a managed Coordinator:

```text
Managed Codex CLI or Claude Code CLI instance
        |
        v
Fleet Control API
        |
        v
FleetRuntimeHost
        |
        +--> managed worker instances
```

A managed Coordinator is still a normal FleetInstance. It is distinguished by Role and Policy,
not by a second orchestration implementation. Generic Coordinator election and agent-to-agent
chat are deferred.

---

## 9. Repository, worktree, and shared state

Repository artifacts are the default source of truth between agents:

- Git commits and diffs;
- requirements, design, and tasks documents;
- AGENTS.md, CLAUDE.md, and runtime-specific instruction files;
- tests, scripts, build output, review findings, and PR metadata;
- .agent knowledge and history.

Do not copy complete agent conversations between workers. A future message or handoff API may
carry a concise task reference, but the durable truth remains in repository artifacts.

Multiple agents must not write the same checkout concurrently unless explicit ownership is
known and policy allows it. Prefer a dedicated worktree per active WorkItem. If worktree state
cannot be verified, surface the risk rather than inventing isolation.

The target identity records include repo, checkout, worktree, branch, host, workspace, terminal,
session, and launch source so that an assignment can be audited later.

---

## 10. Observability boundary

All runtime-specific signals are normalized before presentation or strategy:

```text
Claude Hooks
Claude JSONL
Codex JSONL
AgentState
Provider/session metadata
Resource evidence
SCM evidence
        |
        v
FleetEvent
        |
        v
FleetTelemetryStore
        |
        +--> per-instance Snapshot
        +--> bounded recent event history
        +--> Scene Model / UI projections
        +--> Ledger ingestion references
```

FleetEvent is the observability normalization boundary. It may describe session lifecycle,
agent lifecycle, tool activity, task status, waiting/idle/working/error, subagent relations,
provider changes, handoffs, and safe resource evidence when a real source provides it.

Telemetry answers “what is true now and what happened recently.” It must not pretend to know
fields that the signal cannot supply. Unknown context, cost, quota, task, or error data is
unavailable.

FleetTelemetryStore is intentionally lightweight: in-memory current state plus bounded recent
events and necessary metadata. It is not a cloud backend, distributed tracing platform, or
database requirement for the first implementation.

---

## 11. Ledger, resources, and strategy boundaries

Telemetry and Ledger are different layers.

- Telemetry is current and event-oriented.
- Ledger is durable and record-oriented.
- Metrics are derived views over ledger evidence.
- Strategy consumes metrics, resource state, policy, and risk.
- Recommendation proposes an assignment or launch; execution is a separate policy-controlled step.

Token, Cost, and Quota are different facts:

```text
Token = model input/output accounting when available
Cost  = billed or estimated monetary amount
Quota = subscription, credit, rate-limit, or capacity availability
```

A token count must not be converted into a cost or remaining quota without a provider/resource
policy and evidence source. A missing quota endpoint is unavailable, not unlimited.

ResourceAdapter supplies ResourceAccount and quota/usage evidence. The Ledger must preserve source,
confidence, availability, and whether a value is estimated or actual. Strategy may consider:

- capabilities and role fit;
- historical quality and review outcomes;
- elapsed time and speed;
- token use and context pressure;
- metered cost or subscription budget;
- quota reserve and rate limits;
- current load and concurrency;
- provider/model availability;
- repo/worktree conflict risk;
- review and merge policy.

Strategy may recommend launching a new Claude or Codex instance when an existing assignment
cannot satisfy the Mission within policy. The recommendation must record why, expected impact,
budget, and constraints. It must not launch a process directly.

The detailed record types, formulas, adapters, permissions, and guardrails are in
[FLEET_LEDGER_AND_SCHEDULING.md](./FLEET_LEDGER_AND_SCHEDULING.md).

---

## 12. Adapter separation

The target control plane keeps these adapter families separate:

```text
RuntimeAdapter
  native runtime lifecycle and event normalization

ResourceAdapter
  account, token, cost, quota, rate-limit, and capacity evidence

ObservabilityAdapter
  external traces, hooks, logs, or metrics into FleetEvent

SCMAdapter
  repository, branch, worktree, diff, commit, PR, review, and merge evidence

StrategyAdapter
  scoring, candidate selection, recommendation, and strategy evaluation
```

No adapter should smuggle provider secrets or provider-specific assumptions into the UI. External
observability tools are extension points only; no concrete third-party observability dependency
is selected by this document.

---

## 13. Policy and execution modes

Control is explicit and auditable:

```text
observe
  collect and display state only

suggest
  produce a recommendation; do not execute

approve
  execute only after a human or approved Coordinator accepts

autonomous
  execute within an explicit policy envelope
```

The default product modes are suggest and approve. Autonomous mode is a later capability and
requires, at minimum:

- token/cost budget;
- concurrency limit;
- quota reserve;
- approved runtime/provider/model;
- repo/worktree isolation;
- review and merge policy;
- stop conditions and rollback/abort behavior;
- audit records for requestedBy, launchSource, and policy decision.

Permissions are not inferred from a UI label such as Plan Mode. Fleet policy is the actual
boundary.

---

## 14. Presentation and scene architecture

Runtime and Telemetry produce a shared Scene Model. Scene renderers consume that model and share
selection and commands:

```text
Runtime / Telemetry
        |
        v
Scene Model
   +----+----------------+
   |                     |
Pixel Office       Fleet Command
```

Pixel Office remains a supported scene, not a discarded legacy product. Fleet Command is the
default target scene. Both must preserve the existing Pixel Agents behavior semantics:

- spawn and removal;
- working, waiting, idle, starting, stopped, error;
- completion feedback;
- selection and terminal focus;
- auto discovery and external adoption;
- subagent and team relationships;
- stable identity across resume/restart/provider switch.

Fleet Command maps an Agent to an original pixel vessel:

- lead or future coordinator: flagship;
- worker: frigate;
- reviewer: recon vessel;
- subagent: drone;
- discovered external instance: external vessel.

The text status remains normal engineering language. Animation is a projection of a real
state/event; it may not invent token use, task progress, cost, or agent relationships.

The management layout may include Fleet List, Scene, Telemetry/Instance Detail, and Recent
Events. Selecting an instance opens Instance Detail. Focus Terminal routes to the real VS Code
integrated terminal. These are separate actions. The first implementation remains React/Canvas 2D
and responsive to VS Code panel size; no Three.js, WebGL, 3D battle scene, or TUI clone is
required.

---

## 15. Auto Discovery and external adoption

Auto Discovery is a compatibility and adoption path, not lifecycle ownership.

A manually started claude process may be discovered and represented as:

```text
managedByFleet = External
provider = Unknown when not proven
session = discovered native session
```

A Fleet-launched process is managed by Fleet and carries launch/session/terminal identity. Discovery
must upsert by stable native identity, especially session ID, so restart, resume, and provider
switch do not create duplicate vessels.

Provider, model, quota, cost, and task metadata must not be inferred from an unknown process or
from visual state. Unknown values remain unavailable.

---

## 16. Explicit non-goals for this documentation round

This round updates architecture documentation only. It does not implement:

- Codex RuntimeAdapter;
- FleetRuntimeHost or FleetRuntimeHost process creation;
- Fleet Control API or MCP server;
- Mission/WorkItem durable orchestration;
- Ledger database or automatic scheduler;
- Strategy Engine or autonomous dispatch;
- Instance Detail UI or Terminal Dock;
- generic coordinator election;
- Agent-to-agent chat bus;
- automatic PR merge;
- new external observability library;
- package/repository/command brand migration;
- VSIX packaging or release.

---

## 17. Architecture acceptance checklist

Before claiming the target architecture is implemented, verify:

- Claude Code CLI and Codex CLI are the only v1 managed runtime types;
- Runtime and Role remain independent;
- every managed launch is owned by FleetRuntimeHost;
- Mission resolution identifies host, workspace, worktree, terminal, runtime, and session;
- FleetEvent is the only presentation/strategy event boundary;
- Telemetry, Ledger, Token, Cost, and Quota remain separate;
- every recommendation is explainable and distinct from execution;
- default permissions are suggest/approve;
- no secret, transcript, or raw authorization data enters telemetry or the Ledger;
- Pixel Office and Fleet Command consume the same Scene Model;
- selection and terminal focus remain real runtime actions;
- discovery, resume, restart, subagent, and team identities remain deduplicated;
- current implementation gaps are represented as deferred work, not silently simulated.

---

## Related documents

- [PROJECT.md](./PROJECT.md)
- [ROADMAP.md](./ROADMAP.md)
- [FLEET_LEDGER_AND_SCHEDULING.md](./FLEET_LEDGER_AND_SCHEDULING.md)
- [WORKFLOW_CODEX_CLAUDE.md](./WORKFLOW_CODEX_CLAUDE.md)
- [.agent/knowledge/decisions.md](../.agent/knowledge/decisions.md)
- [spec index](./specs/README.md)
