# Task Control Center Closure Tasks

- [x] Add requirements and design for Mission Strip, Agent Row, Inspector and Attention actions.
- [x] Add derived attention model and compact usage projection.
- [x] Update Task Control Center interaction and layout.
- [x] Add regression tests for attention precedence, unread completion and compact labels.
- [x] Run type check, unit tests, E2E and package validation.

## Validation

- Webview: 122 tests passed.
- Server: 666 tests passed.
- Package contract: 7 tests passed.
- Task Control Center VS Code/Electron E2E: 1 test passed.
- Full E2E: reached the 10-minute safety timeout after 34/82 tests; the Task Control Center test passed. Four unrelated Areas seat-preference tests failed before the timeout.
- `npm run check-types`: passed.
- `npm run build:webview`: passed.
- `npm run lint`: no errors; one pre-existing `App.tsx` Hook dependency warning remains.
