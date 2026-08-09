# WORKFLOW_CODEX_CLAUDE.md — Agent Fleet

This document defines how Codex and Claude Code cooperate around Agent Fleet. It describes the
current workflow and the v1 control-plane target separately.

---

## 1. Invariants

- Agent Fleet manages native Coding Agent runtimes; it does not replace them.
- Runtime is not Role. Claude Code or Codex CLI may eventually be Coordinator, Worker, Reviewer,
  Debugger, or Researcher.
- Git, Specs, Tasks, Tests, Commits, PRs, and safe .agent knowledge are the shared durable state.
- Do not copy complete conversations between agents.
- Do not introduce an Agent-to-Agent Chat Bus for the current workflow.
- A runtime instance must have an auditable Repo/Worktree, Host, Workspace, Terminal, Session,
  ProviderProfile, Model, and Managed/External identity when those values are available.
- Unknown Token, Cost, Quota, Task, Provider, or Context values are reported as unavailable.
- A UI animation is a projection of a real FleetEvent, never a source of telemetry truth.

---

## 2. Current workflow

The current reliable topology is:

```text
Codex Desktop / external primary thread
  planning, decomposition, assignment, review
        |
        v
Git / Specs / Tasks / Commits / Tests
        |
        v
Agent Fleet in VS Code
  Claude Code CLI Worker A -> terminal / worktree A
  Claude Code CLI Worker B -> terminal / worktree B
  Claude Code CLI Worker N -> terminal / worktree N
```

Codex Desktop is currently an external Coordinator. Agent Fleet does not launch, stop, monitor,
or visualize the Codex Desktop client as a Fleet-managed runtime.

Claude Code CLI remains the native execution engine. Agent Fleet manages its VS Code terminal,
repository binding, ProviderProfile, Model, Session, lifecycle, discovery, status, and focus
routing. Existing Claude subagents and teams remain native Claude behavior.

The current handoff is primarily repository-based:

```text
Codex understands the request
  -> writes or updates requirements/design/tasks
  -> assigns a bounded WorkItem to a Claude Code terminal
  -> Claude Code implements and validates
  -> Claude Code leaves commits, diffs, tests, and notes
  -> Codex reviews evidence
  -> Claude Code fixes findings
  -> Codex proposes merge after validation
```

---

## 3. Target mode A — External Coordinator

The v1 target allows an external Codex Desktop Coordinator to call Agent Fleet through a
controlled interface:

```text
Codex Desktop
   |
   | Fleet Control API or MCP
   v
Control Policy
   |
   +--> Resource / quota checks
   +--> Worktree / SCM checks
   +--> Strategy recommendation
   v
FleetRuntimeHost
   |
   v
VS Code Integrated Terminal
   |
   v
RuntimeAdapter
   |
   +--> Claude Code CLI
   +--> Codex CLI
   +--> future runtime
```

The target API is an extension point, not an excuse to start processes through arbitrary shell
commands. A request should identify:

- missionId;
- workItemId;
- requested runtime and role;
- repo, workspace, worktree, and branch constraints;
- provider profile and model constraints;
- resource account or quota constraints;
- requestedBy and launchSource;
- policy mode and review requirements.

The host resolves the request, records ownership, launches the native CLI, and returns a stable
FleetInstance/Session/Terminal identity. The Coordinator receives status and result references,
not an uncontrolled copy of the worker's full transcript.

Current state: runtime-neutral Control API contracts, an in-memory ControlService, the registered
RuntimeAdapter/FleetRuntimeHost execution boundary, and a side-effect-free FleetStrategyAdapter
are implemented for fake-tested management flows. `recommend_assignment` records an explainable
AssignmentDecision and can propose a new Claude/Codex launch template without starting it. MCP
transport and a real Codex terminal/process bridge remain deferred.

### Local Control API quick start

Open the Claude Fleet panel in VS Code first so its embedded server and managed Claude host are
ready. The primary Codex thread can then use the bundled local CLI bridge:

```powershell
npx claude-fleet control --request '{"requestId":"mission-001","action":"create_mission","mode":"suggest","requestedBy":"codex-primary","createdAt":1,"mission":{"missionId":"mission-001","title":"Telemetry","objective":"Normalize runtime signals","policyMode":"suggest"}}'
```

To request a managed Claude launch after explicit approval:

```powershell
npx claude-fleet control --request '{"requestId":"launch-001","action":"launch_instance","mode":"approve","requestedBy":"codex-primary","missionId":"mission-001","createdAt":2,"launch":{"runtime":"claude-code","role":"worker","repo":"F:/repo","cwd":"F:/repo","requestedBy":"codex-primary","policy":{"mode":"approve"}}}'
```

The CLI discovers the local authenticated server record; it never prints or accepts the bearer
token as part of the request payload. `suggest` returns `approval_required` without launching.
The current VS Code bridge manages Claude Code only. Codex Desktop remains the external
Coordinator, and Codex CLI process/terminal execution is still a separate integration slice.

### Coordinator resource directives and recommendations

The primary Codex thread may change the optimization objective with a time-bounded
`ResourceDirective`, for example “increase throughput before the Codex quota reset” or “avoid
the expensive DeepSeek profile”. The directive is evidence for Strategy, not an instruction
injected into a worker and not permission to bypass policy.

The recommendation request has the following shape:

```json
{
  "requestId": "recommend-001",
  "action": "recommend_assignment",
  "mode": "suggest",
  "requestedBy": "codex-primary",
  "missionId": "mission-001",
  "workItemId": "work-001",
  "createdAt": 2,
  "strategy": {
    "now": 2,
    "workItem": {
      "workItemId": "work-001",
      "missionId": "mission-001",
      "title": "Review",
      "objective": "Review the diff",
      "acceptanceCriteria": ["review recorded"],
      "status": "queued",
      "createdAt": 1
    },
    "candidates": [],
    "launchTemplates": [],
    "policy": { "mode": "suggest" },
    "directive": {
      "directiveId": "directive-001",
      "requestedBy": "codex-primary",
      "target": { "runtime": "codex-cli" },
      "objective": "throughput",
      "priority": 10,
      "reason": "Quota window is about to reset.",
      "createdAt": 1,
      "expiresAt": 360000
    }
  }
}
```

The result is a recommendation with selected candidates or a launch template, factors,
constraints, confidence, and expiry. A missing quota snapshot produces an explicit constraint;
token counts are never converted into quota or cost.

---

## 4. Target mode B — Managed Coordinator

The v1 model also permits a Fleet-managed Coordinator:

```text
Managed Codex CLI or Claude Code CLI instance
        |
        v
Fleet Control API
        |
        +--> Claude Code CLI worker
        +--> Codex CLI worker
        +--> reviewer / debugger / researcher
```

The Coordinator is a normal FleetInstance with role=coordinator. It uses the same Control API,
policy, resource checks, host resolution, RuntimeAdapter, telemetry, Ledger, and SCM boundaries
as every other managed instance.

There is no separate Coordinator Runtime implementation. Coordinator is a Role plus policy.

Current state: managed Coordinator execution is not implemented. Codex Desktop remains the
external Coordinator in the current workflow.

---

## 5. Work decomposition

Use a Mission as the top-level unit and WorkItems as bounded assignments.

A useful WorkItem includes:

```text
missionId
workItemId
objective
inputs
acceptanceCriteria
dependencies
repo / worktree
allowedRuntimeTypes
allowedRoles
provider/model constraints
budget and quota constraints
review policy
status
result references
```

Recommended decomposition:

1. Understand the request and identify the actual problem.
2. Write or update the relevant requirements and design.
3. Split independent WorkItems by ownership boundary.
4. Allocate one worktree per concurrent writer when possible.
5. Assign runtime and role according to evidence and policy.
6. Implement and validate in the assigned terminal.
7. Record commit, diff, test, error, and review evidence.
8. Review against acceptance criteria.
9. Fix findings in the owning WorkItem.
10. Produce a merge proposal; merge remains an explicit policy decision.

A worker should not silently expand its WorkItem into a new runtime, scheduler, provider
framework, or unrelated refactor. Request a new WorkItem when scope changes.

---

## 6. Roles

Roles describe responsibility, not executable technology:

| Role        | Responsibility                                                |
| ----------- | ------------------------------------------------------------- |
| Coordinator | decomposes Mission, assigns WorkItems, reviews evidence       |
| Implementer | changes code or docs within an accepted WorkItem              |
| Debugger    | isolates root cause and supplies a reproducible fix           |
| Reviewer    | checks design, diff, tests, security, and acceptance criteria |
| Researcher  | gathers bounded evidence and records sources/uncertainty      |

Current convention:

```text
Codex Desktop -> external Coordinator
Claude Code CLI -> Fleet-managed Worker / Implementer / Debugger / Reviewer
```

This is a workflow convention, not a permanent type constraint.

---

## 7. Control modes and permissions

Every control request has an explicit mode:

```text
observe
  read state and evidence only

suggest
  return an assignment or launch recommendation

approve
  execute only after explicit approval

autonomous
  execute within a pre-approved policy envelope
```

Default mode is suggest or approve. Autonomous mode is deferred and must be bounded by:

- maximum concurrent instances;
- token/cost budget;
- quota reserve;
- approved runtime/provider/model list;
- allowed repositories and worktrees;
- review/test/merge policy;
- stop conditions and failure handling;
- audit fields for requestedBy, launchSource, policy, and resulting AssignmentDecision.

A recommendation may suggest launching another Claude or Codex instance when this improves
time, quality, or quota safety. It must not directly launch a process. Execution goes through
Fleet Control API and FleetRuntimeHost.

---

## 8. Repository artifacts are the handoff protocol

Prefer these artifacts over chat forwarding:

```text
requirements.md
design.md
tasks.md
AGENTS.md / CLAUDE.md / CODEX.md
source changes
tests and scripts
commit and diff
PR and review findings
.agent/knowledge and history
FleetEvent / Telemetry snapshot references
```

A concise handoff should contain:

- WorkItem and Mission identifiers;
- current status and blocking condition;
- files changed;
- commit or diff reference;
- tests run and results;
- known risks and unavailable evidence;
- next action or review request.

Do not place API keys, access tokens, authorization headers, full environment variables,
unnecessary full prompts, or full transcripts in a handoff or Ledger record.

---

## 9. Terminal and UI behavior

The runtime plane is a real VS Code Integrated Terminal. The management plane is the Fleet UI.

The target interaction is:

```text
select instance
  -> open Instance Detail
  -> inspect actual metadata and recent telemetry
Focus Terminal
  -> focus the real VS Code Integrated Terminal
```

Instance Detail and Focus Terminal are different actions. A webview transcript or fake chat panel
does not replace the real native runtime terminal.

Fleet Command and Pixel Office are scene projections over the same Scene Model. Changing scenes
must not restart, fork, or mutate a runtime Session.

---

## 10. Telemetry and Ledger

Signals are normalized before the UI or future strategy sees them:

```text
Claude Hooks / Claude JSONL / Codex JSONL / AgentState / metadata
        |
        v
FleetEvent
        |
        +--> FleetTelemetryStore: current snapshot and bounded recent events
        +--> Fleet Ledger: durable session, usage, quality, assignment, and PR records
```

Telemetry reports what is observable now. The Ledger records durable historical evidence. Token,
Cost, and Quota are separate and retain source/confidence/estimated-versus-actual metadata.

The detailed data model is in [FLEET_LEDGER_AND_SCHEDULING.md](./FLEET_LEDGER_AND_SCHEDULING.md).

---

## 11. Validation loop

For each WorkItem:

```text
Understand
  -> Spec
  -> Plan
  -> Implement
  -> Validate
  -> Review
  -> Fix
  -> Merge proposal
```

Minimum validation is proportional to risk:

- docs: link/path consistency, diff check, Markdown structure;
- runtime: unit tests, resolver tests, lifecycle tests, no duplicate session tests;
- UI: scene selection, status transitions, terminal focus, responsive panel behavior;
- integration: fake launcher/events first; real API tests are manual and opt-in;
- merge: review findings resolved or explicitly accepted.

Do not burn external API quota in automated tests. Use fake launchers, fake events, and local
fixtures. Real Claude or Codex API/CLI testing is a separate Development Host/manual test.

---

## 12. Current non-goals

The current workflow does not implement:

- the real Codex CLI process/terminal bridge (the adapter and thin host boundary are present);
- MCP transport or remote Control API deployment (local HTTP/CLI control is present);
- generic Coordinator election;
- Agent-to-Agent Chat Bus;
- automatic scheduler or autonomous dispatch;
- automatic PR merge;
- arbitrary direct shell spawning as lifecycle ownership;
- a new observability vendor dependency;
- a new Agent Fleet branding migration.

These are roadmap items or extension points, not current behavior.

---

## Related documents

- [PROJECT.md](./PROJECT.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [ROADMAP.md](./ROADMAP.md)
- [FLEET_LEDGER_AND_SCHEDULING.md](./FLEET_LEDGER_AND_SCHEDULING.md)
- [spec index](./specs/README.md)
