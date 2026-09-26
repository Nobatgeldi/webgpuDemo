/**
 * WebGPU bootstrap: adapter/device acquisition, optional features, canvas
 * configuration and device-level error plumbing (device.lost and
 * uncapturederror).
 */

export type GpuInitErrorKind =
  | 'no-webgpu'
  | 'no-adapter'
  | 'device-request-failed'
  | 'canvas-context-failed';

export class GpuInitError extends Error {
  override readonly name = 'GpuInitError';

  constructor(
    readonly kind: GpuInitErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Features the simulator uses when available; none of them is mandatory. */
const OPTIONAL_FEATURES: readonly GPUFeatureName[] = ['timestamp-query', 'float32-filterable'];

export interface GpuFeatureSet {
  /** GPU pass timing through timestamp queries. */
  readonly timestampQuery: boolean;
  /** Linear filtering of 32-bit float textures. */
  readonly float32Filterable: boolean;
}

export interface GpuContext {
  readonly adapter: GPUAdapter;
  readonly adapterInfo: GPUAdapterInfo;
  readonly device: GPUDevice;
  readonly canvasContext: GPUCanvasContext;
  readonly canvasFormat: GPUTextureFormat;
  readonly features: GpuFeatureSet;
}

export interface GpuInitCallbacks {
  /** Called when the device is lost for any reason other than an intentional destroy(). */
  onDeviceLost(info: GPUDeviceLostInfo): void;
  /** Called for every error that was not captured by an error scope. */
  onUncapturedError(error: GPUError): void;
}

export async function initGpu(
  canvas: HTMLCanvasElement,
  callbacks: GpuInitCallbacks,
): Promise<GpuContext> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new GpuInitError('no-webgpu', 'navigator.gpu is not available');
  }

  let adapter: GPUAdapter | null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (error) {
    throw new GpuInitError('no-adapter', `requestAdapter() failed: ${describeError(error)}`, {
      cause: error,
    });
  }
  if (!adapter) {
    throw new GpuInitError('no-adapter', 'requestAdapter() returned null');
  }

  const requiredFeatures = OPTIONAL_FEATURES.filter((feature) => adapter.features.has(feature));

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      label: 'sim-device',
      requiredFeatures,
    });
  } catch (error) {
    throw new GpuInitError(
      'device-request-failed',
      `requestDevice() failed: ${describeError(error)}`,
      { cause: error },
    );
  }

  void device.lost.then((info) => {
    // 'destroyed' means our own device.destroy() call; nothing to recover from.
    if (info.reason === 'destroyed') {
      return;
    }
    callbacks.onDeviceLost(info);
  });
  device.addEventListener('uncapturederror', (event) => {
    callbacks.onUncapturedError((event as GPUUncapturedErrorEvent).error);
  });

  const canvasContext = canvas.getContext('webgpu');
  if (!canvasContext) {
    device.destroy();
    throw new GpuInitError('canvas-context-failed', "canvas.getContext('webgpu') returned null");
  }
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  canvasContext.configure({ device, format: canvasFormat, alphaMode: 'opaque' });

  return {
    adapter,
    adapterInfo: adapter.info,
    device,
    canvasContext,
    canvasFormat,
    features: {
      timestampQuery: device.features.has('timestamp-query'),
      float32Filterable: device.features.has('float32-filterable'),
    },
  };
}

/** Upper bound on individually logged uncaptured errors before switching to periodic summaries. */
const MAX_DETAILED_GPU_ERROR_LOGS = 20;
/** After the detailed budget is spent, one summary line is printed every this many errors. */
const GPU_ERROR_SUMMARY_INTERVAL = 100;

/**
 * Logs uncaptured GPU errors in a readable form without flooding the console
 * when the same validation error repeats every frame.
 */
export class GpuErrorReporter {
  private count = 0;

  get errorCount(): number {
    return this.count;
  }

  report(error: GPUError): void {
    this.count++;
    const kind = gpuErrorKind(error);
    if (this.count <= MAX_DETAILED_GPU_ERROR_LOGS) {
      console.error(`[WebGPU ${kind}] ${error.message}`);
      if (this.count === MAX_DETAILED_GPU_ERROR_LOGS) {
        console.error(
          `[WebGPU] ${MAX_DETAILED_GPU_ERROR_LOGS} errors logged; further errors are summarised.`,
        );
      }
    } else if (this.count % GPU_ERROR_SUMMARY_INTERVAL === 0) {
      console.error(`[WebGPU] ${this.count} uncaptured errors so far. Last: ${error.message}`);
    }
  }
}

function gpuErrorKind(error: GPUError): string {
  if (typeof GPUValidationError !== 'undefined' && error instanceof GPUValidationError) {
    return 'validation error';
  }
  if (typeof GPUOutOfMemoryError !== 'undefined' && error instanceof GPUOutOfMemoryError) {
    return 'out-of-memory error';
  }
  if (typeof GPUInternalError !== 'undefined' && error instanceof GPUInternalError) {
    return 'internal error';
  }
  return 'error';
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
