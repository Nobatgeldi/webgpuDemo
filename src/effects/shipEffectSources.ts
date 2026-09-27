/**
 * Where and how strongly the ship makes white water and spray. Derived each
 * frame from the ship state (speed, propeller thrust, bow motion relative to
 * the waves) and consumed by the wake foam texture and the spray particles.
 *
 * Wake foam: each emitter lays down foam along the segment it moved over since
 * the previous frame, so the trail has no gaps at any frame rate. Amounts are
 * specified as the foam left in the water after the ship passed ("deposit"),
 * which is independent of the speed; the emission rate follows from it.
 */
import { GRAVITY_M_S2 } from '../core/constants';
import { hullSection } from '../ship/hull';
import type { Ship } from '../ship/ship';
import type { WaterHeightProvider } from '../ship/waterHeightProvider';

// --- Wake foam -------------------------------------------------------------------
/** Foam left behind the transom by the turbulent stern wake, at full development. */
const STERN_WAKE_DEPOSIT = 0.8;
/** Froude numbers over which the stern wake develops. */
const STERN_WAKE_FROUDE_START = 0.05;
const STERN_WAKE_FROUDE_FULL = 0.3;
/** Stern wake width relative to the transom breadth (Gaussian radius). */
const STERN_WAKE_RADIUS_PER_TRANSOM = 0.35;
/** Foam produced per second by the propeller race at bollard thrust (aeration). */
const PROPELLER_WASH_FOAM_PER_S = 1.0;
/** Radius of the propeller wash patch relative to the propeller diameter. */
const PROPELLER_WASH_RADIUS_PER_DIAMETER = 1.0;
/** Stations (xi = x / (L/2)) along each side where the breaking bow wave leaves foam, and their weights. */
const HULL_SIDE_STATIONS: readonly (readonly [number, number])[] = [
  [0.75, 1.0],
  [0.45, 0.8],
  [0.15, 0.6],
  [-0.2, 0.5],
  [-0.5, 0.5],
  [-0.8, 0.6],
];
/** Hull stations counted as "bow" for slamming (index into HULL_SIDE_STATIONS). */
const BOW_STATION_COUNT = 2;
/** Foam next to the hull from the breaking bow wave at full development. */
const HULL_SIDE_DEPOSIT = 0.6;
/** The bow wave starts breaking above this Froude number and is fully developed at the second. */
const BOW_WAVE_FROUDE_START = 0.2;
const BOW_WAVE_FROUDE_FULL = 0.45;
/** Side foam patch radius (m) and its offset outboard of the waterline (m). */
const HULL_SIDE_RADIUS_M = 1.5;
const HULL_SIDE_OFFSET_M = 0.6;
/** Extra foam per second per m/s of bow entry speed above the threshold (slamming). */
const SLAM_FOAM_PER_S_PER_MS = 0.8;
/** Relative speed with which the bow must plunge into the water to throw white water (m/s). */
const SLAM_ENTRY_THRESHOLD_MS = 1.0;
/** Speed below which the deposit model switches to a constant rate (avoids zero foam at rest) (m/s). */
const MIN_DEPOSIT_SPEED_MS = 0.5;

// --- Spray -----------------------------------------------------------------------
/** Bow spray from the bow wave (particles per second at full development, both sides). */
const BOW_SPRAY_PARTICLES_PER_S = 1200;
const BOW_SPRAY_FROUDE_START = 0.3;
const BOW_SPRAY_FROUDE_FULL = 0.55;
/** Bow spray velocity relative to the ship: outward and upward, as fractions of the ship speed. */
const BOW_SPRAY_OUTWARD_PER_SPEED = 0.35;
const BOW_SPRAY_UP_PER_SPEED = 0.2;
const BOW_SPRAY_SPREAD_PER_SPEED = 0.12;
/** Slamming spray: particles per second per (m/s)^2 of entry speed above the threshold. */
const SLAM_SPRAY_PARTICLES_PER_S = 900;
const SLAM_SPRAY_ENTRY_THRESHOLD_MS = 1.5;
/** Slamming spray velocity per m/s of entry speed (outward, upward, random spread). */
const SLAM_SPRAY_OUTWARD_PER_ENTRY = 1.2;
const SLAM_SPRAY_UP_PER_ENTRY = 2.0;
const SLAM_SPRAY_SPREAD_PER_ENTRY = 0.6;
/** Spray emitter radius (m) and height above the waterline where it starts (m). */
const SPRAY_EMITTER_RADIUS_M = 0.8;
const SPRAY_EMITTER_HEIGHT_M = 0.3;
/** Hull station of the bow spray and slamming emitters (xi). */
const SPRAY_STATION_XI = 0.7;

// --- Bow motion --------------------------------------------------------------------
/** Hull station where the bow entry speed is measured (xi). */
const BOW_PROBE_XI = 0.8;
/** Time constant of the bow entry speed filter (s). */
const BOW_ENTRY_FILTER_S = 0.08;

export const MAX_WAKE_EMITTERS = 2 + 2 * HULL_SIDE_STATIONS.length;
export const MAX_SPRAY_EMITTERS = 4;

export interface WakeEmitter {
  /** World XZ at the previous and the current frame (m). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  radiusM: number;
  /** Foam added over this frame at the centre of the patch. */
  amount: number;
}

export interface SprayEmitter {
  /** World position (m) and mean initial velocity (m/s). */
  readonly position: Float64Array;
  readonly velocity: Float64Array;
  /** Standard deviation of the velocity (m/s) and of the position (m). */
  speedSpreadMs: number;
  radiusM: number;
  /** Particles to spawn this frame (may be fractional; the caller accumulates). */
  particles: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Emission rate (per s) that leaves `deposit` foam behind a source of Gaussian radius r moving at speed u. */
export function depositRate(deposit: number, radiusM: number, speedMs: number): number {
  return (deposit * Math.max(speedMs, MIN_DEPOSIT_SPEED_MS)) / (Math.sqrt(2 * Math.PI) * radiusM);
}

export class ShipEffectSources {
  froude = 0;
  /** Speed with which the bow plunges into the water (m/s, positive into the water). */
  bowEntrySpeedMs = 0;
  /** |thrust| relative to the bollard thrust. */
  thrustFraction = 0;
  readonly wakeEmitters: WakeEmitter[] = [];
  readonly sprayEmitters: SprayEmitter[] = [];
  sprayEmitterCount = 0;

  private previousImmersion: number | null = null;
  private initialised = false;
  private readonly point = new Float64Array(3);
  private readonly forward = new Float64Array(3);
  private readonly starboard = new Float64Array(3);
  /** Hull-frame XZ of each wake emitter. */
  private readonly wakeHullPoints: [number, number][] = [];

  constructor(private readonly ship: Ship) {
    const config = ship.model.config;
    const form = config.hull;
    const half = form.lengthM / 2;
    const prop = config.propulsion;
    this.wakeHullPoints.push([prop.propellerPosition[0] - prop.propellerDiameterM, prop.propellerPosition[2]]);
    this.wakeHullPoints.push([-half, 0]);
    for (const [xi] of HULL_SIDE_STATIONS) {
      const offset = hullSection(form, xi).halfBreadthM + HULL_SIDE_OFFSET_M;
      this.wakeHullPoints.push([xi * half, offset], [xi * half, -offset]);
    }
    for (let i = 0; i < MAX_WAKE_EMITTERS; i++) {
      this.wakeEmitters.push({ x0: 0, z0: 0, x1: 0, z1: 0, radiusM: 1, amount: 0 });
    }
    for (let i = 0; i < MAX_SPRAY_EMITTERS; i++) {
      this.sprayEmitters.push({
        position: new Float64Array(3),
        velocity: new Float64Array(3),
        speedSpreadMs: 0,
        radiusM: SPRAY_EMITTER_RADIUS_M,
        particles: 0,
      });
    }
  }

  /** Updates drivers and emitters for a frame of `dt` seconds. */
  update(water: WaterHeightProvider | null, timeS: number, dt: number): void {
    const ship = this.ship;
    const config = ship.model.config;
    const form = config.hull;
    const half = form.lengthM / 2;
    const speed = Math.abs(ship.surgeSpeedMs);
    this.froude = speed / Math.sqrt(GRAVITY_M_S2 * form.lengthM);
    this.thrustFraction = Math.abs(ship.propulsion.state.thrustN) / ship.model.propeller.bollardThrustN;

    // Bow entry speed: rate at which the water rises relative to the bow.
    if (water && dt > 0) {
      const bow = ship.hullPointToWorld(BOW_PROBE_XI * half, 0, 0, this.point);
      const immersion = water.heightAt(bow[0] as number, bow[2] as number, timeS) - (bow[1] as number);
      if (this.previousImmersion !== null) {
        const raw = (immersion - this.previousImmersion) / dt;
        this.bowEntrySpeedMs += (raw - this.bowEntrySpeedMs) * (1 - Math.exp(-dt / BOW_ENTRY_FILTER_S));
      }
      this.previousImmersion = immersion;
    } else {
      this.previousImmersion = null;
      this.bowEntrySpeedMs = 0;
    }

    this.updateWake(speed, dt);
    this.updateSpray(speed, dt, half);
    this.initialised = true;
  }

  private updateWake(speed: number, dt: number): void {
    const config = this.ship.model.config;
    const transomBreadth = 2 * hullSection(config.hull, -1).halfBreadthM;
    const sternRadius = STERN_WAKE_RADIUS_PER_TRANSOM * transomBreadth;
    const propRadius = PROPELLER_WASH_RADIUS_PER_DIAMETER * config.propulsion.propellerDiameterM;
    const bowWave = smoothstep(BOW_WAVE_FROUDE_START, BOW_WAVE_FROUDE_FULL, this.froude);
    const slam = Math.max(0, this.bowEntrySpeedMs - SLAM_ENTRY_THRESHOLD_MS);
    this.wakeHullPoints.forEach(([hx, hz], i) => {
      const emitter = this.wakeEmitters[i] as WakeEmitter;
      const p = this.ship.hullPointToWorld(hx, 0, hz, this.point);
      emitter.x0 = this.initialised ? emitter.x1 : (p[0] as number);
      emitter.z0 = this.initialised ? emitter.z1 : (p[2] as number);
      emitter.x1 = p[0] as number;
      emitter.z1 = p[2] as number;
      let rate: number;
      if (i === 0) {
        emitter.radiusM = propRadius;
        rate = PROPELLER_WASH_FOAM_PER_S * this.thrustFraction;
      } else if (i === 1) {
        emitter.radiusM = sternRadius;
        const deposit = STERN_WAKE_DEPOSIT * smoothstep(STERN_WAKE_FROUDE_START, STERN_WAKE_FROUDE_FULL, this.froude);
        rate = depositRate(deposit, sternRadius, speed);
      } else {
        const station = (i - 2) >> 1;
        const weight = (HULL_SIDE_STATIONS[station] as readonly [number, number])[1];
        emitter.radiusM = HULL_SIDE_RADIUS_M;
        rate = depositRate(HULL_SIDE_DEPOSIT * weight * bowWave, HULL_SIDE_RADIUS_M, speed);
        if (station < BOW_STATION_COUNT) rate += SLAM_FOAM_PER_S_PER_MS * slam;
      }
      // Spread over the path covered this frame: every point of a long segment
      // receives what a source passing at that speed leaves behind.
      const pathM = Math.hypot(emitter.x1 - emitter.x0, emitter.z1 - emitter.z0);
      const footprintM = Math.sqrt(2 * Math.PI) * emitter.radiusM;
      emitter.amount = rate * dt * Math.min(1, footprintM / Math.max(pathM, 1e-9));
    });
  }

  private updateSpray(speed: number, dt: number, half: number): void {
    const ship = this.ship;
    const body = ship.body;
    const form = ship.model.config.hull;
    body.rotateToWorld([1, 0, 0], this.forward);
    body.rotateToWorld([0, 0, 1], this.starboard);
    const bowRate = BOW_SPRAY_PARTICLES_PER_S * smoothstep(BOW_SPRAY_FROUDE_START, BOW_SPRAY_FROUDE_FULL, this.froude);
    const entry = Math.max(0, this.bowEntrySpeedMs - SLAM_SPRAY_ENTRY_THRESHOLD_MS);
    const slamRate = SLAM_SPRAY_PARTICLES_PER_S * entry * entry;
    const x = SPRAY_STATION_XI * half;
    const offset = hullSection(form, SPRAY_STATION_XI).halfBreadthM;
    let count = 0;
    for (const side of [1, -1]) {
      for (const slamming of [false, true]) {
        const rate = slamming ? slamRate : bowRate;
        if (rate <= 0) continue;
        const e = this.sprayEmitters[count++] as SprayEmitter;
        ship.hullPointToWorld(x, SPRAY_EMITTER_HEIGHT_M, side * offset, e.position);
        const outward = slamming
          ? SLAM_SPRAY_OUTWARD_PER_ENTRY * this.bowEntrySpeedMs
          : BOW_SPRAY_OUTWARD_PER_SPEED * speed;
        const up = slamming ? SLAM_SPRAY_UP_PER_ENTRY * this.bowEntrySpeedMs : BOW_SPRAY_UP_PER_SPEED * speed;
        for (let k = 0; k < 3; k++) {
          e.velocity[k] =
            (body.velocity[k] as number) + side * outward * (this.starboard[k] as number) + (k === 1 ? up : 0);
        }
        e.speedSpreadMs = slamming ? SLAM_SPRAY_SPREAD_PER_ENTRY * this.bowEntrySpeedMs : BOW_SPRAY_SPREAD_PER_SPEED * speed;
        e.radiusM = SPRAY_EMITTER_RADIUS_M;
        e.particles = rate * dt;
      }
    }
    this.sprayEmitterCount = count;
  }
}
