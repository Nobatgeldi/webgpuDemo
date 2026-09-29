/**
 * Deterministic pseudo-random numbers for reproducible oceans (?seed=).
 */

/** Mulberry32: small, fast 32-bit generator; returns floats in [0, 1). */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes a seed with a stream index so that sub-streams are decorrelated. */
export function deriveSeed(seed: number, stream: number): number {
  let h = (seed ^ Math.imul(stream + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Fills `out` with independent standard normal samples (Box-Muller). */
export function fillGaussian(out: Float32Array, random: () => number): Float32Array {
  for (let i = 0; i < out.length; i += 2) {
    // 1 - u keeps the argument of log in (0, 1].
    const radius = Math.sqrt(-2 * Math.log(1 - random()));
    const angle = 2 * Math.PI * random();
    out[i] = radius * Math.cos(angle);
    if (i + 1 < out.length) {
      out[i + 1] = radius * Math.sin(angle);
    }
  }
  return out;
}
