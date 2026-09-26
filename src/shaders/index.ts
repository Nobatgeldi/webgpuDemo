/**
 * WGSL sources as composable chunks. Shaders are plain `.wgsl` files imported
 * as strings through Vite's `?raw` suffix.
 */
import type { WgslChunk } from '../core/shader';
import commonWgsl from './common.wgsl?raw';
import frameWgsl from './frame.wgsl?raw';
import gridWgsl from './grid.wgsl?raw';
import skyWgsl from './sky.wgsl?raw';
import skyCommonWgsl from './skyCommon.wgsl?raw';
import tonemapWgsl from './tonemap.wgsl?raw';

const chunk = (label: string, code: string): WgslChunk => ({ label, code });

export const WGSL = {
  common: chunk('common.wgsl', commonWgsl),
  frame: chunk('frame.wgsl', frameWgsl),
  grid: chunk('grid.wgsl', gridWgsl),
  sky: chunk('sky.wgsl', skyWgsl),
  skyCommon: chunk('skyCommon.wgsl', skyCommonWgsl),
  tonemap: chunk('tonemap.wgsl', tonemapWgsl),
} as const;
