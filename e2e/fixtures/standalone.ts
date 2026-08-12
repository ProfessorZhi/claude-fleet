import fs from 'node:fs';
import path from 'node:path';

import type { TestInfo } from '@playwright/test';
import { expect, test as base } from '@playwright/test';

import { applyAllureLabels } from '../helpers/allure-labels';
import { launchStandalone, type StandaloneSession } from '../helpers/standalone';

export interface StandaloneContext extends StandaloneSession {}

async function attachTextFileIfExists(
  testInfo: TestInfo,
  name: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  try {
    if (!fs.existsSync(filePath)) return;
    await testInfo.attach(name, {
      body: fs.readFileSync(filePath, 'utf8'),
      contentType,
    });
  } catch {
    // Attachment failures are non-fatal in teardown.
  }
}

async function attachText(
  testInfo: TestInfo,
  name: string,
  body: string,
  contentType: string,
): Promise<void> {
  try {
    if (body.length === 0) return;
    await testInfo.attach(name, {
      body,
      contentType,
    });
  } catch {
    // Attachment failures are non-fatal in teardown.
  }
}

export const test = base.extend<{
  standalone: StandaloneContext;
  _allureLabels: void;
  /** Standalone UI projection; legacy behavior tests use Pixel Office explicitly. */
  scene: 'control-center' | 'fleet-command' | 'pixel-office';
}>({
  scene: ['control-center', { option: true }],
  // Auto-fixture: tag every test with Allure epic + feature derived from its
  // @area: annotation and enclosing describe path. Runs before standalone.
  _allureLabels: [
    async ({}, use, testInfo) => {
      await applyAllureLabels(testInfo);
      await use();
    },
    { auto: true },
  ],
  standalone: async ({ page, scene }, use, testInfo) => {
    const standalone = await launchStandalone(page);

    try {
      if (scene === 'pixel-office') {
        await page.getByTestId('fleet-settings').click();
        await page.getByTestId('settings-current-scene-pixel-office').click();
        await page.getByTestId('settings-close').click();
        await expect(page.getByTestId('empty-state-new-agent')).toBeVisible();
      } else if (scene === 'fleet-command') {
        await page.getByTestId('fleet-settings').click();
        await page.getByTestId('settings-current-scene-fleet').click();
        await page.getByTestId('settings-close').click();
        await expect(page.getByTestId('fleet-command-scene')).toBeVisible();
      } else {
        await expect(page.getByTestId('task-control-center')).toBeVisible();
      }
      await use(standalone);
    } finally {
      await attachText(testInfo, 'standalone-host-log', standalone.getHostLogs(), 'text/plain');
      await attachTextFileIfExists(
        testInfo,
        'server-json',
        path.join(standalone.tmpHome, '.claude-fleet', 'server.json'),
        'application/json',
      );

      try {
        const screenshotPath = testInfo.outputPath('final-screenshot.png');
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach('final-screenshot', {
          path: screenshotPath,
          contentType: 'image/png',
        });
      } catch {
        // Screenshot failures are non-fatal in teardown.
      }

      await standalone.cleanup();
    }
  },
});

export { expect };
