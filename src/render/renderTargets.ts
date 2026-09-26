import { DEPTH_FORMAT, HDR_FORMAT } from './renderConfig';

/**
 * Screen-sized scene targets: HDR colour (rgba16float) and reversed-Z depth
 * (depth32float). Recreated only when the canvas size changes.
 */
export class RenderTargets {
  private hdrTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
  private hdrViewCache: GPUTextureView | null = null;
  private depthViewCache: GPUTextureView | null = null;
  private currentWidth = 0;
  private currentHeight = 0;
  /** Incremented on every reallocation so dependants can rebuild their bind groups. */
  private generationCounter = 0;

  constructor(private readonly device: GPUDevice) {}

  get width(): number {
    return this.currentWidth;
  }

  get height(): number {
    return this.currentHeight;
  }

  get generation(): number {
    return this.generationCounter;
  }

  get hdrView(): GPUTextureView {
    if (!this.hdrViewCache) {
      throw new Error('RenderTargets.ensureSize() must be called before use');
    }
    return this.hdrViewCache;
  }

  get depthView(): GPUTextureView {
    if (!this.depthViewCache) {
      throw new Error('RenderTargets.ensureSize() must be called before use');
    }
    return this.depthViewCache;
  }

  /** Reallocates the targets if the size changed. Returns true when reallocated. */
  ensureSize(width: number, height: number): boolean {
    if (width === this.currentWidth && height === this.currentHeight && this.hdrTexture) {
      return false;
    }
    this.hdrTexture?.destroy();
    this.depthTexture?.destroy();

    this.hdrTexture = this.device.createTexture({
      label: 'scene-hdr',
      size: { width, height },
      format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.depthTexture = this.device.createTexture({
      label: 'scene-depth',
      size: { width, height },
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.hdrViewCache = this.hdrTexture.createView({ label: 'scene-hdr' });
    this.depthViewCache = this.depthTexture.createView({ label: 'scene-depth' });
    this.currentWidth = width;
    this.currentHeight = height;
    this.generationCounter++;
    return true;
  }

  dispose(): void {
    this.hdrTexture?.destroy();
    this.depthTexture?.destroy();
    this.hdrTexture = null;
    this.depthTexture = null;
    this.hdrViewCache = null;
    this.depthViewCache = null;
  }
}
