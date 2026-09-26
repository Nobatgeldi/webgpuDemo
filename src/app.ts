import { OrbitCameraController } from './camera/orbitCamera';
import { CanvasSizer } from './core/canvasSize';
import type { GpuContext, GpuErrorReporter } from './core/gpu';
import { GpuTimer } from './core/gpuTimer';
import { FrameLoop, type FrameInfo } from './core/loop';
import { ExponentialAverage, RateCounter, SimClock } from './core/time';
import type { LaunchOptions } from './core/urlParams';
import { Input } from './input/input';
import { Camera } from './render/camera';
import { FrameUniforms } from './render/frameUniforms';
import { GridPass } from './render/gridPass';
import { DEPTH_CLEAR_VALUE, MAX_TIMED_PASSES } from './render/renderConfig';
import { RenderTargets } from './render/renderTargets';
import { TonemapPass } from './render/tonemapPass';
import { createDefaultSettings, type AppSettings } from './settings';
import { computeSkyState, type SkyState } from './sky/skyModel';
import { SkyPass } from './sky/skyPass';
import { DebugOverlay, type DebugSection } from './ui/debugOverlay';
import { Hud } from './ui/hud';
import { ControlPanel } from './ui/panel';

/** Fixed simulation rate (Hz); physics integrates at this rate independent of the display. */
export const SIMULATION_RATE_HZ = 120;
/** At most this many simulation steps per rendered frame (0.1 s of simulated time). */
const MAX_SIMULATION_STEPS_PER_FRAME = 12;
/** Longest wall-clock frame accepted by the loop (s); longer gaps are treated as a pause. */
const MAX_FRAME_SECONDS = 0.25;
/** FPS measurement window (ms). */
const FPS_WINDOW_MS = 500;
/** Smoothing of the CPU frame time readout (frames). */
const CPU_TIME_SMOOTHING_FRAMES = 30;

const KEY_PAUSE = 'KeyP';
const KEY_TOGGLE_UI = 'KeyH';
const KEY_TOGGLE_DEBUG = 'KeyF';

/** Clear colour of the HDR target; every pixel is overwritten by the sky pass. */
const HDR_CLEAR_COLOR: GPUColor = [0, 0, 0, 1];

export interface AppElements {
  readonly canvas: HTMLCanvasElement;
  readonly hud: HTMLElement;
  readonly debugOverlay: HTMLElement;
}

export interface AppOptions {
  readonly gpu: GpuContext;
  readonly elements: AppElements;
  readonly launch: LaunchOptions;
  readonly errorReporter: GpuErrorReporter;
  /** Called once when the frame loop stops because of an exception. */
  readonly onFatalError: (error: unknown) => void;
}

interface AppPasses {
  readonly frameUniforms: FrameUniforms;
  readonly skyPass: SkyPass;
  readonly gridPass: GridPass;
  readonly tonemapPass: TonemapPass;
}

/**
 * Owns all subsystems and drives the per-frame flow:
 * input -> fixed-step simulation -> camera -> GPU passes -> UI.
 */
export class App {
  private readonly settings: AppSettings;
  private readonly clock = new SimClock(1 / SIMULATION_RATE_HZ);
  private readonly camera = new Camera();
  private readonly orbit = new OrbitCameraController();
  private readonly input: Input;
  private readonly sizer: CanvasSizer;
  private readonly targets: RenderTargets;
  private readonly timer: GpuTimer;
  private readonly loop: FrameLoop;
  private readonly panel: ControlPanel;
  private readonly hud: Hud;
  private readonly debugOverlay: DebugOverlay;
  private readonly fps = new RateCounter(FPS_WINDOW_MS);
  private readonly cpuFrameMs = new ExponentialAverage(CPU_TIME_SMOOTHING_FRAMES);

  private sky: SkyState;
  private skyKey = '';
  private lastFrame: FrameInfo | null = null;

  private readonly gpu: GpuContext;
  private readonly launch: LaunchOptions;
  private readonly errorReporter: GpuErrorReporter;
  private readonly frameUniforms: FrameUniforms;
  private readonly skyPass: SkyPass;
  private readonly gridPass: GridPass;
  private readonly tonemapPass: TonemapPass;

  private constructor(options: AppOptions, passes: AppPasses) {
    const { gpu, elements, launch } = options;
    const { device } = gpu;
    this.gpu = gpu;
    this.launch = launch;
    this.errorReporter = options.errorReporter;
    this.frameUniforms = passes.frameUniforms;
    this.skyPass = passes.skyPass;
    this.gridPass = passes.gridPass;
    this.tonemapPass = passes.tonemapPass;
    this.settings = createDefaultSettings();
    this.settings.paused = launch.paused;

    this.input = new Input(elements.canvas);
    this.sizer = new CanvasSizer(
      elements.canvas,
      device.limits.maxTextureDimension2D,
      this.settings.pixelRatioCap,
    );
    this.targets = new RenderTargets(device);
    this.timer = new GpuTimer(device, gpu.features.timestampQuery, MAX_TIMED_PASSES);
    this.sky = computeSkyState(this.settings.sunElevationDeg, this.settings.sunAzimuthDeg);

    this.panel = new ControlPanel(this.settings, {
      onPixelRatioCapChange: (cap) => this.sizer.setPixelRatioCap(cap),
    });
    this.hud = new Hud(elements.hud);
    this.debugOverlay = new DebugOverlay(elements.debugOverlay);

    this.loop = new FrameLoop({
      stepSeconds: this.clock.stepSeconds,
      maxStepsPerFrame: MAX_SIMULATION_STEPS_PER_FRAME,
      maxFrameSeconds: MAX_FRAME_SECONDS,
      isPaused: () => this.settings.paused,
      step: () => this.step(),
      render: (frame) => this.frame(frame),
      onError: options.onFatalError,
    });
  }

  static async create(options: AppOptions): Promise<App> {
    const { device, canvasFormat } = options.gpu;
    const frameUniforms = new FrameUniforms(device);
    // Pipelines compile in parallel.
    const [skyPass, gridPass, tonemapPass] = await Promise.all([
      SkyPass.create(device, frameUniforms),
      GridPass.create(device, frameUniforms),
      TonemapPass.create(device, canvasFormat),
    ]);
    return new App(options, { frameUniforms, skyPass, gridPass, tonemapPass });
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** One fixed simulation step. Physics systems hook in here from phase 3 on. */
  private step(): void {
    this.clock.advance();
  }

  private frame(frame: FrameInfo): void {
    const cpuStart = performance.now();
    this.lastFrame = frame;
    this.fps.tick(frame.timestampMs);

    this.handleShortcuts();
    this.orbit.handleInput(this.input);
    this.orbit.update(this.camera, frame.frameSeconds);

    this.renderScene(frame);

    this.input.endFrame();
    this.cpuFrameMs.push(performance.now() - cpuStart);
    this.updateUi(frame);
  }

  private handleShortcuts(): void {
    let changed = false;
    if (this.input.wasPressed(KEY_PAUSE)) {
      this.settings.paused = !this.settings.paused;
      changed = true;
    }
    if (this.input.wasPressed(KEY_TOGGLE_UI)) {
      this.settings.uiVisible = !this.settings.uiVisible;
      changed = true;
    }
    if (this.input.wasPressed(KEY_TOGGLE_DEBUG)) {
      this.settings.debugOverlay = !this.settings.debugOverlay;
      changed = true;
    }
    if (changed) {
      this.panel.refresh();
    }
  }

  private renderScene(frame: FrameInfo): void {
    const { device, canvasContext } = this.gpu;
    const width = this.sizer.width;
    const height = this.sizer.height;
    this.targets.ensureSize(width, height);

    this.camera.aspect = width / height;
    this.camera.updateMatrices();
    this.updateSky();
    this.frameUniforms.update({
      camera: this.camera,
      sky: this.sky,
      viewportWidth: width,
      viewportHeight: height,
      simTimeSeconds: this.clock.time,
      frameSeconds: frame.frameSeconds,
      frameIndex: frame.frameIndex,
    });
    this.tonemapPass.update(this.settings, frame.frameIndex);

    this.timer.beginFrame();
    const encoder = device.createCommandEncoder({ label: 'frame' });

    const scenePass = encoder.beginRenderPass({
      label: 'scene',
      colorAttachments: [
        { view: this.targets.hdrView, loadOp: 'clear', storeOp: 'store', clearValue: HDR_CLEAR_COLOR },
      ],
      depthStencilAttachment: {
        view: this.targets.depthView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: DEPTH_CLEAR_VALUE,
      },
      timestampWrites: this.timer.timestampWrites('scene'),
    });
    scenePass.setBindGroup(0, this.frameUniforms.bindGroup);
    if (this.settings.showGrid) {
      this.gridPass.draw(scenePass);
    }
    // Sky last: it only shades pixels left at the far plane.
    this.skyPass.draw(scenePass);
    scenePass.end();

    this.tonemapPass.encode(
      encoder,
      this.targets.hdrView,
      canvasContext.getCurrentTexture().createView({ label: 'swapchain' }),
      this.timer.timestampWrites('tonemap'),
    );

    this.timer.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    this.timer.afterSubmit();
  }

  /** Recomputes the sky only when the sun moved. */
  private updateSky(): void {
    const key = `${this.settings.sunElevationDeg}|${this.settings.sunAzimuthDeg}`;
    if (key !== this.skyKey) {
      this.sky = computeSkyState(this.settings.sunElevationDeg, this.settings.sunAzimuthDeg);
      this.skyKey = key;
    }
  }

  private updateUi(frame: FrameInfo): void {
    document.body.classList.toggle('ui-hidden', !this.settings.uiVisible);
    if (this.debugOverlay.visible !== this.settings.debugOverlay) {
      this.debugOverlay.setVisible(this.settings.debugOverlay);
    }
    const now = frame.timestampMs;
    this.hud.update(
      {
        fps: this.fps.rate,
        cpuFrameMs: this.cpuFrameMs.value,
        gpuFrameMs: this.timer.frameMs,
        gpuTimingSupported: this.timer.supported,
        renderWidth: this.sizer.width,
        renderHeight: this.sizer.height,
        paused: this.settings.paused,
        simTimeSeconds: this.clock.time,
      },
      now,
    );
    this.debugOverlay.update(now, () => this.debugSections());
  }

  private debugSections(): DebugSection[] {
    const { adapterInfo, canvasFormat, features } = this.gpu;
    const frame = this.lastFrame;
    const p = this.camera.position;
    const f = this.camera.forward;
    const fmt = (v: number, digits = 2): string => v.toFixed(digits);
    const launch = this.launch;
    const passLines: string[] = [];
    for (const label of this.timer.passLabels) {
      const ms = this.timer.passMs(label);
      passLines.push(`${label}: ${ms === null ? '–' : `${ms.toFixed(3)} ms`}`);
    }
    return [
      {
        title: 'GPU',
        lines: [
          `adapter: ${adapterInfo.vendor || '?'} / ${adapterInfo.architecture || '?'} ${adapterInfo.description}`.trim(),
          `canvas format: ${canvasFormat}`,
          `timestamp-query: ${features.timestampQuery ? 'yes' : 'no'}`,
          `float32-filterable: ${features.float32Filterable ? 'yes' : 'no'}`,
          `uncaptured errors: ${this.errorReporter.errorCount}`,
        ],
      },
      {
        title: 'Frame',
        lines: [
          `render target: ${this.targets.width} x ${this.targets.height} @ pixel ratio ${fmt(this.sizer.pixelRatio)}`,
          `frame #${frame?.frameIndex ?? 0}, dt ${fmt((frame?.frameSeconds ?? 0) * 1000)} ms, sim steps ${frame?.stepsThisFrame ?? 0}`,
          `sim time ${fmt(this.clock.time, 3)} s (${this.clock.steps} steps @ ${SIMULATION_RATE_HZ} Hz), dropped ${fmt(this.loop.droppedSimulationSeconds, 3)} s`,
          ...passLines,
        ],
      },
      {
        title: 'Camera',
        lines: [
          `position: ${fmt(p[0] as number)}, ${fmt(p[1] as number)}, ${fmt(p[2] as number)} m`,
          `forward: ${fmt(f[0] as number, 3)}, ${fmt(f[1] as number, 3)}, ${fmt(f[2] as number, 3)}`,
          `near/far: ${this.camera.near} / ${this.camera.far} m (reversed Z)`,
        ],
      },
      {
        title: 'Launch (URL)',
        lines: [
          `wind: ${launch.beaufort === null ? 'default' : `${launch.beaufort} Bf`}, ` +
            `dir: ${launch.windDirectionDeg === null ? 'default' : `${launch.windDirectionDeg}°`}`,
          `seed: ${launch.seed}, quality: ${launch.quality}, paused: ${launch.paused ? 1 : 0}`,
        ],
      },
    ];
  }
}
