import { useEffect, useState } from 'react';

import type { AgentInfo } from '../../hooks/useExtensionMessages.js';
import type { Character } from '../types.js';
import { formatAgentStatusLabel } from './agentStatus.js';

interface OfficeAgentDetailProps {
  id: number;
  character: Character;
  info?: AgentInfo;
  status?: string;
  activity?: string;
  onFocus: () => void;
  onClose: () => void;
}

function formatElapsed(createdAt?: number): string {
  if (!createdAt || !Number.isFinite(createdAt)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, '0')}m`
    : `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

function formatTokens(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '未采集';
  return value.toLocaleString();
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 truncate text-[13px] leading-none opacity-75">{label}</dt>
      <dd className="min-w-0 truncate text-[15px] leading-tight" title={value}>
        {value}
      </dd>
    </div>
  );
}

/** Compact detail card for single-click selection in the Pixel Office. */
export function OfficeAgentDetail({
  id,
  character,
  info,
  status,
  activity,
  onFocus,
  onClose,
}: OfficeAgentDetailProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const name = character.displayName ?? info?.displayName ?? character.agentName ?? `Agent #${id}`;
  const runtime =
    info?.runtime === 'codex-cli'
      ? 'Codex CLI'
      : info?.runtime === 'claude-code'
        ? 'Claude Code'
        : '—';
  const role = character.isTeamLead
    ? 'Coordinator'
    : (character.agentName ?? (character.isSubagent ? 'Subagent' : 'Worker'));
  const statusLabel = formatAgentStatusLabel(status) ?? 'Idle';
  const currentWork = activity ?? character.currentTool ?? statusLabel;
  const usage = character.usageTokens;
  const contextTokens =
    character.contextTokens > 0 ? formatTokens(character.contextTokens) : '未采集';

  return (
    <aside
      className="office-agent-detail absolute right-2 top-2 z-20 flex min-w-0 flex-col overflow-x-hidden overflow-y-auto border-2 border-accent bg-bg/95 p-3 shadow-pixel"
      style={{
        boxSizing: 'border-box',
        width: 'min(320px, calc(100% - 16px))',
        maxHeight: 'calc(100% - 16px)',
      }}
      data-testid="office-agent-detail"
    >
      <header className="flex min-w-0 items-start justify-between gap-2 border-b border-border pb-2">
        <div className="min-w-0">
          <div
            className="truncate text-[20px] font-bold leading-tight text-accent-bright"
            title={name}
          >
            {name}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[14px] leading-tight opacity-80">
            <span className="truncate" title={role}>
              {role}
            </span>
            <span aria-hidden="true">·</span>
            <span className="truncate" title={statusLabel}>
              {statusLabel}
            </span>
          </div>
        </div>
        <button
          className="shrink-0 px-1 text-[16px] leading-none opacity-70 hover:opacity-100"
          onClick={onClose}
          aria-label="关闭详情"
        >
          ×
        </button>
      </header>

      <section className="mt-3" aria-label="运行信息">
        <div className="mb-2 text-[13px] font-bold uppercase tracking-[1px] text-accent-bright">
          运行信息
        </div>
        <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2">
          <DetailMetric label="Runtime" value={runtime} />
          <DetailMetric label="状态" value={statusLabel} />
          <DetailMetric label="Provider" value={info?.providerDisplayName ?? '—'} />
          <DetailMetric label="Model" value={info?.modelId ?? '—'} />
          <DetailMetric label="运行时间" value={formatElapsed(info?.createdAt)} />
          <DetailMetric label="累计 Token" value={formatTokens(usage?.totalTokens)} />
          <DetailMetric label="输入 Token" value={formatTokens(usage?.inputTokens)} />
          <DetailMetric label="输出 Token" value={formatTokens(usage?.outputTokens)} />
          <DetailMetric label="缓存 Token" value={formatTokens(usage?.cachedInputTokens)} />
          <DetailMetric label="上下文 Token" value={contextTokens} />
          <DetailMetric label="Agent ID" value={`#${id}`} />
        </dl>
      </section>

      <section className="mt-3 min-w-0 border-t border-border pt-2" aria-label="当前工作">
        <div className="mb-1 text-[13px] font-bold uppercase tracking-[1px] text-accent-bright">
          当前工作
        </div>
        <div className="min-w-0 truncate text-[15px] leading-tight" title={currentWork}>
          {currentWork}
        </div>
      </section>

      <button
        className="mt-3 w-full border-2 border-accent bg-accent py-2 text-[15px] leading-tight text-white hover:opacity-90"
        onClick={onFocus}
        data-testid="office-agent-focus"
      >
        聚焦终端
      </button>
    </aside>
  );
}
