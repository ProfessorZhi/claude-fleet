// Core package: shared types, interfaces, and protocol definitions
// Everything in this package is types-only (no runtime behavior)

export type { StateAdapter } from './adapter.js';
export {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from './constants.js';
export type {
  FleetControlAction,
  FleetControlApi,
  FleetControlDecision,
  FleetControlPolicy,
  FleetControlRequest,
  FleetControlResponse,
  FleetLaunchTemplate,
  FleetMissionInput,
  FleetWorkItemInput,
} from './controlContracts.js';
export { validateFleetControlRequest, validateLaunchTemplate } from './controlContracts.js';
export type { FleetIdentity } from './fleetContracts.js';
export { toFleetWireIdentity, validateFleetIdentity } from './fleetContracts.js';
export type {
  FleetContextUsage,
  FleetEvent,
  FleetEventType,
  FleetTelemetryProjection,
  FleetTelemetrySnapshot,
} from './fleetTelemetry.js';
export { FleetTelemetryStore, normalizeAgentBroadcast } from './fleetTelemetry.js';
export type {
  AgentPerformanceAggregate,
  AssignmentAction,
  AssignmentApproval,
  AssignmentDecision,
  BillingMode,
  BillingPeriod,
  BillingPriceSource,
  ControlDecisionRecord,
  CostAmount,
  CostBasis,
  DataAvailability,
  EstimateOrActual,
  ExpectedActual,
  ExpectedActualMetrics,
  LaunchRecord,
  LaunchSource,
  LaunchTemplate,
  LedgerEvidence,
  LedgerMeasurement,
  LedgerSource,
  MissionRecord,
  QualitySignal,
  QualitySignalKind,
  QuotaSnapshot,
  QuotaUnit,
  QuotaUsageImpact,
  QuotaValue,
  QuotaWindow,
  ResourceAccount,
  ResourceAccountKind,
  ResourceMetrics,
  SafeMetadata,
  SafeMetadataPrimitive,
  SafeMetadataValue,
  SessionMode,
  SessionRecord,
  SessionStatus,
  SubscriptionCostAllocation,
  TokenUsage,
  UsageAggregation,
  UsageCostBreakdown,
  UsageRecord,
  WorkItemRecord,
} from './ledgerContracts.js';
export {
  isLedgerPayloadSafe,
  normalizeSafeMetadata,
  validateLedgerPayload,
} from './ledgerContracts.js';
export type { ClientMessage, FurnitureAssetMessage, ServerMessage } from './messages.js';
export type { AgentEvent, HookProvider } from './provider.js';
export type {
  AuthMode,
  InstanceLaunchConfig,
  ModelProfile,
  ProviderProfile,
  ResolvedLaunchConfig,
  ResolvedLaunchSafeMetadata,
} from './providerProfiles.js';
export {
  INHERIT_PROVIDER_PROFILE_ID,
  isInstanceLaunchConfig,
  isProviderProfile,
  makeInheritProviderProfile,
  validateProviderProfile,
} from './providerProfiles.js';
export type {
  AgentRole,
  CoordinatorRef,
  FleetControlMode,
  FleetInstance,
  FleetManagement,
  FleetRuntime,
  FleetRuntimeHost,
  FleetStatus,
  Mission,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeLaunchRequest,
  RuntimeLaunchResult,
  WorkItem,
} from './runtimeContracts.js';
export type {
  AgentMeta,
  ColorValue,
  Disposable,
  FloorColor,
  FurnitureCatalogEntry,
  HookEvent,
  OfficeLayout,
  PersistedAgent,
  PlacedFurniture,
  SpriteData,
} from './schemas.js';
export type {
  ResourceDirective,
  ResourceDirectiveTarget,
  StrategyAdapter,
  StrategyCandidate,
  StrategyConstraint,
  StrategyFactor,
  StrategyFactorImpact,
  StrategyInput,
  StrategyObjective,
  StrategyPolicy,
  StrategyRecommendation,
} from './strategyContracts.js';
export {
  costValue,
  isDirectiveActive,
  normalizeResourceDirective,
  normalizeStrategyText,
} from './strategyContracts.js';
export type { TeamProvider } from './teamProvider.js';
