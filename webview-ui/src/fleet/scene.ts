export const SCENE_STORAGE_KEY = 'claude-fleet.visual-scene';
export const SCENE_DEFAULT_STORAGE_KEY = 'claude-fleet.default-scene';
export const SCENE_PREFERENCE_VERSION_KEY = 'claude-fleet.visual-scene-version';
// Bump when the product default or preference shape changes. Fleet Command is
// the task-control-center homepage; Pixel Office remains an optional projection
// for users who want the visual office scene.
export const SCENE_PREFERENCE_VERSION = '5';
export const PRODUCT_DEFAULT_SCENE: SceneId = 'control-center';

export type SceneId = 'control-center' | 'fleet-command' | 'pixel-office';

export function isSceneId(value: unknown): value is SceneId {
  return value === 'control-center' || value === 'fleet-command' || value === 'pixel-office';
}

export function readScenePreference(value: string | null | undefined): SceneId {
  return isSceneId(value) ? value : PRODUCT_DEFAULT_SCENE;
}

/**
 * Existing Development Hosts may have a legacy scene value from before the
 * separate default-scene preference existed. Migrate that preference once;
 * later explicit scene selections remain persistent.
 */
export function readPersistedScenePreference(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined,
): SceneId {
  try {
    if (storage?.getItem(SCENE_PREFERENCE_VERSION_KEY) !== SCENE_PREFERENCE_VERSION) {
      storage?.setItem(SCENE_PREFERENCE_VERSION_KEY, SCENE_PREFERENCE_VERSION);
      storage?.setItem(SCENE_STORAGE_KEY, PRODUCT_DEFAULT_SCENE);
      storage?.setItem(SCENE_DEFAULT_STORAGE_KEY, PRODUCT_DEFAULT_SCENE);
      return PRODUCT_DEFAULT_SCENE;
    }
    return readScenePreference(storage?.getItem(SCENE_STORAGE_KEY));
  } catch {
    return PRODUCT_DEFAULT_SCENE;
  }
}

export function readDefaultScenePreference(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): SceneId {
  try {
    return readScenePreference(storage?.getItem(SCENE_DEFAULT_STORAGE_KEY));
  } catch {
    return PRODUCT_DEFAULT_SCENE;
  }
}

export function writeScenePreference(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  scene: SceneId,
): void {
  try {
    storage?.setItem(SCENE_PREFERENCE_VERSION_KEY, SCENE_PREFERENCE_VERSION);
    storage?.setItem(SCENE_STORAGE_KEY, scene);
  } catch {
    // VS Code webviews can expose storage that is unavailable in restricted
    // profiles. Scene selection still works for the current render.
  }
}

export function writeDefaultScenePreference(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  scene: SceneId,
): void {
  try {
    storage?.setItem(SCENE_PREFERENCE_VERSION_KEY, SCENE_PREFERENCE_VERSION);
    storage?.setItem(SCENE_DEFAULT_STORAGE_KEY, scene);
  } catch {
    // A restricted webview may deny storage; the current session still works.
  }
}
