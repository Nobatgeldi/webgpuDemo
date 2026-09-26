/**
 * Developer overlay (toggled with F): device capabilities and frame internals.
 */

const DEBUG_REFRESH_INTERVAL_MS = 500;

export interface DebugSection {
  readonly title: string;
  readonly lines: readonly string[];
}

export class DebugOverlay {
  private lastRefreshMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly root: HTMLElement) {}

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** Rebuilds the text if visible and the refresh interval elapsed. `build` is only called then. */
  update(nowMs: number, build: () => readonly DebugSection[]): void {
    if (this.root.hidden || nowMs - this.lastRefreshMs < DEBUG_REFRESH_INTERVAL_MS) {
      return;
    }
    this.lastRefreshMs = nowMs;
    this.root.textContent = build()
      .map((section) => `[${section.title}]\n${section.lines.map((l) => `  ${l}`).join('\n')}`)
      .join('\n\n');
  }
}
