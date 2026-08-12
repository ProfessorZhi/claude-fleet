import { describe, expect, it } from 'vitest';

import { expandWindowsEnvironmentVariables } from '../src/providers/hook/claude/claudeConfigPath.js';

describe('claudeConfigPath', () => {
  it('expands Windows profile variables before deriving transcript paths', () => {
    expect(
      expandWindowsEnvironmentVariables(
        '%USERPROFILE%\\.claude-deepseek',
        {
          USERPROFILE: 'C:\\Users\\Administrator',
        },
        'win32',
      ),
    ).toBe('C:\\Users\\Administrator\\.claude-deepseek');
  });

  it('keeps unknown Windows variables unchanged', () => {
    expect(expandWindowsEnvironmentVariables('%MISSING_PROFILE%\\.claude', {}, 'win32')).toBe(
      '%MISSING_PROFILE%\\.claude',
    );
  });
});
