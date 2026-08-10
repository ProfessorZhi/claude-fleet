# Runtime process smoke fixtures

`fixtures/claude` and `fixtures/codex` are deterministic Node-backed CLI
fixtures used by `server/__tests__/runtimeProcessSmoke.test.ts`.

The fixtures intentionally support only two safe boundaries:

- `--version`: returns a fixed version and exits;
- stdin: accepts the rendered bounded Fleet task brief and the test-only stop
  control event.

They do not access the network, read credentials, execute shell commands, write
transcripts, or echo arbitrary stdin. The smoke test spawns them as real child
processes, then drives the existing Claude/Codex adapter and host contracts.

Run the focused smoke test with:

```text
npx vitest run server/__tests__/runtimeProcessSmoke.test.ts
```

Real Claude/Codex CLI execution remains an explicit environment-only test and
is not part of automated validation.
