import type { Frame } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { acceptQuickPick } from '../../../helpers/webview';

test.describe('Fleet Command scene', () => {
  test.use({ scene: 'fleet-command' });

  async function createFleetAgent(frame: Frame): Promise<void> {
    await frame.getByTestId('empty-state-new-agent').click();
    await acceptQuickPick(frame.page(), 'Claude Fleet: Choose Runtime', 'Claude Code');
    await acceptQuickPick(frame.page(), 'Claude Fleet: Name this Agent');
    await acceptQuickPick(frame.page(), 'Claude Fleet: Choose Provider');
    await acceptQuickPick(frame.page(), 'Claude Fleet: Choose Model');
  }

  test('opens as an explicit visual fleet projection and manages a created vessel @area:fleet-command', async ({
    pixelAgents,
  }) => {
    const { frame, window } = pixelAgents;

    await expect(frame.getByTestId('fleet-command-scene')).toBeVisible();
    await expect(frame.getByTestId('fleet-settings')).toBeVisible();
    await expect(frame.getByTestId('empty-state')).toBeVisible();
    await expect(frame.getByTestId('fleet-formation-canvas')).toBeVisible();

    await createFleetAgent(frame);

    await expect(frame.getByTestId('fleet-vessel-1')).toBeVisible({ timeout: 20_000 });
    await expect(frame.getByTestId('fleet-formation-canvas')).toBeVisible();
    await expect(frame.getByTestId('mission-sidebar')).toBeVisible();
    await expect(frame.getByTestId('mission-title')).toHaveText('暂无活动任务');
    await expect(frame.getByTestId('fleet-detail-panel')).toHaveCount(0);
    await expect(frame.getByTestId('fleet-vessel-1')).toHaveAttribute('aria-label', /工作 Agent 1/);

    await frame.getByTestId('fleet-vessel-1').click();
    await expect(frame.getByTestId('fleet-detail-panel')).toBeVisible();
    await expect(frame.getByTestId('fleet-detail-close')).toBeVisible();
    await expect(frame.getByTestId('fleet-agent-focus-1')).toBeVisible();
    await expect(frame.getByText('Claude Code', { exact: true })).toBeVisible();
    await expect(frame.getByTestId('terminal-dock')).toBeVisible();
    await expect(frame.getByTestId('terminal-dock-select-1')).toBeVisible();
    await expect(frame.getByTestId('fleet-timeline-region')).toBeVisible();
    await expect(frame.getByTestId('fleet-recommendation-empty')).toBeVisible();

    await frame.getByTestId('fleet-detail-close').click();
    await expect(frame.getByTestId('fleet-detail-panel')).toHaveCount(0);

    await frame.getByTestId('fleet-settings').click();
    await frame.getByTestId('settings-current-scene-pixel-office').click();
    await expect(frame.getByTestId('fleet-command-scene')).toBeHidden();
    await frame.getByTestId('settings-current-scene-fleet').click();
    await frame.getByTestId('settings-close').click();
    await expect(frame.getByTestId('fleet-vessel-1')).toBeVisible();
  });

  test('restarts a selected vessel without leaving the Fleet scene @area:fleet-command', async ({
    pixelAgents,
  }) => {
    const { frame } = pixelAgents;

    await expect(frame.getByTestId('fleet-command-scene')).toBeVisible();
    await createFleetAgent(frame);
    await frame.getByTestId('fleet-vessel-1').click();

    await expect(frame.getByTestId('fleet-agent-restart-1')).toBeVisible();
    await frame.getByTestId('fleet-agent-restart-1').click();
    await expect(frame.locator('[data-testid^="fleet-vessel-"]').first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('switches Provider from the selected vessel without changing the scene @area:fleet-command', async ({
    pixelAgents,
  }) => {
    const { frame, window } = pixelAgents;

    await createFleetAgent(frame);
    await frame.getByTestId('fleet-vessel-1').click();
    await frame.getByTestId('fleet-agent-switch-provider-1').click();
    await acceptQuickPick(window, 'Claude Fleet: Switch Provider');
    await acceptQuickPick(window, 'Claude Fleet: Choose Model');
    await expect(frame.getByTestId('fleet-command-scene')).toBeVisible();
    await expect(frame.locator('[data-testid^="fleet-vessel-"]').first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('stops a selected vessel and removes it from the Fleet roster @area:fleet-command', async ({
    pixelAgents,
  }) => {
    const { frame } = pixelAgents;

    await createFleetAgent(frame);
    await frame.getByTestId('fleet-vessel-1').click();
    await expect(frame.getByTestId('fleet-agent-stop-1')).toBeVisible();
    await frame.getByTestId('fleet-agent-stop-1').click();
    await expect
      .poll(
        () =>
          frame.evaluate(
            () =>
              window.__pixelAgentsTestHooks?.clientMessageLog?.some(
                (message) => message.type === 'stopAgent' && message.id === 1,
              ) ?? false,
          ),
        { message: 'Fleet Stop button should send stopAgent for the selected instance' },
      )
      .toBe(true);

    await expect(frame.locator('[data-testid^="fleet-vessel-"]')).toHaveCount(0, {
      timeout: 20_000,
    });
  });
});
