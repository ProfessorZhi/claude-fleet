# 008-fleet-command-scene — Design

## 场景接口

```ts
interface SceneRenderer {
  readonly id: 'fleet-command' | 'pixel-office';
  render(model: SceneModel): void;
  dispose(): void;
}
```

Runtime 只发布 AgentState/Fleet Telemetry；Scene Model 做一次语义投影，Office 和 Fleet
renderer 都消费它。不要把 Agent 行为系统复制一份。

## 第一版布局

```text
┌──────────────────────────────────────────────┐
│ CLAUDE FLEET   3 ACTIVE  1 WAITING           │
├──────────────┬───────────────────────────────┤
│ Fleet List    │ Fleet Command / Repo Groups   │
│ Repo          │ Flagship / Worker / Reviewer  │
│ Provider      │                               │
├──────────────┴───────────────────────────────┤
│ Telemetry: Task · Tool · Session · Usage      │
│ [Focus] [Restart] [Switch] [Stop]             │
└──────────────────────────────────────────────┘
```

## 视觉映射

| 工程实体    | 视觉实体            |
| ----------- | ------------------- |
| Coordinator | Flagship            |
| Implementer | Frigate             |
| Reviewer    | Recon Vessel        |
| Subagent    | Drone               |
| External    | Unidentified Vessel |
| Repo        | Task Area / System  |
| Session     | Voyage              |
| Provider    | Power badge         |

视觉主题不能改变工程术语，状态文字仍来自规范化 AgentState。

## 迁移策略

1. 抽象 scene model/renderer 边界；
2. 保持 Pixel Office 为正式可选 Scene，不称为废弃 UI；
3. Fleet Command 复用 Agent 生命周期、选择、Focus、Subagent 和 Auto Discovery；
4. 只有真实 FleetEvent 才触发舰船状态动画；
5. 通过持久化偏好切换 Scene，失败时回退到 Pixel Office。
