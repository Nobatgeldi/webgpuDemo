import { describe, expect, it } from 'vitest';
import { computeCanvasPixelSize } from '../src/core/canvasSize';

const base = { maxDimension: 8192 };

describe('computeCanvasPixelSize', () => {
  it('uses the exact device pixel box when available', () => {
    const size = computeCanvasPixelSize({
      ...base,
      cssWidth: 1280,
      cssHeight: 720,
      devicePixelWidth: 1920,
      devicePixelHeight: 1080,
      devicePixelRatio: 1.5,
      pixelRatioCap: 2,
    });
    expect(size).toEqual({ width: 1920, height: 1080, pixelRatio: 1.5 });
  });

  it('caps the effective pixel ratio', () => {
    const size = computeCanvasPixelSize({
      ...base,
      cssWidth: 1280,
      cssHeight: 800,
      devicePixelWidth: 3840,
      devicePixelHeight: 2400,
      devicePixelRatio: 3,
      pixelRatioCap: 2,
    });
    expect(size).toEqual({ width: 2560, height: 1600, pixelRatio: 2 });
  });

  it('falls back to CSS size x DPR', () => {
    const size = computeCanvasPixelSize({
      ...base,
      cssWidth: 1000,
      cssHeight: 500,
      devicePixelRatio: 1.25,
      pixelRatioCap: 2,
    });
    expect(size).toEqual({ width: 1250, height: 625, pixelRatio: 1.25 });
  });

  it('never returns zero or exceeds the device limit', () => {
    const tiny = computeCanvasPixelSize({
      ...base,
      cssWidth: 0,
      cssHeight: 0,
      devicePixelRatio: 1,
      pixelRatioCap: 2,
    });
    expect(tiny.width).toBe(1);
    expect(tiny.height).toBe(1);

    const huge = computeCanvasPixelSize({
      ...base,
      cssWidth: 10000,
      cssHeight: 5000,
      devicePixelRatio: 1,
      pixelRatioCap: 2,
    });
    expect(huge.width).toBe(8192);
    expect(huge.height).toBe(5000);
  });
});
