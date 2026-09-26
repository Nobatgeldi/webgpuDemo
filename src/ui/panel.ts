import GUI from 'lil-gui';
import { SETTINGS_LIMITS, roundWindSpeed, type AppSettings } from '../settings';
import type { ToneMapper } from '../render/tonemapPass';
import { beaufortToWindSpeed, windSpeedToBeaufort } from '../ocean/beaufort';

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

    const sun = this.gui.addFolder('Güneş');
    sun
      .add(settings, 'sunElevationDeg', L.sunElevationDeg.min, L.sunElevationDeg.max, L.sunElevationDeg.step)
      .name('Yükseklik (°)');
    sun
      .add(settings, 'sunAzimuthDeg', L.sunAzimuthDeg.min, L.sunAzimuthDeg.max, L.sunAzimuthDeg.step)
      .name('Azimut (°, kuzeyden)');

    const display = this.gui.addFolder('Görüntü');
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
