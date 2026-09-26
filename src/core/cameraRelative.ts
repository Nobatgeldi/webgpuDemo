/**
 * Camera-relative rendering helpers.
 *
 * World positions live on the CPU in double precision (JS numbers). A float32
 * has a 24-bit mantissa, so at 10 km from the origin its spacing is ~1 mm and
 * at 1000 km ~6 cm: enough to make vertices jitter. Therefore only the
 * difference to the camera (small near the viewer, where precision matters)
 * is converted to float32 and sent to the GPU, and the view matrix contains
 * rotation only.
 *
 * Periodic content (ocean patches, grids) is sampled with a coordinate that
 * is wrapped by its period on the CPU in double precision, so the GPU only
 * ever sees small numbers.
 */

/** Returns value mod period in [0, period), correct for negative inputs. */
export function wrapPeriodic(value: number, period: number): number {
  if (!(period > 0)) {
    throw new RangeError(`period must be positive, got ${period}`);
  }
  const wrapped = value % period;
  // `%` keeps the sign of the dividend, and a tiny negative remainder can round up to `period`.
  const positive = wrapped < 0 ? wrapped + period : wrapped;
  // `+ 0` turns -0 (from e.g. -250 % 250) into +0.
  return positive >= period ? 0 : positive + 0;
}

/**
 * Writes (world - camera) as float32 into `out` at `offset`.
 * The subtraction happens in double precision before the narrowing.
 */
export function toCameraRelative(
  world: ArrayLike<number>,
  camera: ArrayLike<number>,
  out: Float32Array,
  offset = 0,
): Float32Array {
  out[offset] = (world[0] as number) - (camera[0] as number);
  out[offset + 1] = (world[1] as number) - (camera[1] as number);
  out[offset + 2] = (world[2] as number) - (camera[2] as number);
  return out;
}
