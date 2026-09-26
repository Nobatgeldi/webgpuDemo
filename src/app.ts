import { OrbitCameraController } from './camera/orbitCamera';
import { CanvasSizer } from './core/canvasSize';
import type { GpuContext, GpuErrorReporter } from './core/gpu';
import { GpuTimer } from './core/gpuTimer';
import { FrameLoop, type FrameInfo } from './core/loop';
import { ExponentialAverage, RateCounter, SimClock } from './core/time';
import type { LaunchOptions } from './core/urlParams';
import { Input } from './input/input';
import { beaufortToWindSpeed, windSpeedToBeaufort } from './ocean/beaufort';
import { Ocean } from './ocean/ocean';
import { peakWavelength } from './ocean/spectrumModel';
import { WindState } from './ocean/windState';
import { Camera } from './render/camera';
import { FrameUniforms } from './render/frameUniforms';
import { GridPass } from './render/gridPass';
import { DEPTH_CLEAR_VALUE, MAX_TIMED_PASSES } from './render/renderConfig';
import { RenderTargets } from './render/renderTargets';
import { TonemapPass } from './render/tonemapPass';
import { createDefaultSettings, roundWindSpeed, type AppSettings } from './settings';
import { Atmosphere } from './sky/atmosphere';
import { computeSunState, overcastFromWind, type SunState } from './sky/atmosphereModel';
import { SkyPass } from './sky/skyPass';
import { DebugTextureView } from './render/debugTextureView';
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

/** Camera clearance above the mean sea level (m) ... */
const CAMERA_MIN_CLEARANCE_M = 1.5;
/**
 * ... plus this multiple of Hs, a conservative bound of crest heights. Keeps the
 * orbit camera out of the water until the water-height query (phase 3) exists.
 */
const CAMERA_CREST_ALLOWANCE_PER_HS = 1.2;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const METRES_PER_KM = 1000;

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
  readonly atmosphere: Atmosphere;
  readonly debugTextureView: DebugTextureView;
  readonly frameUniforms: FrameUniforms;
  readonly skyPass: SkyPass;
  readonly gridPass: GridPass;
  readonly tonemapPass: TonemapPass;
  readonly ocean: Ocean;
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
  private readonly wind: WindState;

  private sun: SunState;
  private sunKey = '';
  private lastFrame: FrameInfo | null = null;

  private readonly gpu: GpuContext;
  private readonly launch: LaunchOptions;
  private readonly errorReporter: GpuErrorReporter;
  private readonly frameUniforms: FrameUniforms;
  private readonly skyPass: SkyPass;
  private readonly gridPass: GridPass;
  private readonly tonemapPass: TonemapPass;
  private readonly ocean: Ocean;
  private readonly atmosphere: Atmosphere;
  private readonly debugTextureView: DebugTextureView;

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
    this.ocean = passes.ocean;
    this.atmosphere = passes.atmosphere;
    this.debugTextureView = passes.debugTextureView;
    this.settings = createDefaultSettings();
    this.settings.paused = launch.paused;
    if (launch.beaufort !== null) {
      this.settings.windSpeedMs = roundWindSpeed(beaufortToWindSpeed(launch.beaufort));
      this.settings.windBeaufort = windSpeedToBeaufort(this.settings.windSpeedMs);
    }
    if (launch.windDirectionDeg !== null) {
      this.settings.windDirectionDeg = launch.windDirectionDeg;
    }
    // Initial conditions apply immediately; later changes ramp in gradually.
    this.wind = new WindState(this.settings.windSpeedMs, this.settings.windDirectionDeg * DEG_TO_RAD);

    this.input = new Input(elements.canvas);
    this.sizer = new CanvasSizer(
      elements.canvas,
      device.limits.maxTextureDimension2D,
      this.settings.pixelRatioCap,
    );
    this.targets = new RenderTargets(device);
    this.timer = new GpuTimer(device, gpu.features.timestampQuery, MAX_TIMED_PASSES);
    this.sun = computeSunState(this.settings.sunElevationDeg, this.settings.sunAzimuthDeg, 0);

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
    const atmosphere = await Atmosphere.create(device);
    const frameUniforms = new FrameUniforms(device, atmosphere);
    const { quality, seed } = options.launch;
    // Pipelines compile in parallel.
    const [skyPass, gridPass, tonemapPass, ocean] = await Promise.all([
      SkyPass.create(device, frameUniforms),
      GridPass.create(device, frameUniforms),
      TonemapPass.create(device, canvasFormat, atmosphere.skyLightBuffer),
      Ocean.create(device, frameUniforms, quality, seed),
    ]);
    const oceanTextures = ocean.debugTextures;
    const debugTextureView = await DebugTextureView.create(device, canvasFormat, {
      spectrum: oceanTextures.spectrum,
      displacement: oceanTextures.displacement,
      derivatives: oceanTextures.derivatives,
      foam: oceanTextures.foam,
      skyView: atmosphere.skyViewLut,
      transmittance: atmosphere.transmittanceLut,
    });
    return new App(options, {
      atmosphere,
      debugTextureView,
      frameUniforms,
      skyPass,
      gridPass,
      tonemapPass,
      ocean,
    });
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
    this.wind.setTarget(this.settings.windSpeedMs, this.settings.windDirectionDeg * DEG_TO_RAD);
    this.wind.step(this.clock.stepSeconds);
  }

  private frame(frame: FrameInfo): void {
    const cpuStart = performance.now();
    this.lastFrame = frame;
    this.fps.tick(frame.timestampMs);

    this.handleShortcuts();
    this.ocean.setSeaState({
      windSpeedMs: this.wind.speedMs,
      windFromRad: this.wind.fromDirectionRad,
      fetchM: this.settings.fetchKm * METRES_PER_KM,
      choppiness: this.settings.choppiness,
    });
    this.orbit.handleInput(this.input);
    const minAltitude =
      CAMERA_MIN_CLEARANCE_M + CAMERA_CREST_ALLOWANCE_PER_HS * this.ocean.significantWaveHeightM;
    this.orbit.update(this.camera, frame.frameSeconds, minAltitude);

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
    this.updateSun();
    this.frameUniforms.update({
      camera: this.camera,
      sun: this.sun,
      viewportWidth: width,
      viewportHeight: height,
      simTimeSeconds: this.clock.time,
      frameSeconds: frame.frameSeconds,
      frameIndex: frame.frameIndex,
    });
    this.tonemapPass.update(this.settings, frame.frameIndex);

    this.timer.beginFrame();
    const encoder = device.createCommandEncoder({ label: 'frame' });
    this.atmosphere.encode(encoder);

    // Waves at the render instant: interpolated between the last two simulation steps.
    const renderTime = this.clock.time + (this.settings.paused ? 0 : frame.alpha * this.clock.stepSeconds);
    this.ocean.encodeSimulation(encoder, renderTime, this.timer.timestampWrites('ocean-sim'));
    this.ocean.prepareDraw(this.camera, { wireframe: this.settings.oceanWireframe });

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
    this.ocean.draw(scenePass);
    if (this.settings.showGrid) {
      this.gridPass.draw(scenePass);
    }
    // Sky last: it only shades pixels left at the far plane.
    this.skyPass.draw(scenePass);
    scenePass.end();

    const swapchainView = canvasContext.getCurrentTexture().createView({ label: 'swapchain' });
    this.tonemapPass.encode(encoder, this.targets.hdrView, swapchainView, this.timer.timestampWrites('tonemap'));
    this.debugTextureView.encode(encoder, swapchainView, {
      name: this.settings.debugTexture,
      cascade: Math.min(this.settings.debugTextureCascade, this.ocean.quality.cascadeCount - 1),
      currentFoamIndex: this.ocean.debugTextures.currentFoamIndex,
      significantWaveHeightM: this.ocean.significantWaveHeightM,
      viewportWidth: width,
      viewportHeight: height,
    });

    this.timer.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    this.timer.afterSubmit();
    this.ocean.afterSubmit();
  }

  /** Recomputes the sun (and the sky LUTs) only when the sun or the cloud cover changed. */
  private updateSun(): void {
    const overcast = overcastFromWind(this.wind.speedMs, this.settings.stormClouds);
    const key = `${this.settings.sunElevationDeg}|${this.settings.sunAzimuthDeg}|${overcast}`;
    if (key !== this.sunKey) {
      this.sun = computeSunState(this.settings.sunElevationDeg, this.settings.sunAzimuthDeg, overcast);
      this.sunKey = key;
    }
    this.atmosphere.setSun(this.sun);
  }

  private updateUi(frame: FrameInfo): void {
    document.body.classList.toggle('ui-hidden', !this.settings.uiVisible);
    if (this.debugOverlay.visible !== this.settings.debugOverlay) {
      this.debugOverlay.setVisible(this.settings.debugOverlay);
    }
    const now = frame.timestampMs;
    this.hud.update(
      {
        sea: {
          beaufort: windSpeedToBeaufort(this.wind.speedMs),
          windSpeedMs: this.wind.speedMs,
          targetWindSpeedMs: this.wind.transitioning ? this.wind.targetSpeedMs : null,
          windFromDeg: this.wind.fromDirectionRad * RAD_TO_DEG,
          significantWaveHeightM: this.ocean.significantWaveHeightM,
        },
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

  private oceanDebugSection(): DebugSection {
    const stats = this.ocean.stats;
    if (!stats) {
      return { title: 'Ocean', lines: ['(not initialised)'] };
    }
    const p = stats.jonswap;
    const measured = stats.measuredSignificantWaveHeightM;
    return {
      title: 'Ocean',
      lines: [
        `FFT ${stats.fftSize}², cascades: ${stats.bands
          .map((b) => `${b.patchSizeM} m [k ${b.kMin.toFixed(3)}–${b.kMax.toFixed(2)}]`)
          .join(', ')}`,
        `mesh: M=${this.ocean.quality.meshHalfCells}, ${this.ocean.quality.meshLevels} levels, s0=${this.ocean.quality.meshBaseSpacingM} m`,
        p.calm
          ? 'JONSWAP: calm'
          : `JONSWAP: alpha=${p.alpha.toFixed(5)}, wp=${p.peakOmega.toFixed(3)} rad/s, ` +
            `Lp=${peakWavelength(p).toFixed(1)} m, chi=${p.dimensionlessFetch.toFixed(0)}, ` +
            `F_eff=${(p.effectiveFetchM / METRES_PER_KM).toFixed(0)} km`,
        `Hs model ${stats.significantWaveHeightM.toFixed(2)} m, resolved ${stats.resolvedSignificantWaveHeightM.toFixed(2)} m, ` +
          `GPU ${measured === null ? '–' : `${measured.toFixed(2)} m`}`,
        `whitecaps: GPU ${stats.measuredWhitecapCoverage === null ? '–' : `${(stats.measuredWhitecapCoverage * 100).toFixed(2)} %`}, ` +
          `Monahan ${(stats.monahanWhitecapCoverage * 100).toFixed(2)} %`,
        `sun irradiance ${this.sun.irradiance.map((e) => e.toFixed(3)).join('/')}, overcast ${this.sun.overcast.toFixed(2)}`,
      ],
    };
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
      this.oceanDebugSection(),
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
