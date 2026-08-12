# Spec 012 — Fleet Command 中文界面

## 目标

将 Fleet Command 的产品界面文案统一为简体中文，降低中文开发者使用时的认知成本；Runtime、
Provider、Model 等外部产品名和技术标识保留原文，避免改变事实数据。

## 要求

- Command Bar、Mission Rail、Fleet Scene、Instance Detail、Terminal Dock、Timeline 和提示信息使用中文。
- 舰船角色与舰型使用中文显示，但 DOM test id、数据字段和状态 CSS contract 保持稳定。
- `Working/Waiting/Error` 等状态保留内部英文枚举，显示层使用中文状态标签。
- 技术专名如 `Claude Code`、`Codex CLI`、Provider/Model ID、Repo 路径保持原文。
- Pixel Office 的现有行为与 E2E contract 不变。
