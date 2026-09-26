import type { ToneMapper } from './render/tonemapPass';
import { DEFAULT_PIXEL_RATIO_CAP } from './render/renderConfig';

/**
 * Runtime-adjustable settings shared between the control panel and the
 * simulation/render systems. Systems read these every frame; the panel writes
 * them.
 */
export interface AppSettings {
  paused: boolean;
  // Display
  exposureEv: number;
  toneMapper: ToneMapper;
  ditherLsb: number;
  pixelRatioCap: number;
  // Sun
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  // UI / debug
  uiVisible: boolean;
  debugOverlay: boolean;
  showGrid: boolean;
}

export const SETTINGS_LIMITS = {
  exposureEv: { min: -6, max: 6, step: 0.1 },
  ditherLsb: { min: 0, max: 2, step: 0.25 },
  pixelRatioCap: { min: 0.5, max: 3, step: 0.25 },
  sunElevationDeg: { min: -10, max: 90, step: 0.5 },
  sunAzimuthDeg: { min: 0, max: 360, step: 1 },
} as const;

export function createDefaultSettings(): AppSettings {
  return {
    paused: false,
    exposureEv: 0,
    toneMapper: 'aces',
    ditherLsb: 1,
    pixelRatioCap: DEFAULT_PIXEL_RATIO_CAP,
    sunElevationDeg: 25,
    sunAzimuthDeg: 135,
    uiVisible: true,
    debugOverlay: false,
    showGrid: true,
  };
}
