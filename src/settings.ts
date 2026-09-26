import type { ToneMapper } from './render/tonemapPass';
import type { DebugTextureName } from './render/debugTextureView';
import { DEFAULT_PIXEL_RATIO_CAP } from './render/renderConfig';
import { beaufortToWindSpeed } from './ocean/beaufort';

/** Default sea state: moderate breeze (Bf 5) from the south-west over open ocean. */
const DEFAULT_BEAUFORT = 5;
const DEFAULT_WIND_DIRECTION_DEG = 225;
const DEFAULT_FETCH_KM = 300;
const DEFAULT_CHOPPINESS = 0.9;

/**
 * Runtime-adjustable settings shared between the control panel and the
 * simulation/render systems. Systems read these every frame; the panel writes
 * them.
 */
export interface AppSettings {
  paused: boolean;
  // Sea state
  /** Beaufort class of windSpeedMs (kept in sync by the panel). */
  windBeaufort: number;
  /** Requested 10 m wind speed; the simulated wind approaches it gradually. */
  windSpeedMs: number;
  /** Direction the wind blows FROM, clockwise from north (deg). */
  windDirectionDeg: number;
  fetchKm: number;
  /** Horizontal displacement scale lambda of the choppy waves. */
  choppiness: number;
  // Display
  /** Exposure adapts to the sky brightness; exposureEv is then a compensation. */
  autoExposure: boolean;
  exposureEv: number;
  toneMapper: ToneMapper;
  ditherLsb: number;
  pixelRatioCap: number;
  // Sun
  sunElevationDeg: number;
  sunAzimuthDeg: number;
  /** Cloud cover and a darker sky in strong wind. */
  stormClouds: boolean;
  // UI / debug
  uiVisible: boolean;
  debugOverlay: boolean;
  showGrid: boolean;
  oceanWireframe: boolean;
  debugSubmerged: boolean;
  debugForces: boolean;
  debugTexture: DebugTextureName;
  debugTextureCascade: number;
}

export const SETTINGS_LIMITS = {
  windBeaufort: { min: 0, max: 12, step: 1 },
  windSpeedMs: { min: 0, max: 40, step: 0.1 },
  windDirectionDeg: { min: 0, max: 360, step: 1 },
  fetchKm: { min: 1, max: 1000, step: 1 },
  choppiness: { min: 0, max: 1.5, step: 0.05 },
  exposureEv: { min: -6, max: 6, step: 0.1 },
  ditherLsb: { min: 0, max: 2, step: 0.25 },
  pixelRatioCap: { min: 0.5, max: 3, step: 0.25 },
  sunElevationDeg: { min: -10, max: 90, step: 0.5 },
  sunAzimuthDeg: { min: 0, max: 360, step: 1 },
} as const;

/** Wind speeds are shown and stored with the panel's 0.1 m/s resolution. */
export function roundWindSpeed(speedMs: number): number {
  return Math.round(speedMs / SETTINGS_LIMITS.windSpeedMs.step) * SETTINGS_LIMITS.windSpeedMs.step;
}

export function createDefaultSettings(): AppSettings {
  return {
    paused: false,
    windBeaufort: DEFAULT_BEAUFORT,
    windSpeedMs: roundWindSpeed(beaufortToWindSpeed(DEFAULT_BEAUFORT)),
    windDirectionDeg: DEFAULT_WIND_DIRECTION_DEG,
    fetchKm: DEFAULT_FETCH_KM,
    choppiness: DEFAULT_CHOPPINESS,
    autoExposure: true,
    exposureEv: 0,
    toneMapper: 'aces',
    ditherLsb: 1,
    pixelRatioCap: DEFAULT_PIXEL_RATIO_CAP,
    sunElevationDeg: 25,
    sunAzimuthDeg: 135,
    stormClouds: true,
    uiVisible: true,
    debugOverlay: false,
    showGrid: false,
    oceanWireframe: false,
    debugSubmerged: false,
    debugForces: false,
    debugTexture: 'none',
    debugTextureCascade: 0,
  };
}
