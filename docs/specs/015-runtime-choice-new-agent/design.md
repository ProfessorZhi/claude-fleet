# Design

`runLaunchAgentFlowWithLauncher` gains an optional runtime picker and Codex launcher callback. Existing Claude callers keep their current callback and provider flow unchanged.

```text
Coordinator Session
  -> New Agent
  -> Runtime QuickPick
     -> Claude Code: Repo -> Provider -> Model -> Claude terminal + hooks
     -> Codex CLI:   Repo -> local CLI check -> Codex terminal + local login
```

The VS Code adapter keeps one `AgentStateStore` and one ControlService. A Codex terminal is represented as a managed `AgentState` with `runtime = codex-cli`, `hooksOnly = true`, and no provider secret. The shared lifecycle runtime still owns focus/stop/remove, while `CodexRuntimeAdapter` owns executable resolution and command construction.

The Office webview remains a projection: it receives the same `agentCreated`, status, and diagnostic messages. No runtime-specific credential or transcript is sent to the webview.
