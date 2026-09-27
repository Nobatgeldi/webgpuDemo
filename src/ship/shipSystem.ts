import { GRAVITY_M_S2 } from '../core/constants';
import type { WaterQuery } from '../ocean/waterQuery';
import type { DebugDraw, Rgba } from '../render/debugDraw';
import type { FrameUniforms } from '../render/frameUniforms';
import type { ShipCameraTarget } from '../camera/shipCamera';
import { rotate } from './rigidBody';
import { Ship, buildShipModel } from './ship';
import type { ShipConfig } from './shipConfig';
import { SHIP_VERTEX_FLOATS, bridgeEyePosition, buildShipVisualMesh, type ShipVisualMesh } from './shipMesh';
import { ShipRenderer } from './shipRenderer';
import { WaterGridProvider, WaterPointProbe } from './waterGrid';
import type { WaterHeightProvider } from './waterHeightProvider';

/**
 * Margin around the hull covered by the water grid (m): the ship moves while
 * a readback is in flight, and heeled topsides reach beyond the waterline breadth.
 */
const WATER_GRID_MARGIN_M = 8;
/** Water grid resolution (samples along and across the ship). */
const WATER_GRID_COLUMNS = 40;
const WATER_GRID_ROWS = 16;
/** Typical age of water query results (s); the grid is placed where the ship will be. */
const WATER_QUERY_LATENCY_S = 0.05;

// Debug view colours (display-referred) and arrow scales.
const SUBMERGED_COLOR: Rgba = [0.1, 0.55, 1.0, 0.35];
const PANEL_FORCE_COLOR: Rgba = [0.2, 1.0, 1.0, 0.9];
const BUOYANCY_COLOR: Rgba = [0.2, 1.0, 0.3, 1];
const GRAVITY_COLOR: Rgba = [1.0, 0.85, 0.1, 1];
const HYDRODYNAMIC_COLOR: Rgba = [1.0, 0.3, 0.9, 1];
/** Newtons per metre of arrow for per-panel forces and for resultant forces. */
const PANEL_FORCE_SCALE_N_PER_M = 4e4;
const TOTAL_FORCE_SCALE_N_PER_M = 5e5;
/** The hydrodynamic resultant is much smaller than weight and buoyancy; it is drawn magnified. */
const HYDRODYNAMIC_ARROW_GAIN = 10;

export interface ShipDebugOptions {
  readonly submerged: boolean;
  readonly forces: boolean;
}

/**
 * The simulated vessel with everything around it: water sampling from the GPU
 * ocean, render-pose interpolation between physics steps, drawing and debug views.
 */
export class ShipSystem {
  readonly ship: Ship;
  private readonly waterGrid: WaterGridProvider;
  private readonly cameraProbe = new WaterPointProbe();
  private readonly previousPosition = new Float64Array(3);
  private readonly previousOrientation = new Float64Array(4);
  private readonly renderPosition = new Float64Array(3);
  private readonly renderOrientation = new Float64Array(4);
  private readonly gridCentre = new Float64Array(3);
  /** Render pose, dimensions and bridge position for the camera rig. */
  readonly cameraTarget: ShipCameraTarget;

  private constructor(
    ship: Ship,
    private readonly renderer: ShipRenderer,
    visualMesh: ShipVisualMesh,
  ) {
    this.ship = ship;
    const boundsMin = [Infinity, Infinity, Infinity];
    const boundsMax = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < visualMesh.vertices.length; v += SHIP_VERTEX_FLOATS) {
      for (let i = 0; i < 3; i++) {
        const value = visualMesh.vertices[v + i] as number;
        boundsMin[i] = Math.min(boundsMin[i] as number, value);
        boundsMax[i] = Math.max(boundsMax[i] as number, value);
      }
    }
    const renderHeading = (): number => this.renderHeadingRad;
    this.cameraTarget = {
      position: this.renderPosition,
      orientation: this.renderOrientation,
      centreOfGravity: ship.model.centreOfGravity,
      boundsMin,
      boundsMax,
      bridgeEye: bridgeEyePosition(ship.model.config),
      get headingRad(): number {
        return renderHeading();
      },
    };
    const hull = ship.model.config.hull;
    this.waterGrid = new WaterGridProvider({
      columns: WATER_GRID_COLUMNS,
      rows: WATER_GRID_ROWS,
      lengthM: hull.lengthM + 2 * WATER_GRID_MARGIN_M,
      widthM: hull.beamM + 2 * WATER_GRID_MARGIN_M,
    });
    this.savePreviousPose();
  }

  static async create(device: GPUDevice, frameUniforms: FrameUniforms, config: ShipConfig): Promise<ShipSystem> {
    const model = buildShipModel(config);
    const ship = new Ship(model, { x: 0, z: 0, headingRad: 0 });
    const visualMesh = buildShipVisualMesh(config, model.sectionExponent);
    const renderer = await ShipRenderer.create(device, frameUniforms, visualMesh, model.centreOfGravity);
    return new ShipSystem(ship, renderer, visualMesh);
  }

  /** True once the physics runs on heights from the GPU ocean. */
  get waterReady(): boolean {
    return this.waterGrid.ready;
  }

  /** Water height at the camera (m), or null before the first readback. */
  get cameraWaterHeight(): number | null {
    return this.cameraProbe.height;
  }

  /** One fixed physics step. */
  step(dt: number, timeS: number): void {
    this.savePreviousPose();
    this.ship.step(dt, this.waterGrid, timeS);
  }

  /** Adds this frame's water queries (grid around the ship, camera point). */
  requestWater(query: WaterQuery, cameraX: number, cameraZ: number): void {
    const body = this.ship.body;
    const centre = this.ship.hullPointToWorld(0, 0, 0, this.gridCentre);
    const x = (centre[0] as number) + (body.velocity[0] as number) * WATER_QUERY_LATENCY_S;
    const z = (centre[2] as number) + (body.velocity[2] as number) * WATER_QUERY_LATENCY_S;
    this.waterGrid.request(query, x, z, this.ship.headingRad);
    this.cameraProbe.request(query, cameraX, cameraZ);
  }

  /**
   * Interpolates the pose between the last two physics steps (alpha in [0, 1))
   * and returns the world position of the centre of gravity for drawing.
   */
  updateRenderPose(alpha: number): Float64Array {
    const body = this.ship.body;
    for (let i = 0; i < 3; i++) {
      this.renderPosition[i] =
        (this.previousPosition[i] as number) + ((body.position[i] as number) - (this.previousPosition[i] as number)) * alpha;
    }
    // Normalised lerp is accurate for the tiny rotation of one physics step.
    let dot = 0;
    for (let i = 0; i < 4; i++) dot += (this.previousOrientation[i] as number) * (body.orientation[i] as number);
    const sign = dot < 0 ? -1 : 1;
    let norm = 0;
    for (let i = 0; i < 4; i++) {
      const value =
        (this.previousOrientation[i] as number) * (1 - alpha) + sign * (body.orientation[i] as number) * alpha;
      this.renderOrientation[i] = value;
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < 4; i++) this.renderOrientation[i] = (this.renderOrientation[i] as number) / norm;
    return this.renderPosition;
  }

  /** Water heights around the ship (GPU ocean), for effects that need the surface on the CPU. */
  get water(): WaterHeightProvider {
    return this.waterGrid;
  }

  /**
   * Moves a world point that is attached to the ship at the latest physics step
   * onto the interpolated render pose (e.g. the flag cloth).
   */
  physicsToRenderPose(world: Float64Array, out: Float64Array): Float64Array {
    const body = this.ship.body;
    for (let i = 0; i < 3; i++) out[i] = (world[i] as number) - (body.position[i] as number);
    rotate(body.orientation, out, out, true);
    rotate(this.renderOrientation, out, out, false);
    for (let i = 0; i < 3; i++) out[i] = (out[i] as number) + (this.renderPosition[i] as number);
    return out;
  }

  /** Heading of the interpolated render pose, clockwise from north (rad). */
  get renderHeadingRad(): number {
    const q = this.renderOrientation;
    // Hull +X in world: first column of the rotation matrix.
    const w = q[0] as number, x = q[1] as number, y = q[2] as number, z = q[3] as number;
    const fx = 1 - 2 * (y * y + z * z);
    const fz = 2 * (x * z - w * y);
    return Math.atan2(fx, -fz);
  }

  prepareDraw(cameraPosition: ArrayLike<number>): void {
    this.renderer.update({ position: this.renderPosition, orientation: this.renderOrientation }, cameraPosition);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.renderer.draw(pass);
  }

  /** Submerged triangles and force vectors of the latest physics step. */
  drawDebug(debug: DebugDraw, options: ShipDebugOptions): void {
    const submerged = this.ship.buoyancy.submerged;
    if (options.submerged) {
      const c = submerged.corners;
      for (let i = 0; i < submerged.count; i++) {
        const o = 9 * i;
        debug.triangle(
          c[o] as number, c[o + 1] as number, c[o + 2] as number,
          c[o + 3] as number, c[o + 4] as number, c[o + 5] as number,
          c[o + 6] as number, c[o + 7] as number, c[o + 8] as number,
          SUBMERGED_COLOR,
        );
      }
    }
    if (options.forces) {
      const s = 1 / PANEL_FORCE_SCALE_N_PER_M;
      for (let i = 0; i < submerged.count; i++) {
        debug.arrow(
          submerged.centroids[3 * i] as number,
          submerged.centroids[3 * i + 1] as number,
          submerged.centroids[3 * i + 2] as number,
          (submerged.forces[3 * i] as number) * s,
          (submerged.forces[3 * i + 1] as number) * s,
          (submerged.forces[3 * i + 2] as number) * s,
          PANEL_FORCE_COLOR,
        );
      }
      const body = this.ship.body;
      const t = 1 / TOTAL_FORCE_SCALE_N_PER_M;
      const [px, py, pz] = [body.position[0] as number, body.position[1] as number, body.position[2] as number];
      const buoyancy = this.ship.buoyancy.result;
      const cb = buoyancy.centreOfBuoyancy;
      debug.arrow(cb[0] as number, cb[1] as number, cb[2] as number, (buoyancy.force[0] as number) * t, (buoyancy.force[1] as number) * t, (buoyancy.force[2] as number) * t, BUOYANCY_COLOR);
      debug.arrow(px, py, pz, 0, -body.mass * GRAVITY_M_S2 * t, 0, GRAVITY_COLOR);
      const hydro = this.ship.hydrodynamics.totals;
      debug.arrow(
        px, py, pz,
        ((hydro.friction[0] as number) + (hydro.pressure[0] as number)) * t * HYDRODYNAMIC_ARROW_GAIN,
        ((hydro.friction[1] as number) + (hydro.pressure[1] as number)) * t * HYDRODYNAMIC_ARROW_GAIN,
        ((hydro.friction[2] as number) + (hydro.pressure[2] as number)) * t * HYDRODYNAMIC_ARROW_GAIN,
        HYDRODYNAMIC_COLOR,
      );
    }
  }

  private savePreviousPose(): void {
    this.previousPosition.set(this.ship.body.position);
    this.previousOrientation.set(this.ship.body.orientation);
  }
}
