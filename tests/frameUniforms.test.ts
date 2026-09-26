import { describe, expect, it } from 'vitest';
import frameWgsl from '../src/shaders/frame.wgsl?raw';
import tonemapWgsl from '../src/shaders/tonemap.wgsl?raw';
import {
  FRAME_UNIFORM_BYTES,
  FRAME_UNIFORM_FLOATS,
  FRAME_UNIFORM_OFFSETS,
} from '../src/render/frameUniforms';
import { computeStructLayout } from './helpers/wgslLayout';

describe('FrameUniforms layout', () => {
  const layout = computeStructLayout(frameWgsl, 'FrameUniforms');

  it('matches the WGSL struct member by member', () => {
    const expected = Object.fromEntries(
      Object.entries(FRAME_UNIFORM_OFFSETS).map(([name, floats]) => [name, floats * 4]),
    );
    expect(layout.offsets).toEqual(expected);
  });

  it('has the same total size', () => {
    expect(layout.size).toBe(FRAME_UNIFORM_BYTES);
    expect(FRAME_UNIFORM_BYTES).toBe(FRAME_UNIFORM_FLOATS * 4);
  });
});

describe('TonemapUniforms layout', () => {
  it('is four consecutive 32-bit words, as written by TonemapPass', () => {
    const layout = computeStructLayout(tonemapWgsl, 'TonemapUniforms');
    expect(layout.offsets).toEqual({ exposure: 0, operatorId: 4, ditherLsb: 8, frameIndex: 12 });
    expect(layout.size).toBe(16);
  });
});
