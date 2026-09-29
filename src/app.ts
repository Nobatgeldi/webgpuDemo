import { CAMERA_MODE_LABELS, ShipCamera } from './camera/shipCamera';
import { CanvasSizer } from './core/canvasSize';
import type { GpuContext, GpuErrorReporter } from './core/gpu';
import { GpuTimer } from './core/gpuTimer';
import { FrameLoop, type FrameInfo } from './core/loop';
import { ExponentialAverage, FrameTimeStats, RateCounter, SimClock } from './core/time';
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
import { DebugDraw } from './render/debugDraw';
import { ShipSystem } from './ship/shipSystem';
import { ShipEffects } from './effects/shipEffects';
import { WakeFoam } from './effects/wake';
import type { FlagCloth } from './effects/flagCloth';
import { QUALITY, QUALITY_LABELS } from './quality';
import { Benchmark, type BenchmarkResult } from './core/benchmark';
import { QUALITY_PRESETS, replaceUrlParameter, type LaunchOptions, type QualityPreset } from './core/urlParams';
import { KNOTS_TO_MS, PATROL_BOAT } from './ship/shipConfig';
import type { WaterQuery } from './ocean/waterQuery';
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

/**
 * Before the first water query result arrives, a conservative crest height
 * (this multiple of Hs above sea level) is assumed instead.
 */
const CAMERA_CREST_ALLOWANCE_PER_HS = 1.2;
/**
 * Frames after which resources replaced by a quality switch are destroyed; by
 * then the GPU has finished every frame that referenced them.
 */
const RETIRE_AFTER_FRAMES = 4;
/** Frames in the frame-time statistics of the debug overlay (~5 s at 60 Hz). */
const FRAME_STATS_WINDOW = 300;
/** Points per frame for water height queries (ship grid, camera, ...). */
const WATER_QUERY_CAPACITY = 1024;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const METRES_PER_KM = 1000;

const KEY_PAUSE = 'KeyP';
const KEY_TOGGLE_UI = 'KeyH';
const KEY_TOGGLE_DEBUG = 'KeyF';
const KEY_CAMERA_MODE = 'KeyC';
/** Helm keys (physical positions; arrows as alternatives). */
const KEYS_THROTTLE_UP = ['KeyW', 'ArrowUp'];
const KEYS_THROTTLE_DOWN = ['KeyS', 'ArrowDown'];
const KEYS_RUDDER_PORT = ['KeyA', 'ArrowLeft'];
const KEYS_RUDDER_STARBOARD = ['KeyD', 'ArrowRight'];
const KEY_RUDDER_CENTRE = 'Space';
const MS_PER_S = 1000;

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

/** Everything that depends on the quality preset; rebuilt when the preset changes. */
interface QualityResources {
  readonly preset: QualityPreset;
  readonly ocean: Ocean;
  readonly waterQuery: WaterQuery;
  readonly wake: WakeFoam;
  readonly effects: ShipEffects;
  readonly debugTextureView: DebugTextureView;
}

interface AppPasses {
  readonly shipSystem: ShipSystem;
  readonly quality: QualityResources;
  readonly debugDraw: DebugDraw;
  readonly atmosphere: Atmosphere;
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
  private readonly shipCamera = new ShipCamera();
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
  private readonly frameTimes = new FrameTimeStats(FRAME_STATS_WINDOW);
  /** Wall-clock duration of the last frame (ms); unlike FrameInfo.frameSeconds not clamped by the loop. */
  private wallFrameMs = 0;
  private previousTimestampMs: number | null = null;
  private readonly benchmark: Benchmark | null;

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
  private readonly atmosphere: Atmosphere;
  private readonly shipSystem: ShipSystem;
  private readonly debugDraw: DebugDraw;
  private quality: QualityResources;
  /** Preset being built in the background, or null. */
  private pendingQuality: QualityPreset | null = null;
  /** Replaced resources, destroyed once the GPU work that may still use them has finished. */
  private readonly retired: { resources: QualityResources; disposeAtFrame: number }[] = [];
  private frameIndex = 0;

  private get ocean(): Ocean {
    return this.quality.ocean;
  }

  private get waterQuery(): WaterQuery {
    return this.quality.waterQuery;
  }

  private get effects(): ShipEffects {
    return this.quality.effects;
  }

  private get debugTextureView(): DebugTextureView {
    return this.quality.debugTextureView;
  }

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
    this.atmosphere = passes.atmosphere;
    this.shipSystem = passes.shipSystem;
    this.quality = passes.quality;
    this.debugDraw = passes.debugDraw;
    this.settings = createDefaultSettings();
    this.settings.paused = launch.paused;
    this.settings.quality = passes.quality.preset;
    this.benchmark = launch.benchmark ? new Benchmark(QUALITY_PRESETS) : null;
    if (this.benchmark) {
      // Benchmark scenario: under way at full throttle so wake and spray are active.
      this.settings.paused = false;
      passes.shipSystem.ship.helm.throttle = passes.shipSystem.ship.model.config.propulsion.maxThrottle;
    }
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
    // Pipelines compile in parallel.
    const [skyPass, gridPass, tonemapPass, shipSystem, debugDraw] = await Promise.all([
      SkyPass.create(device, frameUniforms),
      GridPass.create(device, frameUniforms),
      TonemapPass.create(device, canvasFormat, atmosphere.skyLightBuffer),
      ShipSystem.create(device, frameUniforms, PATROL_BOAT),
      DebugDraw.create(device, frameUniforms, canvasFormat),
    ]);
    const quality = await App.createQualityResources(
      options.gpu,
      frameUniforms,
      atmosphere,
      shipSystem,
      options.launch.quality,
      options.launch.seed,
      null,
    );
    return new App(options, {
      shipSystem,
      quality,
      debugDraw,
      atmosphere,
      frameUniforms,
      skyPass,
      gridPass,
      tonemapPass,
    });
  }

  private static async createQualityResources(
    gpu: GpuContext,
    frameUniforms: FrameUniforms,
    atmosphere: Atmosphere,
    shipSystem: ShipSystem,
    preset: QualityPreset,
    seed: number,
    cloth: FlagCloth | null,
  ): Promise<QualityResources> {
    const { device, canvasFormat } = gpu;
    const config = QUALITY[preset];
    // The ocean shader samples the wake foam, so the wake exists first.
    const wake = await WakeFoam.create(device, config.wake);
    const ocean = await Ocean.create(device, frameUniforms, preset, seed, wake);
    const oceanTextures = ocean.debugTextures;
    const [waterQuery, effects, debugTextureView] = await Promise.all([
      ocean.createWaterQuery(device, WATER_QUERY_CAPACITY),
      ShipEffects.create(device, frameUniforms, shipSystem, wake, ocean.displacementField, config.sprayParticles, cloth),
      DebugTextureView.create(device, canvasFormat, {
        spectrum: oceanTextures.spectrum,
        displacement: oceanTextures.displacement,
        derivatives: oceanTextures.derivatives,
        foam: oceanTextures.foam,
        skyView: atmosphere.skyViewLut,
        transmittance: atmosphere.transmittanceLut,
      }),
    ]);
    return { preset, ocean, waterQuery, wake, effects, debugTextureView };
  }

  /**
   * Builds the resources of another quality preset in the background and swaps
   * them in when ready. The simulation (ship, wind, camera) carries on; the
   * wave field is regenerated at the new resolution.
   */
  private requestQuality(preset: QualityPreset): void {
    this.pendingQuality = preset;
    App.createQualityResources(
      this.gpu,
      this.frameUniforms,
      this.atmosphere,
      this.shipSystem,
      preset,
      this.launch.seed,
      this.quality.effects.cloth,
    ).then(
      (resources) => {
        this.retired.push({ resources: this.quality, disposeAtFrame: this.frameIndex + RETIRE_AFTER_FRAMES });
        this.quality = resources;
        this.pendingQuality = null;
        replaceUrlParameter('quality', preset);
      },
      (error: unknown) => {
        console.error(`[quality] switching to ${preset} failed:`, error);
        this.pendingQuality = null;
        this.settings.quality = this.quality.preset;
        this.panel.refresh();
      },
    );
  }

  private disposeRetired(): void {
    for (let i = this.retired.length - 1; i >= 0; i--) {
      const entry = this.retired[i] as { resources: QualityResources; disposeAtFrame: number };
      if (this.frameIndex < entry.disposeAtFrame) continue;
      const r = entry.resources;
      r.effects.dispose();
      r.wake.dispose();
      r.waterQuery.dispose();
      r.debugTextureView.dispose();
      r.ocean.dispose();
      this.retired.splice(i, 1);
    }
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** One fixed simulation step. */
  private step(): void {
    const anyDown = (codes: readonly string[]): boolean => codes.some((code) => this.input.isDown(code));
    this.shipSystem.ship.helm.update(
      {
        throttleUp: anyDown(KEYS_THROTTLE_UP),
        throttleDown: anyDown(KEYS_THROTTLE_DOWN),
        port: anyDown(KEYS_RUDDER_PORT),
        starboard: anyDown(KEYS_RUDDER_STARBOARD),
        // A short tap may fall between two simulation steps; count it too.
        centre: this.input.isDown(KEY_RUDDER_CENTRE) || this.input.wasPressed(KEY_RUDDER_CENTRE),
      },
      this.clock.stepSeconds,
    );
    this.shipSystem.ship.setWind(this.wind.speedMs, this.wind.fromDirectionRad);
    this.effects.setWind(this.wind.speedMs, this.wind.fromDirectionRad);
    this.shipSystem.step(this.clock.stepSeconds, this.clock.time);
    this.effects.step(this.clock.stepSeconds, this.clock.time);
    this.clock.advance();
    this.wind.setTarget(this.settings.windSpeedMs, this.settings.windDirectionDeg * DEG_TO_RAD);
    this.wind.step(this.clock.stepSeconds);
  }

  private frame(frame: FrameInfo): void {
    const cpuStart = performance.now();
    this.lastFrame = frame;
    this.fps.tick(frame.timestampMs);

    this.handleShortcuts();
    this.frameIndex = frame.frameIndex;
    this.disposeRetired();
    if (this.previousTimestampMs !== null) {
      this.wallFrameMs = frame.timestampMs - this.previousTimestampMs;
      this.frameTimes.push(this.wallFrameMs);
    }
    this.previousTimestampMs = frame.timestampMs;
    this.runBenchmark(frame);
    if (this.settings.quality !== this.quality.preset && this.pendingQuality === null) {
      this.requestQuality(this.settings.quality);
    }
    this.ocean.setSeaState({
      windSpeedMs: this.wind.speedMs,
      windFromRad: this.wind.fromDirectionRad,
      fetchM: this.settings.fetchKm * METRES_PER_KM,
      choppiness: this.settings.choppiness,
    });
    // The camera follows the ship's pose interpolated to the render instant.
    this.shipSystem.updateRenderPose(this.settings.paused ? 1 : frame.alpha);
    const target = this.shipSystem.cameraTarget;
    if (this.settings.cameraMode !== this.shipCamera.mode) {
      this.shipCamera.setMode(this.settings.cameraMode, target);
    }
    this.shipCamera.handleInput(this.input);
    const waterBelowCamera = this.shipSystem.cameraWaterHeight;
    this.shipCamera.update(this.camera, target, {
      dt: frame.frameSeconds,
      // Before the first water query result, a conservative crest height is assumed.
      waterHeightM:
        waterBelowCamera ?? CAMERA_CREST_ALLOWANCE_PER_HS * this.ocean.significantWaveHeightM,
      secondsSinceInput: (frame.timestampMs - this.input.lastCameraInteractionMs) / MS_PER_S,
      returnDelayS: this.settings.cameraReturnDelayS,
    });

    this.renderScene(frame);

    this.input.endFrame();
    this.cpuFrameMs.push(performance.now() - cpuStart);
    this.updateUi(frame);
  }

  private runBenchmark(frame: FrameInfo): void {
    const bench = this.benchmark;
    if (!bench || bench.done) return;
    const completed = bench.update({
      nowMs: frame.timestampMs,
      frameMs: this.wallFrameMs,
      activePreset: this.quality.preset,
      gpuMs: this.timer.frameMs,
      width: this.sizer.width,
      height: this.sizer.height,
    });
    this.settings.quality = bench.requestedPreset;
    if (completed && bench.done) {
      console.info('[benchmark] results');
      console.table(bench.results.map(formatBenchmarkResult));
      this.settings.debugOverlay = true;
      this.panel.refresh();
    }
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
    if (this.input.wasPressed(KEY_CAMERA_MODE)) {
      this.shipCamera.cycleMode(this.shipSystem.cameraTarget);
      this.settings.cameraMode = this.shipCamera.mode;
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
    const shipOrigin = this.shipSystem.ship.body.position;
    this.waterQuery.begin(shipOrigin[0] as number, shipOrigin[2] as number);
    this.shipSystem.requestWater(this.waterQuery, this.camera.position[0] as number, this.camera.position[2] as number);
    this.waterQuery.encode(encoder);
    this.effects.setToggles({ wake: this.settings.wakeFoam, spray: this.settings.spray, flag: this.settings.flag });
    this.effects.encode(encoder, renderTime, this.settings.paused ? 0 : frame.frameSeconds, {
      wake: this.timer.timestampWrites('wake'),
      spray: this.timer.timestampWrites('spray'),
    });
    this.shipSystem.prepareDraw(this.camera.position);
    this.effects.prepareDraw(this.camera.position);

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
    // Ship first: the sea behind the hull then fails the depth test early.
    this.shipSystem.draw(scenePass);
    this.effects.drawOpaque(scenePass);
    this.ocean.draw(scenePass);
    if (this.settings.showGrid) {
      this.gridPass.draw(scenePass);
    }
    // Sky last: it only shades pixels left at the far plane.
    this.skyPass.draw(scenePass);
    // Blended spray after everything opaque, including the sky.
    this.effects.drawTransparent(scenePass);
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
    this.debugDraw.begin(this.camera.position);
    if (this.settings.debugSubmerged || this.settings.debugForces) {
      this.shipSystem.drawDebug(this.debugDraw, {
        submerged: this.settings.debugSubmerged,
        forces: this.settings.debugForces,
      });
    }
    this.debugDraw.encode(encoder, swapchainView);

    this.timer.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    this.timer.afterSubmit();
    this.ocean.afterSubmit();
    this.waterQuery.afterSubmit();
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
    const ship = this.shipSystem.ship;
    const config = ship.model.config;
    this.hud.update(
      {
        sea: {
          beaufort: windSpeedToBeaufort(this.wind.speedMs),
          windSpeedMs: this.wind.speedMs,
          targetWindSpeedMs: this.wind.transitioning ? this.wind.targetSpeedMs : null,
          windFromDeg: this.wind.fromDirectionRad * RAD_TO_DEG,
          significantWaveHeightM: this.ocean.significantWaveHeightM,
        },
        ship: {
          rollDeg: ship.rollRad * RAD_TO_DEG,
          pitchDeg: ship.pitchRad * RAD_TO_DEG,
          headingDeg: ship.headingRad * RAD_TO_DEG,
          speedKnots: ship.speedMs / KNOTS_TO_MS,
          throttle: ship.helm.throttle,
          minThrottle: config.propulsion.minThrottle,
          rpm: ship.propulsion.state.rpm,
          rudderOrderDeg: ship.helm.rudderOrderRad * RAD_TO_DEG,
          rudderAngleDeg: ship.propulsion.state.rudderAngleRad * RAD_TO_DEG,
          maxRudderDeg: config.rudder.maxAngleRad * RAD_TO_DEG,
          apparentWindMs: ship.windLoad.state.apparentSpeedMs,
          apparentWindFromRelativeDeg: ship.windLoad.state.apparentFromRelativeRad * RAD_TO_DEG,
        },
        cameraModeLabel: CAMERA_MODE_LABELS[this.shipCamera.mode],
        fps: this.fps.rate,
        cpuFrameMs: this.cpuFrameMs.value,
        gpuFrameMs: this.timer.frameMs,
        gpuTimingSupported: this.timer.supported,
        renderWidth: this.sizer.width,
        renderHeight: this.sizer.height,
        paused: this.settings.paused,
        status: this.statusText(now),
        simTimeSeconds: this.clock.time,
      },
      now,
    );
    this.debugOverlay.update(now, () => this.debugSections());
  }

  private shipDebugSection(): DebugSection {
    const ship = this.shipSystem.ship;
    const model = ship.model;
    const hs = model.hydrostatics;
    const b = ship.buoyancy.result;
    const prop = ship.propulsion.state;
    const wind = ship.windLoad.state;
    const sources = this.effects.sources;
    const fmt = (v: number, d = 2): string => v.toFixed(d);
    return {
      title: 'Ship',
      lines: [
        `${model.config.name}: L=${model.config.hull.lengthM} m, B=${model.config.hull.beamM} m, T=${model.config.hull.designDraftM} m, ` +
          `m=${fmt(model.config.mass.massKg / 1000, 0)} t, section q=${fmt(model.sectionExponent, 3)}`,
        `V=${fmt(hs.volumeM3, 1)} m³, KB=${fmt(hs.centreOfBuoyancy[1] + model.config.hull.designDraftM)} m, BM=${fmt(hs.metacentricRadiusM)} m, ` +
          `GM=${model.config.mass.metacentricHeightM} m, T_roll=${fmt(model.naturalRollPeriodS, 1)} s, T_heave=${fmt(model.naturalHeavePeriodS, 1)} s`,
        `physics mesh: ${model.physicsMesh.triangleCount} tris, submerged pieces ${ship.buoyancy.submerged.count}, ` +
          `water from ${this.shipSystem.waterReady ? 'GPU' : 'flat fallback'}`,
        `draft ${fmt(ship.draftM)} m, displaced ${fmt(b.submergedVolumeM3, 1)} m³, heave v ${fmt(ship.body.velocity[1] as number)} m/s`,
        `propulsion: throttle ${fmt(ship.helm.throttle * 100, 0)} %, ${fmt(prop.rpm, 0)} rpm, thrust ${fmt(prop.thrustN / 1000, 1)} kN, ` +
          `prop immersion ${fmt(prop.propellerImmersion * 100, 0)} %`,
        `rudder: order ${fmt(ship.helm.rudderOrderRad * RAD_TO_DEG, 1)}°, angle ${fmt(prop.rudderAngleRad * RAD_TO_DEG, 1)}°, ` +
          `AoA ${fmt(prop.rudderAngleOfAttackRad * RAD_TO_DEG, 1)}°, side force ${fmt(prop.rudderSideForceN / 1000, 1)} kN`,
        `resistance: residuary ${fmt(ship.hydrodynamics.totals.residuaryN / 1000, 1)} kN, surge ${fmt(ship.surgeSpeedMs)} m/s, ` +
          `calibration T0 ${fmt(model.propeller.bollardThrustN / 1000, 0)} kN, Vref ${fmt(model.propeller.referenceSpeedMs)} m/s`,
        `wind load: apparent ${fmt(wind.apparentSpeedMs, 1)} m/s from ${fmt(wind.apparentFromRelativeRad * RAD_TO_DEG, 0)}° rel., ` +
          `surge ${fmt(wind.surgeForceN / 1000, 1)} kN, sway ${fmt(wind.swayForceN / 1000, 1)} kN ` +
          `(A_L ${fmt(model.windage.lateralAreaM2, 0)} m², A_F ${fmt(model.windage.frontalAreaM2, 0)} m², ` +
          `CE ${fmt(model.windage.lateralCentre[1], 1)} m above WL)`,
        `effects: Fn ${fmt(sources.froude)}, bow entry ${fmt(sources.bowEntrySpeedMs)} m/s, thrust ${fmt(sources.thrustFraction * 100, 0)} % of bollard, ` +
          `spray spawned ${this.effects.spray.spawnedTotal}, flag rel. wind ${fmt(this.effects.cloth.relativeWindMs, 1)} m/s`,
        `camera water height: ${this.shipSystem.cameraWaterHeight === null ? '–' : `${fmt(this.shipSystem.cameraWaterHeight)} m`}`,
      ],
    };
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

  private statusText(nowMs: number): string | null {
    const progress = this.benchmark?.progress(nowMs, QUALITY_LABELS) ?? null;
    if (progress) return `Performans ölçümü — ${progress}`;
    if (this.pendingQuality) return `Kalite değiştiriliyor: ${QUALITY_LABELS[this.pendingQuality]}…`;
    return null;
  }

  private performanceSection(): DebugSection {
    const summary = this.frameTimes.summary();
    const fmt = (v: number): string => v.toFixed(2);
    const lines = [
      `quality: ${this.quality.preset}, render ${this.sizer.width} x ${this.sizer.height}`,
      summary === null
        ? 'frame times: –'
        : `last ${summary.count} frames: mean ${fmt(summary.meanMs)} ms (${summary.meanFps.toFixed(1)} FPS), ` +
          `p95 ${fmt(summary.p95Ms)} ms, max ${fmt(summary.maxMs)} ms`,
      `CPU ${this.cpuFrameMs.value === null ? '–' : `${fmt(this.cpuFrameMs.value)} ms`}, ` +
        `GPU ${this.timer.frameMs === null ? (this.timer.supported ? '–' : 'n/a (no timestamp-query)') : `${fmt(this.timer.frameMs)} ms`}`,
    ];
    for (const result of this.benchmark?.results ?? []) {
      const r = formatBenchmarkResult(result);
      lines.push(`bench ${r.quality}: ${r.fps} FPS, mean ${r.meanMs} ms, p95 ${r.p95Ms} ms, GPU ${r.gpuMs} ms @ ${r.resolution}`);
    }
    return { title: 'Performance', lines };
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
      this.performanceSection(),
      this.oceanDebugSection(),
      this.shipDebugSection(),
      {
        title: 'Camera',
        lines: [
          `position: ${fmt(p[0] as number)}, ${fmt(p[1] as number)}, ${fmt(p[2] as number)} m`,
          `forward: ${fmt(f[0] as number, 3)}, ${fmt(f[1] as number, 3)}, ${fmt(f[2] as number, 3)}`,
          `near/far: ${this.camera.near} / ${this.camera.far} m (reversed Z)`,
          `mode: ${this.shipCamera.mode}, distance ${fmt(this.shipCamera.distanceM, 0)} m`,
        ],
      },
      {
        title: 'Launch (URL)',
        lines: [
          `wind: ${launch.beaufort === null ? 'default' : `${launch.beaufort} Bf`}, ` +
            `dir: ${launch.windDirectionDeg === null ? 'default' : `${launch.windDirectionDeg}°`}`,
          `seed: ${launch.seed}, quality: ${launch.quality} (now ${this.quality.preset}` +
            `${this.pendingQuality ? `, building ${this.pendingQuality}` : ''}), paused: ${launch.paused ? 1 : 0}`,
        ],
      },
    ];
  }
}

function formatBenchmarkResult(r: BenchmarkResult): Record<string, string> {
  return {
    quality: r.preset,
    resolution: `${r.width}x${r.height}`,
    fps: r.meanFps.toFixed(1),
    meanMs: r.meanMs.toFixed(2),
    p95Ms: r.p95Ms.toFixed(2),
    maxMs: r.maxMs.toFixed(2),
    gpuMs: r.gpuMs === null ? 'n/a' : r.gpuMs.toFixed(2),
  };
}
