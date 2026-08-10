# Spec 011 — Design

## 页面骨架

```text
Command Bar  ─────────────────────────────────────────────────────────────
Mission Rail │ Fleet Formation Scene                         │ Detail (on demand)
             │                                                │
             └────────────────────────────────────────────────────────────
Terminal Dock ─────────────────────────────────────────────────────────────
Timeline / Recommendation ───────────────────────────────────────────────
```

默认无选择时采用 `rail + scene` 两列；选择 Agent 后再加入右侧 detail 列。布局变化只影响投影，
不改变 `FleetSceneModel`。

## 组件边界

- `FleetCommand`：拥有页面骨架、selection 和 command bar。
- `SceneToggle`：作为 command bar 内控件复用，并保持原有 test id。
- `MissionSidebar`：提供 compact Mission Rail；所有字段仍使用既有 `MissionSummary` 合同。
- `VesselCard`：身份/角色/状态的可访问 DOM hit target，Canvas 只负责世界视觉和效果。
- `TerminalDock`：compact 模式下为单行 runtime access strip。
- `FleetTimeline`：compact 模式下为薄 observability strip，事件详情仍可从组件测试读取。
- Instance Detail：只在 `selected !== null` 时挂载；关闭由父级清除 selection。

## 事实来源与交互

`App` 仍负责从 transport/OfficeState 生成 `FleetSceneModel`。Fleet Command 的选择只保存当前
投影 selection；Focus/Restart/Switch Provider/Stop 继续调用现有回调。布局不得创建 terminal 或
真实 runtime。

## 可视规则

- 主场景使用深空 navy、cyan、violet、amber、red 状态色。
- 详情面板和长文本继承 VS Code font。
- Repo 名称只在 Mission Rail/详情中显示，舰船标签不显示绝对路径。
- `prefers-reduced-motion`、页面 hidden 和 Canvas 30fps 策略保持不变。
