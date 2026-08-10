import type { Frame } from '@playwright/test';

import { expect, test } from '../../../fixtures/pixel-agents';
import { acceptQuickPick } from '../../../helpers/webview';

test.describe('Task Control Center', () => {
  test.use({ scene: 'control-center' });

  async function createAgent(frame: Frame): Promise<void> {
    await frame.getByTestId('control-empty-new-agent').click();
    await acceptQuickPick(frame.page(), 'Claude Fleet: Choose Runtime', 'Claude Code');
    await acceptQuickPick(frame.page(), 'Claude Fleet: Name this Agent');
    await acceptQuickPick(frame.page(), 'Claude Fleet: Choose Provider');
    await acceptQuickPick(frame.page(), 'Claude Fleet: Choose Model');
  }

  test('opens the information-first control center by default @area:control-center', async ({
    pixelAgents,
  }) => {
    const { frame } = pixelAgents;

    await expect(frame.getByTestId('task-control-center')).toBeVisible();
    await expect(frame.getByTestId('control-mission-summary')).toBeVisible();
    await expect(frame.getByTestId('control-agent-list-card')).toBeVisible();
    await expect(frame.getByTestId('control-center-empty')).toBeVisible();
    await expect(frame.getByTestId('fleet-command-scene')).toHaveCount(0);

    await createAgent(frame);
    await expect(frame.getByTestId('control-agent-1')).toBeVisible({ timeout: 20_000 });
    await frame.getByTestId('control-agent-1').click();
    await expect(frame.getByTestId('control-agent-detail')).toBeVisible();
    await expect(frame.getByTestId('control-agent-focus-1')).toBeVisible();
    await expect(frame.getByTestId('control-agent-detail')).toContainText('连接');
    await expect(frame.getByTestId('control-agent-detail')).toContainText('Token 总量');

    await frame.getByTestId('control-agent-focus-1').click();
    await expect
      .poll(() =>
        frame.evaluate(
          () =>
            window.__pixelAgentsTestHooks?.clientMessageLog?.some(
              (message) => message.type === 'focusAgent' && message.id === 1,
            ) ?? false,
        ),
      )
      .toBe(true);

    await frame.getByTestId('fleet-settings').click();
    await frame.getByTestId('settings-current-scene-fleet').click();
    await frame.getByTestId('settings-close').click();
    await expect(frame.getByTestId('fleet-command-scene')).toBeVisible();

    await frame.getByTestId('fleet-settings').click();
    await frame.getByTestId('settings-current-scene-pixel-office').click();
    await frame.getByTestId('settings-close').click();
    await expect(frame.getByText('+ Agent', { exact: true })).toBeVisible();

    await frame.getByRole('button', { name: 'Settings', exact: true }).click();
    await frame.getByTestId('settings-current-scene-control-center').click();
    await frame.getByTestId('settings-close').click();
    await expect(frame.getByTestId('task-control-center')).toBeVisible();
  });
});
