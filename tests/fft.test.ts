import { describe, expect, it } from 'vitest';
import { createRandom } from '../src/core/random';
import {
  inverseDftNaive,
  inverseFft2d,
  inverseFftStockham,
  type ComplexArray,
} from '../src/ocean/fftReference';

function randomSignal(n: number, seed: number): ComplexArray {
  const random = createRandom(seed);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = random() * 2 - 1;
    im[i] = random() * 2 - 1;
  }
  return { re, im };
}

function maxError(a: ComplexArray, b: ComplexArray): number {
  let error = 0;
  for (let i = 0; i < a.re.length; i++) {
    error = Math.max(error, Math.abs((a.re[i] as number) - (b.re[i] as number)));
    error = Math.max(error, Math.abs((a.im[i] as number) - (b.im[i] as number)));
  }
  return error;
}

describe('Stockham inverse FFT (reference of fft.wgsl)', () => {
  it.each([2, 4, 8, 16, 64, 128, 256, 512])('matches the naive DFT for N = %i', (n) => {
    const input = randomSignal(n, n);
    const error = maxError(inverseFftStockham(input), inverseDftNaive(input));
    expect(error).toBeLessThan(1e-9 * n);
  });

  it('turns a single spectral line into a complex exponential', () => {
    const n = 16;
    const input: ComplexArray = { re: new Float64Array(n), im: new Float64Array(n) };
    input.re[3] = 1;
    const out = inverseFftStockham(input);
    for (let x = 0; x < n; x++) {
      expect(out.re[x]).toBeCloseTo(Math.cos((2 * Math.PI * 3 * x) / n), 12);
      expect(out.im[x]).toBeCloseTo(Math.sin((2 * Math.PI * 3 * x) / n), 12);
    }
  });

  it('rejects sizes that are not powers of two', () => {
    expect(() => inverseFftStockham(randomSignal(12, 1))).toThrow(RangeError);
  });
});

describe('2D inverse FFT and real-field packing', () => {
  const n = 32;

  /** Random Hermitian spectrum: X(-k) = conj(X(k)), so its inverse transform is real. */
  function hermitianSpectrum(seed: number): ComplexArray {
    const random = createRandom(seed);
    const re = new Float64Array(n * n);
    const im = new Float64Array(n * n);
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const mx = (n - x) % n;
        const mz = (n - z) % n;
        const index = z * n + x;
        const mirror = mz * n + mx;
        if (mirror < index) continue;
        const r = random() - 0.5;
        const i = index === mirror ? 0 : random() - 0.5;
        re[index] = r;
        im[index] = i;
        re[mirror] = r;
        im[mirror] = -i;
      }
    }
    return { re, im };
  }

  it('matches a naive 2D DFT', () => {
    const input = randomSignal(n * n, 7);
    const fast = inverseFft2d(input, n);
    let error = 0;
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        let sr = 0;
        let si = 0;
        for (let kz = 0; kz < n; kz++) {
          for (let kx = 0; kx < n; kx++) {
            const angle = (2 * Math.PI * (kx * x + kz * z)) / n;
            const xr = input.re[kz * n + kx] as number;
            const xi = input.im[kz * n + kx] as number;
            sr += xr * Math.cos(angle) - xi * Math.sin(angle);
            si += xr * Math.sin(angle) + xi * Math.cos(angle);
          }
        }
        error = Math.max(error, Math.abs(sr - (fast.re[z * n + x] as number)), Math.abs(si - (fast.im[z * n + x] as number)));
      }
    }
    expect(error).toBeLessThan(1e-9);
  });

  it('recovers two real fields from one transform of A + iB', () => {
    const a = hermitianSpectrum(1);
    const b = hermitianSpectrum(2);
    const packed: ComplexArray = {
      re: a.re.map((value, i) => value - (b.im[i] as number)),
      im: a.im.map((value, i) => value + (b.re[i] as number)),
    };
    const fieldA = inverseFft2d(a, n);
    const fieldB = inverseFft2d(b, n);
    const both = inverseFft2d(packed, n);
    for (let i = 0; i < n * n; i++) {
      expect(Math.abs(fieldA.im[i] as number)).toBeLessThan(1e-9);
      expect(both.re[i]).toBeCloseTo(fieldA.re[i] as number, 9);
      expect(both.im[i]).toBeCloseTo(fieldB.re[i] as number, 9);
    }
  });
});
