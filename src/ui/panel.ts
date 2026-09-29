import GUI from 'lil-gui';
import { SETTINGS_LIMITS, roundWindSpeed, type AppSettings } from '../settings';
import type { ToneMapper } from '../render/tonemapPass';
import type { DebugTextureName } from '../render/debugTextureView';
import { beaufortToWindSpeed, windSpeedToBeaufort } from '../ocean/beaufort';
import { CAMERA_MODES, CAMERA_MODE_LABELS, type CameraMode } from '../camera/shipCamera';
import { QUALITY_PRESETS, type QualityPreset } from '../core/urlParams';
import { QUALITY_LABELS } from '../quality';

const DEBUG_TEXTURE_OPTIONS: Record<string, DebugTextureName> = {
  Kapalı: 'none',
  'Spektrum h0(k)': 'spectrum',
  'Yer değiştirme': 'displacement',
  'Eğimler / türevler': 'derivatives',
  'Köpük / Jacobian': 'foam',
  'Gökyüzü LUT': 'skyView',
  'Geçirgenlik LUT': 'transmittance',
};

const TONE_MAPPER_OPTIONS: Record<string, ToneMapper> = {
  'ACES (film)': 'aces',
  AgX: 'agx',
};

/**
 * Settings panel (lil-gui). Only controls for features that exist are shown;
 * later phases add quality presets and further debug views.
 */
export class ControlPanel {
  private readonly gui: GUI;

  constructor(settings: AppSettings, callbacks: { onPixelRatioCapChange(cap: number): void }) {
    this.gui = new GUI({ title: 'Ayarlar', width: 300 });

    const L = SETTINGS_LIMITS;
    const simulation = this.gui.addFolder('Simülasyon');
    simulation.add(settings, 'paused').name('Duraklat (P)');

    const sea = this.gui.addFolder('Rüzgâr ve deniz');
    const beaufort = sea
      .add(settings, 'windBeaufort', L.windBeaufort.min, L.windBeaufort.max, L.windBeaufort.step)
      .name('Rüzgâr (Beaufort)');
    const speed = sea
      .add(settings, 'windSpeedMs', L.windSpeedMs.min, L.windSpeedMs.max, L.windSpeedMs.step)
      .name('Rüzgâr hızı (m/s)');
    beaufort.onChange((value: number) => {
      settings.windSpeedMs = roundWindSpeed(beaufortToWindSpeed(value));
      speed.updateDisplay();
    });
    speed.onChange((value: number) => {
      settings.windBeaufort = windSpeedToBeaufort(value);
      beaufort.updateDisplay();
    });
    sea
      .add(settings, 'windDirectionDeg', L.windDirectionDeg.min, L.windDirectionDeg.max, L.windDirectionDeg.step)
      .name('Rüzgâr yönü (°, geldiği)');
    sea.add(settings, 'fetchKm', L.fetchKm.min, L.fetchKm.max, L.fetchKm.step).name('Fetch (km)');
    sea
      .add(settings, 'choppiness', L.choppiness.min, L.choppiness.max, L.choppiness.step)
      .name('Dalga keskinliği');

    const camera = this.gui.addFolder('Kamera');
    const modeOptions: Record<string, CameraMode> = {};
    for (const mode of CAMERA_MODES) modeOptions[CAMERA_MODE_LABELS[mode]] = mode;
    camera.add(settings, 'cameraMode', modeOptions).name('Mod (C)');
    camera
      .add(settings, 'cameraReturnDelayS', L.cameraReturnDelayS.min, L.cameraReturnDelayS.max, L.cameraReturnDelayS.step)
      .name('Varsayılana dönüş (s)');

    const effects = this.gui.addFolder('Efektler');
    effects.add(settings, 'wakeFoam').name('Dümen suyu köpüğü');
    effects.add(settings, 'spray').name('Sprey');
    effects.add(settings, 'flag').name('Bayrak');

    const sun = this.gui.addFolder('Güneş ve gökyüzü');
    sun
      .add(settings, 'sunElevationDeg', L.sunElevationDeg.min, L.sunElevationDeg.max, L.sunElevationDeg.step)
      .name('Yükseklik (°)');
    sun
      .add(settings, 'sunAzimuthDeg', L.sunAzimuthDeg.min, L.sunAzimuthDeg.max, L.sunAzimuthDeg.step)
      .name('Azimut (°, kuzeyden)');
    sun.add(settings, 'stormClouds').name('Fırtınada bulut örtüsü');

    const display = this.gui.addFolder('Görüntü');
    const qualityOptions: Record<string, QualityPreset> = {};
    for (const preset of QUALITY_PRESETS) qualityOptions[QUALITY_LABELS[preset]] = preset;
    display.add(settings, 'quality', qualityOptions).name('Kalite');
    display.add(settings, 'autoExposure').name('Otomatik pozlama');
    display
      .add(settings, 'exposureEv', L.exposureEv.min, L.exposureEv.max, L.exposureEv.step)
      .name('Pozlama (EV)');
    display.add(settings, 'toneMapper', TONE_MAPPER_OPTIONS).name('Ton eşleme');
    display
      .add(settings, 'ditherLsb', L.ditherLsb.min, L.ditherLsb.max, L.ditherLsb.step)
      .name('Bantlaşma önleme');
    display
      .add(settings, 'pixelRatioCap', L.pixelRatioCap.min, L.pixelRatioCap.max, L.pixelRatioCap.step)
      .name('Maks. piksel oranı')
      .onFinishChange((value: number) => callbacks.onPixelRatioCapChange(value));

    const debug = this.gui.addFolder('Hata ayıklama');
    debug.add(settings, 'showGrid').name('Referans ızgarası (y = 0)');
    debug.add(settings, 'oceanWireframe').name('Okyanus tel kafes (LOD)');
    debug.add(settings, 'debugSubmerged').name('Batmış üçgenler');
    debug.add(settings, 'debugForces').name('Kuvvet vektörleri');
    debug.add(settings, 'debugTexture', DEBUG_TEXTURE_OPTIONS).name('Doku görüntüleyici');
    debug.add(settings, 'debugTextureCascade', 0, 2, 1).name('Kaskad');
    debug.add(settings, 'debugOverlay').name('Debug katmanı (F)');
  }

  /** Re-reads all values (after keyboard shortcuts changed settings). */
  refresh(): void {
    for (const controller of this.gui.controllersRecursive()) {
      controller.updateDisplay();
    }
  }

  dispose(): void {
    this.gui.destroy();
  }
}
