/* eslint-disable react-refresh/only-export-components -- this file intentionally exports pure timeline helpers for deterministic tests. */

import './DockAndTimeline.css';

export interface FleetTimelineEvent {
  id: string;
  observedAt: number;
  agentLabel: string;
  label: string;
  detail?: string;
  status?: string;
}

export interface FleetRecommendation {
  id?: string;
  title: string;
  reason?: string;
  estimatedDuration?: string;
  source?: string;
}

export interface FleetTimelineProps {
  events: readonly FleetTimelineEvent[];
  recommendation?: FleetRecommendation | null;
  maxEvents?: number;
  compact?: boolean;
}

export function selectRecentTimelineEvents(
  events: readonly FleetTimelineEvent[],
  maxEvents = 8,
): FleetTimelineEvent[] {
  const limit = Number.isFinite(maxEvents) ? Math.max(0, Math.floor(maxEvents)) : 8;
  return [...events].sort((left, right) => right.observedAt - left.observedAt).slice(0, limit);
}

export function formatTimelineTime(observedAt: number): string {
  if (!Number.isFinite(observedAt)) return '—';
  const date = new Date(observedAt);
  if (Number.isNaN(date.getTime())) return '—';
  return [date.getHours(), date.getMinutes()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function timelineDateTime(observedAt: number): string | undefined {
  if (!Number.isFinite(observedAt)) return undefined;
  const date = new Date(observedAt);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function recommendationHasContent(
  recommendation: FleetRecommendation | null | undefined,
): recommendation is FleetRecommendation {
  return Boolean(recommendation?.title.trim());
}

export function FleetTimeline({
  events,
  recommendation,
  maxEvents = 8,
  compact = false,
}: FleetTimelineProps) {
  const recentEvents = selectRecentTimelineEvents(events, maxEvents);

  return (
    <section
      className={`fleet-timeline-region ${compact ? 'fleet-timeline-region-compact' : ''}`}
      data-testid="fleet-timeline-region"
    >
      <div className="fleet-bottom-section-heading">
        <div>
          <div className="fleet-section-kicker">可观测性</div>
          <h2 className="fleet-section-title">时间线 / 建议</h2>
        </div>
        <span className="fleet-section-caption">仅展示遥测提供的实时事实。</span>
      </div>

      <div className="fleet-timeline-grid">
        <section
          className="fleet-timeline-panel"
          data-testid="fleet-timeline"
          aria-label="舰队时间线"
        >
          <div className="fleet-subsection-heading">
            <h3>最近事件</h3>
            <span>{recentEvents.length}</span>
          </div>
          {recentEvents.length > 0 ? (
            <ol className="fleet-timeline-list">
              {recentEvents.map((event) => (
                <li
                  key={event.id}
                  className="fleet-timeline-event"
                  data-testid={`fleet-timeline-event-${event.id}`}
                  data-status={event.status?.toLowerCase()}
                >
                  <time dateTime={timelineDateTime(event.observedAt)}>
                    {formatTimelineTime(event.observedAt)}
                  </time>
                  <span className="fleet-timeline-event-copy">
                    <span className="fleet-timeline-event-agent">{event.agentLabel}</span>
                    <span className="fleet-timeline-event-label">{event.label}</span>
                    {event.detail ? (
                      <span className="fleet-timeline-event-detail">{event.detail}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="fleet-timeline-empty" data-testid="fleet-timeline-empty">
              暂无实时事件
            </p>
          )}
        </section>

        <section
          className="fleet-recommendation-panel"
          data-testid="fleet-recommendation"
          aria-label="舰队建议"
        >
          <div className="fleet-subsection-heading">
            <h3>建议</h3>
            <span className="fleet-recommendation-badge">只读</span>
          </div>
          {recommendationHasContent(recommendation) ? (
            <div
              className="fleet-recommendation-content"
              data-testid="fleet-recommendation-content"
            >
              <p className="fleet-recommendation-title">{recommendation.title}</p>
              {recommendation.reason ? (
                <div className="fleet-recommendation-field">
                  <span>原因</span>
                  <p>{recommendation.reason}</p>
                </div>
              ) : null}
              {recommendation.estimatedDuration ? (
                <div className="fleet-recommendation-field">
                  <span>预计</span>
                  <p>{recommendation.estimatedDuration}</p>
                </div>
              ) : null}
              {recommendation.source ? (
                <div className="fleet-recommendation-field">
                  <span>来源</span>
                  <p>{recommendation.source}</p>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="fleet-recommendation-empty" data-testid="fleet-recommendation-empty">
              暂无实时建议
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
