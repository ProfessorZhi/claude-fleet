import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

// @ts-expect-error The node test project has no JSX compiler option; Vitest transforms this import at runtime.
import { VesselSprite } from '../src/fleet/VesselSprite.js';

describe('VesselSprite', () => {
  test('renders an accessible, logo-derived SVG with stable test identity', () => {
    const markup = renderToStaticMarkup(
      createElement(VesselSprite, {
        role: 'coordinator',
        status: 'Working',
        className: 'formation-vessel',
        label: 'Coordinator flagship',
      }),
    );

    expect(markup).toContain('data-testid="vessel-sprite"');
    expect(markup).toContain('data-role="coordinator"');
    expect(markup).toContain('data-status="working"');
    expect(markup).toContain('class="vessel-sprite formation-vessel"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Coordinator flagship"');
    expect(markup).toContain('data-role-module="coordinator"');
    expect(markup).toContain('<svg');
  });

  test('normalizes runtime status names while preserving the same vessel geometry', () => {
    const working = renderToStaticMarkup(
      createElement(VesselSprite, { role: 'worker', status: 'working' }),
    );
    const error = renderToStaticMarkup(
      createElement(VesselSprite, { role: 'worker', status: 'error' }),
    );

    expect(working).toContain('data-status="working"');
    expect(error).toContain('data-status="error"');
    expect(working.match(/data-role-module="worker"/g)).toHaveLength(1);
    expect(error.match(/data-role-module="worker"/g)).toHaveLength(1);
    expect(working).toContain('vessel-sprite__thruster');
    expect(error).toContain('vessel-sprite__alarm');
  });

  test('supports every explicit runtime status without swapping the vessel role', () => {
    const statuses: Array<[string, string]> = [
      ['Waiting', 'waiting'],
      ['Idle', 'idle'],
      ['Stopped', 'stopped'],
    ];

    for (const [status, dataStatus] of statuses) {
      const markup = renderToStaticMarkup(
        createElement(VesselSprite, { role: 'reviewer', status }),
      );
      expect(markup).toContain('data-role="reviewer"');
      expect(markup).toContain(`data-status="${dataStatus}"`);
    }
  });

  test('uses role modules without changing the shared hard-surface hull', () => {
    const roles = ['reviewer', 'debugger', 'subagent', 'external'] as const;
    const markups = roles.map((role) =>
      renderToStaticMarkup(createElement(VesselSprite, { role, status: 'Idle' })),
    );

    for (const [index, role] of roles.entries()) {
      expect(markups[index]).toContain(`data-role="${role}"`);
      expect(markups[index]).toContain(`data-role-module="${role}"`);
      expect(markups[index]).toContain('class="vessel-sprite__hull"');
    }
  });

  test('falls back to a neutral idle state for unknown status values', () => {
    const markup = renderToStaticMarkup(
      createElement(VesselSprite, { role: 'external', status: 'unknown' }),
    );

    expect(markup).toContain('data-status="idle"');
    expect(markup).toContain('aria-label="External vessel — Idle"');
  });
});
