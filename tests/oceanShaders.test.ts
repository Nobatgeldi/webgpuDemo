import { describe, expect, it } from 'vitest';
import oceanComputeWgsl from '../src/shaders/oceanCompute.wgsl?raw';
import oceanWgsl from '../src/shaders/ocean.wgsl?raw';
import { OCEAN_COMPUTE_UNIFORM_OFFSETS } from '../src/ocean/cascades';
import {
  LEVEL_FLOATS,
  OCEAN_LEVEL_OFFSETS,
  OCEAN_RENDER_UNIFORM_OFFSETS,
  RENDER_UNIFORM_BYTES,
} from '../src/ocean/oceanPass';
import { OCEAN_COMPUTE_UNIFORM_BYTES } from '../src/ocean/spectrum';
import { MAX_CASCADES } from '../src/ocean/oceanConfig';
import { SPECTRUM_SHADER_CONSTANTS } from '../src/ocean/spectrumModel';
import { computeStructLayout } from './helpers/wgslLayout';

const bytes = (offsets: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(offsets).map(([name, floats]) => [name, floats * 4]));

describe('ocean uniform layouts', () => {
  it('OceanComputeUniforms matches the TypeScript writer', () => {
    const layout = computeStructLayout(oceanComputeWgsl, 'OceanComputeUniforms');
    expect(layout.offsets).toEqual(bytes(OCEAN_COMPUTE_UNIFORM_OFFSETS));
    expect(layout.size).toBe(OCEAN_COMPUTE_UNIFORM_BYTES);
    expect(oceanComputeWgsl).toContain(`array<vec4<f32>, ${MAX_CASCADES}>`);
  });

  it('OceanRenderUniforms and OceanLevel match the TypeScript writer', () => {
    const uniforms = computeStructLayout(oceanWgsl, 'OceanRenderUniforms');
    expect(uniforms.offsets).toEqual(bytes(OCEAN_RENDER_UNIFORM_OFFSETS));
    expect(uniforms.size).toBe(RENDER_UNIFORM_BYTES);
    const level = computeStructLayout(oceanWgsl, 'OceanLevel');
    expect(level.offsets).toEqual(bytes(OCEAN_LEVEL_OFFSETS));
    expect(level.size).toBe(LEVEL_FLOATS * 4);
  });
});

describe('generated spectrum constants', () => {
  const declarations = SPECTRUM_SHADER_CONSTANTS.split('\n');

  it('are valid WGSL f32 constant declarations', () => {
    for (const line of declarations) {
      expect(line).toMatch(/^const [A-Z0-9_]+: f32 = -?\d+(\.\d+)?(e-?\d+)?;$/);
    }
  });

  it('are all used by the spectrum shader, and none is redeclared there', () => {
    for (const line of declarations) {
      const name = /^const (\w+)/.exec(line)?.[1] as string;
      expect(oceanComputeWgsl).toMatch(new RegExp(`\\b${name}\\b`));
      expect(oceanComputeWgsl).not.toMatch(new RegExp(`const ${name}\\b`));
    }
  });
});
