# Spec 011 — Fleet Command 信息架构收敛

## 目标

将 Fleet Command 从“带舰船背景的办公室式卡片页面”收敛为真正的 Agent Fleet 指挥中心：
舰队场景是主角，工程信息按需出现，常驻 UI 只保留影响决策的事实与动作。

## 要求

### R1 — Scene First

默认 Fleet Command MUST 让舰队场景占据主要视觉面积。舰船卡片只显示身份、角色、状态和
必要的 runtime badge；Repo 绝对路径、Provider、Model、Session、Tool 等细节只在实例详情中显示。

### R2 — Compact command bar

页面顶部 MUST 只有一条紧凑指挥栏，包含品牌、当前 Mission、Fleet/Office 场景切换、统计摘要、
New Agent 和设置入口（若当前已有设置入口）。不得同时显示重复的场景标题和浮动大面板。

### R3 — Mission Rail

左侧 Mission Rail MUST 保持约 210–230px，显示 Mission、Coordinator、任务进度和已有资源；
缺少 Mission 数据时显示紧凑的中性空状态，不得制造大型空白 Coordinator/Mission Status 面板。

### R4 — Details on demand

未选择 Agent 时 MUST 不显示常驻 Instance Detail 空框，中央场景应自动获得释放的宽度。选择舰船
后显示右侧详情；详情必须可关闭，关闭后回到无详情布局。

### R5 — Compact runtime dock

Terminal Dock MUST 是底部薄条，列出 Agent 名称、状态和 Focus 动作；不能用大型 Agent 卡片重复
主场景信息。Focus、Select、New Agent 仍必须保持可访问且可测试。

### R6 — Compact observability

Timeline/Recommendations MUST 以紧凑底部区域呈现。没有真实事件或推荐时显示短的 neutral empty
状态，不得占用主场景的大块高度。

### R7 — Readability boundary

工程详情、长文本、路径和按钮 MUST 使用 VS Code/system UI font；pixel 风格只用于品牌、标题、
舰船标签和状态视觉，不得牺牲可读性。

### R8 — State and behavior compatibility

改版 MUST 继续使用现有 FleetSceneModel、transport command 和 shared scene preference。不得为
视觉布局引入第二份 Agent 状态，也不得启动真实 Agent 任务。

### R9 — Validation

必须补充或更新 deterministic webview/E2E 覆盖：默认 Fleet Command、无选择时无详情、选择/关闭详情、
舰船选择、Terminal Dock focus、场景切换；既有 Pixel Office、server、package contract 测试不得回归。
