/**
 * Source of the water surface height for the physics. The simulator uses the
 * GPU FFT ocean (ocean/waterQuery.ts); tests use the analytic providers below.
 */
import { GRAVITY_M_S2 } from '../core/constants';

export interface WaterHeightProvider {
  /** Height (m) of the water surface above sea level at world (x, z) and time t (s). */
  heightAt(x: number, z: number, timeS: number): number;
}

/** Still water at a constant level. */
export class FlatWater implements WaterHeightProvider {
  constructor(private readonly level = 0) {}

  heightAt(): number {
    return this.level;
  }
}

export interface RegularWaveOptions {
  readonly amplitudeM: number;
  readonly wavelengthM: number;
  /** Propagation direction (unit vector in the XZ plane). */
  readonly directionX: number;
  readonly directionZ: number;
  /** Horizontal displacement scale (0 = sine wave, 1 = Gerstner/trochoid). */
  readonly choppiness?: number;
}

/**
 * Deep-water regular wave h = A cos(k.x0 - w t) with optional horizontal
 * (Gerstner) displacement x = x0 - lambda k^ A sin(k.x0 - w t), the same
 * convention as the FFT ocean. The height at a fixed point p is found like on
 * the GPU: fixed-point iteration of x0 = p - D(x0).
 */
export class RegularWave implements WaterHeightProvider {
  private readonly k: number;
  private readonly omega: number;
  private readonly choppiness: number;

  constructor(
    private readonly options: RegularWaveOptions,
    private readonly iterations = 6,
  ) {
    this.k = (2 * Math.PI) / options.wavelengthM;
    this.omega = Math.sqrt(GRAVITY_M_S2 * this.k);
    this.choppiness = options.choppiness ?? 0;
  }

  get periodS(): number {
    return (2 * Math.PI) / this.omega;
  }

  heightAt(x: number, z: number, timeS: number): number {
    const { amplitudeM: a, directionX: dx, directionZ: dz } = this.options;
    let x0 = x;
    let z0 = z;
    for (let i = 0; i < this.iterations && this.choppiness !== 0; i++) {
      const s = Math.sin(this.k * (dx * x0 + dz * z0) - this.omega * timeS);
      // p = x0 + D(x0), D = -lambda k^ A sin(phase)
      x0 = x + this.choppiness * dx * a * s;
      z0 = z + this.choppiness * dz * a * s;
    }
    return a * Math.cos(this.k * (dx * x0 + dz * z0) - this.omega * timeS);
  }
}
