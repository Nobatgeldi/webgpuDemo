/**
 * CPU reference of the GPU FFT (shaders/fft.wgsl): radix-2 Stockham autosort
 * with the same indexing, twiddle and sign conventions. Used by the tests to
 * validate the algorithm against a naive DFT.
 *
 * Inverse transform without normalisation:
 *   x[n] = sum_k X[k] exp(+2 pi i k n / N)
 * which turns the complex spectrum amplitudes directly into the height field.
 */

export interface ComplexArray {
  re: Float64Array;
  im: Float64Array;
}

/** In-order inverse FFT of length N (power of two), mirroring one workgroup of fft.wgsl. */
export function inverseFftStockham(input: ComplexArray): ComplexArray {
  const n = input.re.length;
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new RangeError(`FFT size must be a power of two, got ${n}`);
  }
  let srcRe = Float64Array.from(input.re);
  let srcIm = Float64Array.from(input.im);
  let dstRe = new Float64Array(n);
  let dstIm = new Float64Array(n);
  const half = n / 2;
  for (let ns = 1; ns < n; ns *= 2) {
    for (let j = 0; j < half; j++) {
      const k = j & (ns - 1);
      const angle = (2 * Math.PI * k) / (2 * ns);
      const wr = Math.cos(angle);
      const wi = Math.sin(angle);
      const ar = srcRe[j] as number;
      const ai = srcIm[j] as number;
      const br0 = srcRe[j + half] as number;
      const bi0 = srcIm[j + half] as number;
      const br = br0 * wr - bi0 * wi;
      const bi = br0 * wi + bi0 * wr;
      const out = (j - k) * 2 + k;
      dstRe[out] = ar + br;
      dstIm[out] = ai + bi;
      dstRe[out + ns] = ar - br;
      dstIm[out + ns] = ai - bi;
    }
    [srcRe, dstRe] = [dstRe, srcRe];
    [srcIm, dstIm] = [dstIm, srcIm];
  }
  return { re: srcRe, im: srcIm };
}

/** Naive O(N^2) inverse DFT with the same sign convention. */
export function inverseDftNaive(input: ComplexArray): ComplexArray {
  const n = input.re.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    let sr = 0;
    let si = 0;
    for (let k = 0; k < n; k++) {
      const angle = (2 * Math.PI * k * x) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const xr = input.re[k] as number;
      const xi = input.im[k] as number;
      sr += xr * c - xi * s;
      si += xr * s + xi * c;
    }
    re[x] = sr;
    im[x] = si;
  }
  return { re, im };
}

/**
 * 2D inverse FFT on a row-major N x N grid, rows first then columns,
 * like the two GPU passes. Index (x, z) is at z * N + x.
 */
export function inverseFft2d(input: ComplexArray, n: number): ComplexArray {
  const re = Float64Array.from(input.re);
  const im = Float64Array.from(input.im);
  const lineRe = new Float64Array(n);
  const lineIm = new Float64Array(n);
  for (let pass = 0; pass < 2; pass++) {
    for (let line = 0; line < n; line++) {
      for (let i = 0; i < n; i++) {
        const index = pass === 0 ? line * n + i : i * n + line;
        lineRe[i] = re[index] as number;
        lineIm[i] = im[index] as number;
      }
      const out = inverseFftStockham({ re: lineRe, im: lineIm });
      for (let i = 0; i < n; i++) {
        const index = pass === 0 ? line * n + i : i * n + line;
        re[index] = out.re[i] as number;
        im[index] = out.im[i] as number;
      }
    }
  }
  return { re, im };
}
