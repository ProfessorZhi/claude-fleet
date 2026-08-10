/**
 * ProviderRegistry — Spec 005.
 *
 * ProviderDefinition / ProviderPreset 层：产品支持的 Provider 类型模板。
 * Definition 不包含任何用户 Secret；它定义 id / displayName / providerType /
 * authStrategy / 官方验证过的 defaultEndpoint / requiredEnv / model hints。
 *
 * 两层分离（ADR-004）：
 *   - ProviderDefinition（本文件）＝ 模板（DeepSeek / MiniMax / Anthropic …）
 *   - ProviderProfile（providerProfiles.ts）＝ 用户配置实例（DeepSeek - Personal …）
 *
 * 纪律：
 *   - endpoint / env / model 只允许来自官方 Claude Code integration 文档；
 *   - 无法可靠验证的 preset 标记 `verified: false`，不编造任何值；
 *   - Runtime 核心禁止散落 `if (presetId === 'deepseek')`；唯一分支点是
 *     `providerType`（见 server/src/launchConfig.ts resolver）。
 *
 * 官方来源：
 *   - DeepSeek: https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/
 *   - MiniMax:  https://platform.minimax.io/docs/token-plan/claude-code
 */

export type ProviderType =
  | 'native-anthropic' // Claude account OAuth 登录（Claude Code 自身 auth）
  | 'anthropic-api' // Anthropic Console API Key
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'anthropic-compatible'; // 第三方 Anthropic-compatible 端点

/** Auth strategy（语义对应用户设计稿 authStrategy）。 */
export type ProviderAuthStrategy =
  | 'native-login' // 不注入任何 ANTHROPIC_*；用 Claude Code 自身登录态
  | 'api-key' // ANTHROPIC_API_KEY（X-Api-Key header）
  | 'auth-token' // ANTHROPIC_AUTH_TOKEN（Authorization: Bearer）
  | 'external-credential-chain'; // AWS/GCP/Azure 原系统凭据链；Fleet 不复制 Secret

/** 官方文档来源锚点（attribution / 可验证性）。 */
export interface ProviderDefinitionSource {
  label: string;
  url: string;
}

export interface ProviderDefinition {
  /** 稳定 id（presetId 引用此值）。如 'deepseek' / 'minimax' / 'anthropic-account'。 */
  id: string;
  displayName: string;
  providerType: ProviderType;
  runtime: 'claude-code';
  authStrategy: ProviderAuthStrategy;
  /** 官方稳定端点；仅官方文档验证后填充。 */
  defaultEndpoint?: string;
  /** 官方文档验证过的模型 hints（仅建议，非强制）。 */
  supportedModelHints?: string[];
  /** 官方文档要求的额外 env（值不含 secret）。 */
  requiredEnv?: Record<string, string>;
  /** 官方信息是否已验证；false 时 profile 只能手动 Custom 配置。 */
  verified: boolean;
  /** 官方文档来源。 */
  source?: ProviderDefinitionSource;
  /** 中文 / 人类可读说明。 */
  description: string;
}

// ── 官方验证的 Definitions ─────────────────────────────────

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'anthropic-account',
    displayName: 'Anthropic Account',
    providerType: 'native-anthropic',
    runtime: 'claude-code',
    authStrategy: 'native-login',
    verified: true,
    description: '使用 Claude Code 自身登录态（claude auth login），不注入任何环境变量。',
    source: {
      label: 'Claude Code CLI (claude auth login / claude auth status)',
      url: 'https://code.claude.com/docs/en/authentication',
    },
  },
  {
    id: 'anthropic-api',
    displayName: 'Anthropic API',
    providerType: 'anthropic-api',
    runtime: 'claude-code',
    authStrategy: 'api-key',
    defaultEndpoint: 'https://api.anthropic.com',
    verified: true,
    description: 'Anthropic Console API Key（ANTHROPIC_API_KEY）。',
    source: { label: 'Claude Code env-vars', url: 'https://code.claude.com/docs/en/env-vars' },
  },
  {
    id: 'bedrock',
    displayName: 'Amazon Bedrock',
    providerType: 'bedrock',
    runtime: 'claude-code',
    authStrategy: 'external-credential-chain',
    verified: true,
    description: '使用 AWS 原系统凭据链（环境变量 / ~/.aws）；Fleet 不复制 AWS Secret。',
    source: { label: 'Claude Code Bedrock docs', url: 'https://code.claude.com/docs/en/bedrock' },
  },
  {
    id: 'vertex',
    displayName: 'Google Vertex AI',
    providerType: 'vertex',
    runtime: 'claude-code',
    authStrategy: 'external-credential-chain',
    verified: true,
    description: '使用 GCP 原系统凭据链（ADC / gcloud auth）；Fleet 不复制 GCP Secret。',
    source: { label: 'Claude Code Vertex docs', url: 'https://code.claude.com/docs/en/vertex' },
  },
  {
    id: 'foundry',
    displayName: 'Microsoft Foundry',
    providerType: 'foundry',
    runtime: 'claude-code',
    authStrategy: 'external-credential-chain',
    verified: true,
    description: '使用 Azure/Microsoft Foundry 原系统凭据链；Fleet 不复制 Azure Secret。',
    source: { label: 'Claude Code Foundry docs', url: 'https://code.claude.com/docs/en/foundry' },
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    providerType: 'anthropic-compatible',
    runtime: 'claude-code',
    authStrategy: 'auth-token',
    defaultEndpoint: 'https://api.deepseek.com/anthropic',
    supportedModelHints: ['deepseek-v4-pro[1m]', 'deepseek-v4-flash'],
    requiredEnv: {
      ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
    },
    verified: true,
    description: 'DeepSeek Anthropic-compatible API。ANTHROPIC_AUTH_TOKEN = DeepSeek API Key。',
    source: {
      label: 'DeepSeek API Docs — Integrate with Claude Code',
      url: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/',
    },
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    providerType: 'anthropic-compatible',
    runtime: 'claude-code',
    authStrategy: 'auth-token',
    // 官方双端点：国际 api.minimax.io / 中国 api.minimaxi.com。
    // 本项目默认面向中国 Token Plan 用户；国际用户可在 Profile 中改回国际端点。
    defaultEndpoint: 'https://api.minimaxi.com/anthropic',
    supportedModelHints: ['MiniMax-M3[1m]'],
    requiredEnv: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      ANTHROPIC_MODEL: 'MiniMax-M3[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3[1m]',
    },
    verified: true,
    description:
      'MiniMax M 系列 Anthropic-compatible API。ANTHROPIC_AUTH_TOKEN = MiniMax API Key。' +
      '中国区用户 endpoint 使用 https://api.minimaxi.com/anthropic。',
    source: {
      label: 'MiniMax API Docs — Claude Code',
      url: 'https://platform.minimaxi.com/docs/token-plan/claude-code',
    },
  },
];

/** 按 id 查 definition。 */
export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS.find((d) => d.id === id);
}

/** 只返回已验证的 definitions（供 Add Provider 列表使用）。 */
export function getVerifiedProviderDefinitions(): ProviderDefinition[] {
  return PROVIDER_DEFINITIONS.filter((d) => d.verified);
}
