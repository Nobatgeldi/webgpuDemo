/**
 * Heads-up display: plain HTML overlay, updated at a limited rate so DOM work
 * stays negligible. Ship/wind readouts are added in later phases.
 */

/** HUD text refresh interval (ms). */
const HUD_REFRESH_INTERVAL_MS = 250;

export interface HudStats {
  readonly fps: number;
  readonly cpuFrameMs: number | null;
  /** Null when timestamp queries are unavailable. */
  readonly gpuFrameMs: number | null;
  readonly gpuTimingSupported: boolean;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly paused: boolean;
  readonly simTimeSeconds: number;
}

export class Hud {
  private readonly fields: Record<'fps' | 'cpu' | 'gpu' | 'resolution' | 'simTime', HTMLElement>;
  private readonly pausedBanner: HTMLElement;
  private lastRefreshMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly root: HTMLElement) {
    root.replaceChildren();
    this.pausedBanner = element('div', 'hud-banner', 'DURAKLATILDI');
    this.pausedBanner.hidden = true;
    root.append(this.pausedBanner);
    this.fields = {
      fps: this.addRow('FPS'),
      cpu: this.addRow('CPU kare süresi'),
      gpu: this.addRow('GPU süresi'),
      resolution: this.addRow('Çözünürlük'),
      simTime: this.addRow('Simülasyon zamanı'),
    };
    root.append(
      element('div', 'hud-hint', 'Sürükle: kamerayı döndür · Tekerlek: yakınlaş · P: duraklat · H: arayüz · F: debug'),
    );
  }

  update(stats: HudStats, nowMs: number): void {
    if (nowMs - this.lastRefreshMs < HUD_REFRESH_INTERVAL_MS) {
      return;
    }
    this.lastRefreshMs = nowMs;
    this.pausedBanner.hidden = !stats.paused;
    this.fields.fps.textContent = stats.fps.toFixed(0);
    this.fields.cpu.textContent = stats.cpuFrameMs === null ? '–' : `${stats.cpuFrameMs.toFixed(2)} ms`;
    this.fields.gpu.textContent = !stats.gpuTimingSupported
      ? 'desteklenmiyor'
      : stats.gpuFrameMs === null
        ? 'ölçülüyor…'
        : `${stats.gpuFrameMs.toFixed(2)} ms`;
    this.fields.resolution.textContent = `${stats.renderWidth} × ${stats.renderHeight}`;
    this.fields.simTime.textContent = formatDuration(stats.simTimeSeconds);
  }

  private addRow(label: string): HTMLElement {
    const row = element('div', 'hud-row');
    const value = element('span', 'hud-value', '–');
    row.append(element('span', 'hud-label', label), value);
    this.root.append(row);
    return value;
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
