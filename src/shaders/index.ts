/**
 * WGSL sources as composable chunks. Shaders are plain `.wgsl` files imported
 * as strings through Vite's `?raw` suffix.
 */
import type { WgslChunk } from '../core/shader';
import commonWgsl from './common.wgsl?raw';
import fftWgsl from './fft.wgsl?raw';
import mipDownsampleWgsl from './mipDownsample.wgsl?raw';
import oceanWgsl from './ocean.wgsl?raw';
import oceanAssembleWgsl from './oceanAssemble.wgsl?raw';
import oceanComputeWgsl from './oceanCompute.wgsl?raw';
import oceanEvolveWgsl from './oceanEvolve.wgsl?raw';
import oceanSpectrumWgsl from './oceanSpectrum.wgsl?raw';
import oceanStatsWgsl from './oceanStats.wgsl?raw';
import frameWgsl from './frame.wgsl?raw';
import gridWgsl from './grid.wgsl?raw';
import skyWgsl from './sky.wgsl?raw';
import skyCommonWgsl from './skyCommon.wgsl?raw';
import tonemapWgsl from './tonemap.wgsl?raw';

const chunk = (label: string, code: string): WgslChunk => ({ label, code });

export const WGSL = {
  common: chunk('common.wgsl', commonWgsl),
  fft: chunk('fft.wgsl', fftWgsl),
  mipDownsample: chunk('mipDownsample.wgsl', mipDownsampleWgsl),
  ocean: chunk('ocean.wgsl', oceanWgsl),
  oceanAssemble: chunk('oceanAssemble.wgsl', oceanAssembleWgsl),
  oceanCompute: chunk('oceanCompute.wgsl', oceanComputeWgsl),
  oceanEvolve: chunk('oceanEvolve.wgsl', oceanEvolveWgsl),
  oceanSpectrum: chunk('oceanSpectrum.wgsl', oceanSpectrumWgsl),
  oceanStats: chunk('oceanStats.wgsl', oceanStatsWgsl),
  frame: chunk('frame.wgsl', frameWgsl),
  grid: chunk('grid.wgsl', gridWgsl),
  sky: chunk('sky.wgsl', skyWgsl),
  skyCommon: chunk('skyCommon.wgsl', skyCommonWgsl),
  tonemap: chunk('tonemap.wgsl', tonemapWgsl),
} as const;
