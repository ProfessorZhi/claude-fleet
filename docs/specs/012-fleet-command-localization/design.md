# Spec 012 — Design

本轮采用轻量 display-layer localization，不引入运行时 i18n 框架：Fleet Command 的静态文案集中
在组件中，状态通过 `statusLabel` 映射显示；`FleetSceneModel` 继续保留内部稳定英文枚举和外部事实。

这样既能立即统一当前 VS Code Webview，又不会把中文显示耦合进 Fleet Control API、Telemetry 或
未来的多语言数据合同。后续增加语言时再把静态文案抽为 locale dictionary。
