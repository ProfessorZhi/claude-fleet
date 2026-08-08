# Templates — 可复用文档脚手架

> 这里存放项目中**反复出现**的文档模板，让 Agent 不必每次重新发明结构。

**计划中的模板**（不要预先建空文件，按需添加）：

| 模板 | 用途 |
|---|---|
| `requirements.md` | 新 Feature Spec（`docs/specs/<slug>/requirements.md`） |
| `design.md` | 新 Feature Spec（`docs/specs/<slug>/design.md`） |
| `tasks.md` | 新 Feature Spec（`docs/specs/<slug>/tasks.md`） |
| `adr.md` | 新增 `.agent/knowledge/decisions.md` 条目 |
| `debug-report.md` | 可选：把一次 `debug.md` 流程结构化写出来 |
| `review-checklist.md` | 可选：可打印版 `.agent/workflows/review.md` |

**约定：**

- 每个模板一个文件，kebab-case 命名。
- 模板是**带占位符的脚手架**，不是成品文档。
- 每个模板应反向链接到消费它的 workflow（例如 `requirements.md` 模板应链接到
  `.agent/workflows/spec-coding.md`）。
- 模板结构如果和工作流实际演化分叉，**更新模板**，不要让两者漂移。

**不适合放在这里：**

- 项目决策或经验（→ `.agent/knowledge/`）。
- 项目架构（→ `docs/ARCHITECTURE.md`）。
- 任何"是内容而不是结构"的东西。