# 005-provider-registry-session-continuity — Tasks

> 按序执行；每个 Task 完成后打勾（保留条目）。

## T1. ProviderDefinition 层（design D1/D2）

- [ ] 新建 `core/src/providerRegistry.ts`：`ProviderType` / `ProviderDefinition`
      接口 + 官方验证的 definitions（deepseek / minimax / anthropic-account /
      anthropic-api / bedrock / vertex / foundry，均 `verified` 标注，只含官方值）。
- [ ] 单元测试：definitions 数量与字段、deepseek/minimax 的 endpoint 与
      requiredEnv 与官方文档一致、`verified:false` 预设不含 endpoint/model。

## T2. ProviderProfile 数据模型扩展（design D1）

- [ ] 扩展 `core/src/providerProfiles.ts` `ProviderProfile`：
      `providerType / presetId / modelIds / enabled`（保留兼容既有字段）。
- [ ] 更新 `isInstanceLaunchConfig` / 相关 type guard；`migrateVsCodeState`
      兼容旧 profile 形状（默认 `providerType='anthropic-compatible'`,
      `enabled=true`）。

## T3. ProviderProfileStore 扩展

- [ ] `adapters/vscode/providerProfileStore.ts`：CRUD 支持 enabled 开关、
      modelIds 列表、edit（rename/endpoint/model list/secret 替换/删除/
      enable-disable）。
- [ ] 删除 profile 时同步 `SecretStorage.remove`（既有行为保留）。
- [ ] 测试：CRUD、edit、delete+secret 清理、disabled 隐藏。

## T4. Resolver 唯一真相（design D3）

- [ ] 扩展 `server/src/launchConfig.ts`：按 providerType 分支
      （native-login 不注入 ANTHROPIC_* / api-key 注入 API_KEY /
      auth-token 注入 BASE_URL+TOKEN / external-credential-chain 官方配置）。
- [ ] merge preset requiredEnv（DeepSeek DEFAULT_*_MODEL、MiniMax
      CLAUDE_CODE_AUTO_COMPACT_WINDOW）。
- [ ] 测试：4 类 providerType env 生成、不同 profile 独立 env、
      secret 不进 safeMetadata、无全局 mutation。

## T5. LaunchCommand：session/resume 参数（design D4）

- [ ] `claude.ts buildLaunchCommand` 支持
      `{ sessionMode: 'new' | 'resume', sessionId }`：
      new → `--session-id <uuid>`；resume → `--resume <sessionId>`。
- [ ] 测试：参数拼接（new/resume、带/不带 model）。

## T6. LaunchAgentFlow：只显示 configured profiles（FR-003/005）

- [ ] Provider picker 移除默认 Inherit 注入；只列 enabled profiles。
- [ ] 空列表 → `No Provider Profiles configured. [Add Provider]` 入口。
- [ ] 测试：无 Inherit 默认、只显示 enabled、空状态提示。

## T7. ManageProvidersFlow：Add/Edit/Delete（FR-004）

- [ ] Add Provider 展示全部 definition 类型（official/native + compatible）。
- [ ] Edit：rename / endpoint / model list / replace secret / enable-disable；
      secret 编辑 = Leave unchanged | Replace | Delete，不读回显示。
- [ ] Delete：store remove + secret remove；运行中 agent 不受影响，
      Restart/Switch 时 profile 不存在则明确报错。
- [ ] 测试：edit 各字段、secret 三种操作、delete 清理。

## T8. Native 登录探测（FR-005）

- [ ] `claude auth status` 探测封装（`cliCheck` 附近新模块），解析 JSON；
      失败/不可用 → 不做探测，仅显式 profile。
- [ ] 测试：mock 输出解析、命令缺失时降级。

## T9. Restart = 原生 Resume（FR-009/010）

- [ ] `agentControl.ts runRestartAgentCommand`：保存
      sessionId/cwd/provider/model → Stop → CLI check → 重取 Secret →
      launch `{ sessionMode: 'resume', sessionId }`。
- [ ] 新命令 `New Session`（同 repo/provider/model + 新 sessionId）。
- [ ] 测试：restart resume 同 sessionId；new session 不同 id；
      restart 失败不清除原 session 元数据。

## T10. Switch Provider（FR-011/012）

- [ ] 命令 `Claude Fleet: Switch Provider` + Debug View Agent 卡片入口。
- [ ] 流程：选 profile → 选 model → Stop → 同 cwd/sessionId +
      新 env → resume。
- [ ] resume 失败 → 明确提示 + 用户确认后才 fork/new（不静默）。
- [ ] 测试：switch 保持 cwd/sessionId、env/model 变更、B 不受影响、
      A 的 lastProviderProfileId 记录。

## T11. AgentState / PersistedAgent 元数据（FR-013）

- [ ] `managedByFleet?: boolean`、`lastProviderProfileId?: string` 入
      AgentState + PersistedAgent + persist/restore。
- [ ] launch 时登记 managedByFleet；legacy 兼容（undefined → 不假定）。

## T12. CLI providers/launch（FR-014）

- [ ] `claude-fleet providers`：list configured profiles。
- [ ] `claude-fleet launch`：交互选 Repo/Profile/Model/New-Resume →
      复用 resolver → spawn 原生 claude。
- [ ] 测试：providers list 输出、launch 参数透传（fake spawn）。

## T13. 全量验证

- [ ] check-types / lint / test / build 全绿。
- [ ] 更新 `docs/MANUAL_TEST_ALPHA.md`（Provider 相关测试项）。
