# Task Control Center Closure Requirements

## Goal

让默认的 Task Control Center 从“展示字段”升级为可扫描、可诊断、可执行的本地 Agent 控制台，同时继续复用 Fleet Controller 的单一事实源和三个前端共享的数据模型。

## Requirements

### R1. Attention 语义

系统必须把等待输入、等待权限、等待交互、错误、断开和完成未查看作为独立的注意事项语义。后端或遥测无法区分等待输入与等待权限时，界面必须显示“等待交互”，不得猜测具体原因。

### R2. Attention → Action

可执行的注意事项必须提供下一步操作：

- 等待权限：查看请求（聚焦对应终端）
- 等待用户输入：回复（聚焦对应终端）
- 等待交互未分类：打开终端
- CLI 错误或断开：重新启动
- 完成未查看：查看结果并清除未查看标记

### R3. Agent 行扫描结构

Agent 列表必须按固定列展示：身份、当前工作、运行时间、Token、连接。运行时和模型属于身份；任务和当前动作属于当前工作；长字段不得撑坏列布局。

### R4. Mission Strip

无活动 Mission 时，Mission 区必须是紧凑的条带，不得占据主要垂直空间。任务存在时显示任务标题、进度、运行时间和 PR 摘要；缺失数据继续显示“未采集”，不得显示伪造的零值。

### R5. Inspector 分组

选中 Agent 后，Inspector 必须按 Current Work、Connection、Usage、Session 分组。连接诊断继续区分 Terminal、CLI、Hook、Telemetry；Token 总量必须标明“含缓存”，当前上下文必须与累计用量分开。

### R6. 可读性与窄宽度

页面必须适合 VS Code Webview 长时间使用：主体文字至少 12px，核心内容至少 13px；采用低饱和中性色和 VS Code 主题变量；Agent 工作区可滚动，Inspector 在窄宽度下折叠到下方，不能通过压缩字体解决空间问题。

### R7. 单一事实源与无数据诚实表达

Task Control Center 只能从 Fleet Scene Model 投影状态，不得自行维护一份 Agent 状态。没有采集到的 Token、PR、工具或上下文必须显示“未采集”，不得用 0 代替。
