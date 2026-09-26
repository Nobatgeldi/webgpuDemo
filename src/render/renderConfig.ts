/**
 * Render-wide constants. Values that users may change at runtime live in
 * settings.ts; these are fixed architectural choices.
 */

/** HDR scene colour target; tone mapped to the swap chain at the end of the frame. */
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

/** Reversed-Z depth: near plane maps to 1, far plane to 0, cleared to 0, compare 'greater'. */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
export const DEPTH_CLEAR_VALUE = 0;
export const DEPTH_COMPARE_CLOSER: GPUCompareFunction = 'greater';
/** For geometry drawn exactly at the far plane (the sky), which must only fill untouched pixels. */
export const DEPTH_COMPARE_FAR_PLANE: GPUCompareFunction = 'greater-equal';

/** Camera near plane (m). Reversed-Z float depth keeps precision even with a small near plane. */
export const CAMERA_NEAR_M = 0.1;
/**
 * Camera far plane (m). Must cover the visible sea surface up to the horizon:
 * from 400 m altitude the geometric horizon is ~71 km away.
 */
export const CAMERA_FAR_M = 100_000;
export const CAMERA_DEFAULT_FOV_Y_DEG = 55;

/**
 * Period used to wrap the camera's world XZ before sending it to the GPU for
 * periodic patterns (debug grid). Must be a multiple of every grid spacing.
 */
export const CAMERA_WRAP_PERIOD_M = 1000;

/** Default cap for the effective device pixel ratio. */
export const DEFAULT_PIXEL_RATIO_CAP = 2;

/** Upper bound on timed GPU passes per frame. */
export const MAX_TIMED_PASSES = 16;
