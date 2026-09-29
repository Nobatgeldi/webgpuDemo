/**
 * The ship's visual effects together: wake foam (sampled by the ocean),
 * spray particles and the flag. Owns the per-frame emitter derivation.
 */
import { BODY_AFT } from '../ship/rigidBody';
import type { FrameUniforms } from '../render/frameUniforms';
import type { ShipSystem } from '../ship/shipSystem';
import { flagHoistPosition } from '../ship/shipMesh';
import { windSpeedAtHeight, windVelocity } from '../ship/wind';
import { FLAG_CONFIG, FlagCloth } from './flagCloth';
import { FlagRenderer } from './flagRenderer';
import { ShipEffectSources } from './shipEffectSources';
import { SPRAY_CONFIG, SprayParticles } from './spray';
import type { WakeFoam } from './wake';

export interface EffectToggles {
  readonly wake: boolean;
  readonly spray: boolean;
  readonly flag: boolean;
}

export class ShipEffects {
  readonly sources: ShipEffectSources;
  private readonly hoistBottom: Float64Array;
  private readonly hoistTop: Float64Array;
  private readonly hoistAway = new Float64Array(3);
  private readonly flagHoistHull: { bottom: [number, number, number]; top: [number, number, number] };
  private windX = 0;
  private windZ = 0;
  private flagVisible = true;

  private constructor(
    private readonly shipSystem: ShipSystem,
    readonly wake: WakeFoam,
    readonly spray: SprayParticles,
    readonly cloth: FlagCloth,
    private readonly flagRenderer: FlagRenderer,
  ) {
    this.sources = new ShipEffectSources(shipSystem.ship);
    this.flagHoistHull = flagHoistPosition(shipSystem.ship.model.config, FLAG_CONFIG.hoistM);
    this.hoistBottom = new Float64Array(3);
    this.hoistTop = new Float64Array(3);
  }

  static async create(
    device: GPUDevice,
    frameUniforms: FrameUniforms,
    shipSystem: ShipSystem,
    wake: WakeFoam,
    displacement: { readonly texture: GPUTexture; readonly patchSizes: readonly number[] },
    sprayParticles: number,
    /** Cloth to keep simulating (when rebuilding for another quality), or null for a new one. */
    cloth: FlagCloth | null,
  ): Promise<ShipEffects> {
    cloth ??= new FlagCloth();
    const [spray, flagRenderer] = await Promise.all([
      SprayParticles.create(device, frameUniforms, displacement, sprayParticles),
      FlagRenderer.create(device, frameUniforms, cloth),
    ]);
    return new ShipEffects(shipSystem, wake, spray, cloth, flagRenderer);
  }

  setToggles(toggles: EffectToggles): void {
    this.wake.enabled = toggles.wake;
    this.spray.enabled = toggles.spray;
    this.flagVisible = toggles.flag;
  }

  /** True wind at 10 m (speed, direction it blows FROM). */
  setWind(speedMs: number, fromRad: number): void {
    [this.windX, this.windZ] = windVelocity(speedMs, fromRad);
  }

  /** Fixed simulation step: the flag cloth follows the mast. */
  step(dt: number, timeS: number): void {
    if (!this.flagVisible) return;
    const ship = this.shipSystem.ship;
    const { bottom, top } = this.flagHoistHull;
    ship.hullPointToWorld(bottom[0], bottom[1], bottom[2], this.hoistBottom);
    ship.hullPointToWorld(top[0], top[1], top[2], this.hoistTop);
    // Initially the flag hangs out astern.
    ship.body.rotateToWorld(BODY_AFT, this.hoistAway);
    const scale = windSpeedAtHeight(1, this.hoistTop[1] as number);
    this.cloth.step(dt, timeS, this.hoistBottom, this.hoistTop, this.hoistAway, this.windX * scale, 0, this.windZ * scale);
  }

  /** Per-frame GPU work (wake field and spray simulation); call after the ocean simulation was encoded. */
  encode(
    encoder: GPUCommandEncoder,
    timeS: number,
    dt: number,
    timestamps: { wake?: GPUComputePassTimestampWrites; spray?: GPUComputePassTimestampWrites },
  ): void {
    const ship = this.shipSystem.ship;
    this.sources.update(this.shipSystem.waterReady ? this.shipSystem.water : null, timeS, dt);
    const x = ship.body.position[0] as number;
    const z = ship.body.position[2] as number;
    this.wake.encode(encoder, x, z, dt, this.sources.wakeEmitters, timestamps.wake);
    this.spray.encode(
      encoder,
      x,
      z,
      dt,
      this.sources.sprayEmitters,
      this.sources.sprayEmitterCount,
      { x: this.windX, z: this.windZ, heightScale: windSpeedAtHeight(1, SPRAY_CONFIG.windHeightM) },
      timestamps.spray,
    );
  }

  prepareDraw(cameraPosition: ArrayLike<number>): void {
    this.wake.prepareDraw(cameraPosition[0] as number, cameraPosition[2] as number);
    this.spray.prepareDraw(cameraPosition);
    if (this.flagVisible) {
      this.flagRenderer.update(cameraPosition, (world, out) => this.shipSystem.physicsToRenderPose(world, out));
    }
  }

  /** Opaque geometry (the flag). */
  drawOpaque(pass: GPURenderPassEncoder): void {
    if (this.flagVisible) this.flagRenderer.draw(pass);
  }

  /** Blended geometry after the sky (the spray). */
  drawTransparent(pass: GPURenderPassEncoder): void {
    this.spray.draw(pass);
  }

  dispose(): void {
    this.spray.dispose();
    this.flagRenderer.dispose();
  }
}
