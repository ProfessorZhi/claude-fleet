# References — 外部调研与资料指针

> 这里放**指向仓库外部资料的指针**，而不是项目自身的知识。Claude Fleet 的 Agent 在
> 做调研、设计、对比时查阅这里。

**适合放在这里：**

- 对外部项目 / 库 / API 的调研笔记（例如对 Pixel Agents、VS Code Extension API、
  各 Coding Agent CLI 的研究）。
- Vendor 文档摘要（比去翻 vendor 网站更易 grep）。
- 架构参考 —— 文章、演讲、我们正在参考的同类项目。
- 调研结论：*"我们评估了 X，学到了什么。"*

**不适合放在这里：**

- 项目自身的架构决策（→ `.agent/knowledge/decisions.md`）。
- 可复用经验（→ `.agent/knowledge/lessons.md`）。
- 高风险坑（→ `.agent/knowledge/pitfalls.md`）。
- 任何"关于我们自己的系统"的描述（→ `docs/`）。

**建议子布局**（按需创建，不要预先建空目录）：

```text
references/
├── pixel-agents/         # 例如：对 Pixel Agents 上游项目的研究笔记
├── vscode-extension/     # VS Code Extension API 笔记
├── providers/            # 各 Provider 笔记（Anthropic / OpenAI / Google 等）
└── ...
```

每条内容建议做成单个 Markdown 文件，顶部有清晰标题，底部链接回原始来源。
如果某条参考演化成了"Agent 必须遵守的重复模式"，就晋升为 workflow
（`../workflows/`）。