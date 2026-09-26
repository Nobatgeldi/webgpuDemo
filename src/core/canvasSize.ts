/**
 * Canvas backing-store sizing with a device-pixel-ratio cap.
 *
 * Rendering at the full DPR of a 4K laptop panel costs up to 4x the pixels of
 * a 1080p render for little visual gain, so the effective pixel ratio is
 * capped (configurable at runtime).
 */

export interface CanvasPixelSizeInput {
  /** CSS size of the canvas element. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /**
   * Exact physical pixel size from ResizeObserver's devicePixelContentBoxSize,
   * when the browser provides it (Chrome/Edge do). Avoids off-by-one blurring.
   */
  readonly devicePixelWidth?: number | undefined;
  readonly devicePixelHeight?: number | undefined;
  readonly devicePixelRatio: number;
  /** Maximum effective pixels per CSS pixel. */
  readonly pixelRatioCap: number;
  /** Maximum texture dimension supported by the device. */
  readonly maxDimension: number;
}

export interface CanvasPixelSize {
  readonly width: number;
  readonly height: number;
  /** Effective physical pixels per CSS pixel after applying the cap. */
  readonly pixelRatio: number;
}

export function computeCanvasPixelSize(input: CanvasPixelSizeInput): CanvasPixelSize {
  const dpr = input.devicePixelRatio > 0 ? input.devicePixelRatio : 1;
  const cap = input.pixelRatioCap > 0 ? input.pixelRatioCap : dpr;
  const effectiveRatio = Math.min(dpr, cap);
  const scale = effectiveRatio / dpr;

  const fullWidth = input.devicePixelWidth ?? input.cssWidth * dpr;
  const fullHeight = input.devicePixelHeight ?? input.cssHeight * dpr;

  const clampDimension = (value: number): number =>
    Math.min(input.maxDimension, Math.max(1, Math.round(value)));

  const width = clampDimension(fullWidth * scale);
  const height = clampDimension(fullHeight * scale);
  return { width, height, pixelRatio: effectiveRatio };
}

/**
 * Tracks the canvas' displayed size and keeps its backing store in sync.
 * Rendering code polls {@link CanvasSizer.width}/{@link CanvasSizer.height}
 * once per frame; no GPU resources are touched from the observer callback.
 */
export class CanvasSizer {
  private readonly observer: ResizeObserver;
  private lastEntry: {
    cssWidth: number;
    cssHeight: number;
    devicePixelWidth: number | undefined;
    devicePixelHeight: number | undefined;
  } | null = null;
  private currentPixelRatio = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly maxDimension: number,
    private pixelRatioCap: number,
  ) {
    this.observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) {
        return;
      }
      const cssBox = entry.contentBoxSize[0];
      const deviceBox = entry.devicePixelContentBoxSize?.[0];
      this.lastEntry = {
        cssWidth: cssBox ? cssBox.inlineSize : entry.contentRect.width,
        cssHeight: cssBox ? cssBox.blockSize : entry.contentRect.height,
        devicePixelWidth: deviceBox?.inlineSize,
        devicePixelHeight: deviceBox?.blockSize,
      };
      this.apply();
    });
    try {
      this.observer.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      // Browsers without device-pixel-content-box support fall back to CSS size x DPR.
      this.observer.observe(canvas, { box: 'content-box' });
    }
    // Initial size until the first observer callback arrives.
    const rect = canvas.getBoundingClientRect();
    this.lastEntry = {
      cssWidth: rect.width,
      cssHeight: rect.height,
      devicePixelWidth: undefined,
      devicePixelHeight: undefined,
    };
    this.apply();
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  get pixelRatio(): number {
    return this.currentPixelRatio;
  }

  setPixelRatioCap(cap: number): void {
    if (cap !== this.pixelRatioCap) {
      this.pixelRatioCap = cap;
      this.apply();
    }
  }

  dispose(): void {
    this.observer.disconnect();
  }

  private apply(): void {
    if (!this.lastEntry) {
      return;
    }
    const size = computeCanvasPixelSize({
      ...this.lastEntry,
      devicePixelRatio: window.devicePixelRatio,
      pixelRatioCap: this.pixelRatioCap,
      maxDimension: this.maxDimension,
    });
    this.currentPixelRatio = size.pixelRatio;
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.canvas.width = size.width;
      this.canvas.height = size.height;
    }
  }
}
