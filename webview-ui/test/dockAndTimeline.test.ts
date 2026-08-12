import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

// @ts-expect-error The node test project has no JSX compiler option; Vitest transforms this import at runtime.
import { FleetTimeline, selectRecentTimelineEvents } from '../src/fleet/FleetTimeline.js';
// @ts-expect-error The node test project has no JSX compiler option; Vitest transforms this import at runtime.
import { TerminalDock } from '../src/fleet/TerminalDock.js';

type TestInstance = {
  id: number;
  label: string;
  roleLabel?: string;
  status: string;
  terminalName?: string;
  terminalAvailable: boolean;
};

type TestTimelineEvent = {
  id: string;
  observedAt: number;
  agentLabel: string;
  label: string;
  detail?: string;
  status?: string;
};

type TestRecommendation = {
  title: string;
  reason?: string;
  estimatedDuration?: string;
  source?: string;
};

const instances: TestInstance[] = [
  {
    id: 1,
    label: 'Codex #1',
    roleLabel: 'Coordinator',
    status: 'Working',
    terminalName: 'Claude Fleet · Codex #1',
    terminalAvailable: true,
  },
  {
    id: 2,
    label: 'Claude #2',
    roleLabel: 'Worker',
    status: 'Waiting',
    terminalAvailable: false,
  },
];

const events: TestTimelineEvent[] = [
  { id: 'older', observedAt: 100, agentLabel: 'Codex #1', label: 'Started mission' },
  { id: 'newer', observedAt: 200, agentLabel: 'Claude #2', label: 'Waiting for input' },
];

describe('Fleet Command dock and timeline projections', () => {
  test('keeps instance selection separate from terminal focus', () => {
    const selected: Array<number | string> = [];
    const focused: Array<number | string> = [];
    const markup = renderToStaticMarkup(
      createElement(TerminalDock, {
        instances,
        selectedInstanceId: 1,
        onSelectInstance: (id: number | string) => selected.push(id),
        onFocusTerminal: (id: number | string) => focused.push(id),
        onNewAgent: () => undefined,
      }),
    );

    expect(markup).toContain('data-testid="terminal-dock"');
    expect(markup).toContain('data-testid="terminal-dock-select-1"');
    expect(markup).toContain('data-testid="terminal-dock-focus-1"');
    expect(markup).toContain('data-testid="terminal-dock-new-agent"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('disabled=""');
    expect(selected).toEqual([]);
    expect(focused).toEqual([]);
  });

  test('returns newest events first without mutating the transport projection', () => {
    const source = [...events];
    expect(
      selectRecentTimelineEvents(source, 1).map((event: TestTimelineEvent) => event.id),
    ).toEqual(['newer']);
    expect(source.map((event) => event.id)).toEqual(['older', 'newer']);
  });

  test('shows an honest empty recommendation and renders only passed advice', () => {
    const emptyMarkup = renderToStaticMarkup(
      createElement(FleetTimeline, { events: [], recommendation: null }),
    );
    expect(emptyMarkup).toContain('暂无实时建议');
    expect(emptyMarkup).toContain('暂无实时事件');
    expect(emptyMarkup).not.toContain('Launch');

    const recommendation: TestRecommendation = {
      title: 'Review the waiting worker',
      reason: 'Telemetry reports a waiting state.',
      source: 'Coordinator strategy',
    };
    const liveMarkup = renderToStaticMarkup(
      createElement(FleetTimeline, { events, recommendation }),
    );
    expect(liveMarkup).toContain('Review the waiting worker');
    expect(liveMarkup).toContain('Telemetry reports a waiting state.');
    expect(liveMarkup).toContain('data-testid="fleet-timeline-event-newer"');
  });
});
