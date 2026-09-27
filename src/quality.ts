/**
 * Quality presets (Düşük / Orta / Yüksek): ocean resolution and extent, wake
 * foam resolution and spray particle budget. Selected by ?quality= and in the
 * settings panel at run time.
 */
import type { QualityPreset } from './core/urlParams';
import type { WakeResolution } from './effects/wake';
import { OCEAN_QUALITY, type OceanQualityConfig } from './ocean/oceanConfig';

export interface QualityConfig {
  readonly ocean: OceanQualityConfig;
  readonly wake: WakeResolution;
  readonly sprayParticles: number;
}

export const QUALITY: Record<QualityPreset, QualityConfig> = {
  // 384 m wake window at 0.75 m, 4k particles.
  low: { ocean: OCEAN_QUALITY.low, wake: { textureSize: 512, cellSizeM: 0.75 }, sprayParticles: 4096 },
  // 512 m at 0.5 m, 8k particles.
  medium: { ocean: OCEAN_QUALITY.medium, wake: { textureSize: 1024, cellSizeM: 0.5 }, sprayParticles: 8192 },
  // 614 m at 0.4 m, 16k particles.
  high: { ocean: OCEAN_QUALITY.high, wake: { textureSize: 1536, cellSizeM: 0.4 }, sprayParticles: 16384 },
};

/** Names shown in the settings panel. */
export const QUALITY_LABELS: Readonly<Record<QualityPreset, string>> = {
  low: 'Düşük',
  medium: 'Orta',
  high: 'Yüksek',
};
