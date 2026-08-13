import * as fs from 'fs';

import { GLOBAL_SCAN_ACTIVE_MAX_AGE_MS } from './constants.js';

/**
 * Persisted external sessions are only a projection of a runtime that may be
 * owned by another terminal or VS Code window. A transcript file surviving a
 * reboot is not evidence that the runtime is still alive. Keep restore policy
 * aligned with global discovery: only recently active transcripts are
 * eligible for automatic restoration.
 */
export function isPersistedExternalSessionFresh(
  jsonlFile: string,
  now = Date.now(),
  maxAgeMs = GLOBAL_SCAN_ACTIVE_MAX_AGE_MS,
): boolean {
  try {
    const ageMs = now - fs.statSync(jsonlFile).mtimeMs;
    return ageMs >= 0 && ageMs <= maxAgeMs;
  } catch {
    return false;
  }
}
