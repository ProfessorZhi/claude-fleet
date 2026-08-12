import type { SceneId } from '../fleet/scene.js';

interface SceneToggleProps {
  scene: SceneId;
  onChange: (scene: SceneId) => void;
  variant?: 'overlay' | 'command-bar';
}

export function SceneToggle({ scene, onChange, variant = 'overlay' }: SceneToggleProps) {
  return (
    <div
      className={`${variant === 'command-bar' ? 'scene-toggle-command-bar' : 'absolute top-8 left-8 z-30 pixel-panel p-2 flex items-center gap-1'}`}
      aria-label="Visual Scene"
    >
      <span className="scene-toggle-label text-sm text-text-muted px-3">场景</span>
      <button
        type="button"
        data-testid="scene-toggle-control-center"
        aria-pressed={scene === 'control-center'}
        onClick={() => onChange('control-center')}
        className={`py-2 px-4 text-sm border-2 rounded-none cursor-pointer ${scene === 'control-center' ? 'bg-active-bg border-accent text-text' : 'bg-transparent border-transparent text-text-muted hover:text-text'}`}
      >
        任务控制中心
      </button>
      <button
        type="button"
        data-testid="scene-toggle-fleet-command"
        aria-pressed={scene === 'fleet-command'}
        onClick={() => onChange('fleet-command')}
        className={`py-2 px-4 text-sm border-2 rounded-none cursor-pointer ${scene === 'fleet-command' ? 'bg-active-bg border-accent text-text' : 'bg-transparent border-transparent text-text-muted hover:text-text'}`}
      >
        舰队指挥
      </button>
      <button
        type="button"
        data-testid="scene-toggle-pixel-office"
        aria-pressed={scene === 'pixel-office'}
        onClick={() => onChange('pixel-office')}
        className={`py-2 px-4 text-sm border-2 rounded-none cursor-pointer ${scene === 'pixel-office' ? 'bg-active-bg border-accent text-text' : 'bg-transparent border-transparent text-text-muted hover:text-text'}`}
      >
        像素办公室
      </button>
    </div>
  );
}
