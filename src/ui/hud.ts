/**
 * Heads-up display: plain HTML/SVG overlay. Text is refreshed at a limited
 * rate so DOM work stays negligible; the compass and the helm indicators move
 * every frame (attribute updates only).
 */

/** HUD text refresh interval (ms). */
const HUD_REFRESH_INTERVAL_MS = 250;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Compass geometry in SVG user units (viewBox -COMPASS_SIZE/2 .. +COMPASS_SIZE/2). */
const COMPASS_SIZE = 120;
const COMPASS_RADIUS = 52;
const COMPASS_LABEL_RADIUS = 40;
const COMPASS_TICK_STEP_DEG = 30;
const COMPASS_TICK_LENGTH = 6;
/** Wind arrow: from this radius outside towards the centre. */
const WIND_ARROW_OUTER = 58;
const WIND_ARROW_INNER = 22;

/** Cardinal points in Turkish: Kuzey, Doğu, Güney, Batı. */
const CARDINAL_LABELS: readonly (readonly [string, number])[] = [
  ['K', 0],
  ['D', 90],
  ['G', 180],
  ['B', 270],
];

export interface HudSeaState {
  readonly beaufort: number;
  readonly windSpeedMs: number;
  /** Requested wind speed while the wind is still changing, otherwise null. */
  readonly targetWindSpeedMs: number | null;
  readonly windFromDeg: number;
  readonly significantWaveHeightM: number;
}

export interface HudShipState {
  /** Heel, positive to starboard (deg). */
  readonly rollDeg: number;
  /** Trim, positive bow up (deg). */
  readonly pitchDeg: number;
  readonly headingDeg: number;
  readonly speedKnots: number;
  /** Throttle lever (-0.5 ... 1) and range limits. */
  readonly throttle: number;
  readonly minThrottle: number;
  readonly rpm: number;
  /** Rudder order and actual angle, positive to starboard, and the limit (deg). */
  readonly rudderOrderDeg: number;
  readonly rudderAngleDeg: number;
  readonly maxRudderDeg: number;
  /** Apparent wind on the ship (true wind minus ship velocity) and where it comes from relative to the bow. */
  readonly apparentWindMs: number;
  readonly apparentWindFromRelativeDeg: number;
}

export interface HudStats {
  readonly sea: HudSeaState;
  readonly ship: HudShipState;
  readonly cameraModeLabel: string;
  readonly fps: number;
  readonly cpuFrameMs: number | null;
  /** Null when timestamp queries are unavailable. */
  readonly gpuFrameMs: number | null;
  readonly gpuTimingSupported: boolean;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly paused: boolean;
  readonly simTimeSeconds: number;
}

type HudField =
  | 'speed'
  | 'heading'
  | 'throttle'
  | 'rudder'
  | 'attitude'
  | 'wind'
  | 'relativeWind'
  | 'apparentWind'
  | 'hs'
  | 'camera'
  | 'fps'
  | 'cpu'
  | 'gpu'
  | 'resolution'
  | 'simTime';

/** Wind direction relative to the bow in words: "sancak 40°", "iskele 120°", "pruva", "pupa". */
export function relativeWindText(windFromDeg: number, headingDeg: number): string {
  const relative = normalizeSignedDeg(windFromDeg - headingDeg);
  const magnitude = Math.round(Math.abs(relative));
  if (magnitude === 0) return 'pruvadan';
  if (magnitude === 180) return 'pupadan';
  return `${relative > 0 ? 'sancak' : 'iskele'} ${magnitude}°`;
}

/** Wraps degrees to (-180, 180]. */
export function normalizeSignedDeg(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

export class Hud {
  private readonly fields: Record<HudField, HTMLElement>;
  private readonly pausedBanner: HTMLElement;
  private readonly compassCard: SVGGElement;
  private readonly windArrow: SVGGElement;
  private readonly headingText: SVGTextElement;
  private readonly throttleFill: HTMLElement;
  private readonly throttleZero: HTMLElement;
  private readonly rudderOrderMarker: HTMLElement;
  private readonly rudderAngleMarker: HTMLElement;
  private lastRefreshMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly root: HTMLElement) {
    root.replaceChildren();
    this.pausedBanner = element('div', 'hud-banner', 'DURAKLATILDI');
    this.pausedBanner.hidden = true;
    root.append(this.pausedBanner);

    // Compass (ship-up: the card turns, the ship symbol points up).
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'hud-compass');
    svg.setAttribute('viewBox', `${-COMPASS_SIZE / 2} ${-COMPASS_SIZE / 2} ${COMPASS_SIZE} ${COMPASS_SIZE}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Pusula');
    svg.append(svgElement('circle', { r: COMPASS_RADIUS, class: 'compass-ring' }));
    this.compassCard = svgElement('g', {}) as SVGGElement;
    for (let deg = 0; deg < 360; deg += COMPASS_TICK_STEP_DEG) {
      const rad = (deg * Math.PI) / 180;
      const [sx, sy] = [Math.sin(rad), -Math.cos(rad)];
      this.compassCard.append(
        svgElement('line', {
          x1: sx * COMPASS_RADIUS,
          y1: sy * COMPASS_RADIUS,
          x2: sx * (COMPASS_RADIUS - COMPASS_TICK_LENGTH),
          y2: sy * (COMPASS_RADIUS - COMPASS_TICK_LENGTH),
          class: 'compass-tick',
        }),
      );
    }
    for (const [label, deg] of CARDINAL_LABELS) {
      const rad = (deg * Math.PI) / 180;
      const text = svgElement('text', {
        x: Math.sin(rad) * COMPASS_LABEL_RADIUS,
        y: -Math.cos(rad) * COMPASS_LABEL_RADIUS,
        class: label === 'K' ? 'compass-label compass-north' : 'compass-label',
      });
      text.textContent = label;
      this.compassCard.append(text);
    }
    svg.append(this.compassCard);
    this.windArrow = svgElement('g', { class: 'compass-wind' }) as SVGGElement;
    this.windArrow.append(
      svgElement('line', { x1: 0, y1: -WIND_ARROW_OUTER, x2: 0, y2: -WIND_ARROW_INNER - 4 }),
      svgElement('polygon', {
        points: `0,${-WIND_ARROW_INNER} -5,${-WIND_ARROW_INNER - 9} 5,${-WIND_ARROW_INNER - 9}`,
      }),
    );
    svg.append(this.windArrow);
    svg.append(svgElement('polygon', { points: '0,-14 7,10 0,6 -7,10', class: 'compass-ship' }));
    this.headingText = svgElement('text', { x: 0, y: 26, class: 'compass-heading' }) as SVGTextElement;
    svg.append(this.headingText);

    // Helm indicators.
    const helm = element('div', 'hud-helm');
    const throttle = element('div', 'hud-throttle');
    this.throttleZero = element('div', 'hud-throttle-zero');
    this.throttleFill = element('div', 'hud-throttle-fill');
    throttle.append(this.throttleFill, this.throttleZero);
    const rudder = element('div', 'hud-rudder');
    this.rudderAngleMarker = element('div', 'hud-rudder-angle');
    this.rudderOrderMarker = element('div', 'hud-rudder-order');
    rudder.append(element('div', 'hud-rudder-centre'), this.rudderAngleMarker, this.rudderOrderMarker);
    const gauges = element('div', 'hud-gauges');
    gauges.append(svg, rudder);
    helm.append(gauges, throttle);
    root.append(helm);

    this.fields = {
      speed: this.addRow('Hız'),
      heading: this.addRow('Rota'),
      throttle: this.addRow('Makine'),
      rudder: this.addRow('Dümen (emir / açı)'),
      attitude: this.addRow('Yalpa / baş-kıç'),
      wind: this.addRow('Rüzgâr'),
      relativeWind: this.addRow('Bağıl rüzgâr (geldiği)'),
      apparentWind: this.addRow('Görünür rüzgâr'),
      hs: this.addRow('Belirgin dalga yük. Hs'),
      camera: this.addRow('Kamera'),
      fps: this.addRow('FPS'),
      cpu: this.addRow('CPU kare süresi'),
      gpu: this.addRow('GPU süresi'),
      resolution: this.addRow('Çözünürlük'),
      simTime: this.addRow('Simülasyon zamanı'),
    };
    root.append(
      element(
        'div',
        'hud-hint',
        'W/S: makine · A/D: dümen · Boşluk: dümen orta · C: kamera · Sürükle: döndür · Tekerlek: yakınlaş · ' +
          'P: duraklat · H: arayüz · F: debug',
      ),
    );
  }

  update(stats: HudStats, nowMs: number): void {
    const ship = stats.ship;
    const sea = stats.sea;
    // Every frame: compass card and helm indicators.
    this.compassCard.setAttribute('transform', `rotate(${-ship.headingDeg})`);
    this.windArrow.setAttribute('transform', `rotate(${sea.windFromDeg - ship.headingDeg})`);
    this.windArrow.style.visibility = sea.windSpeedMs > 0 ? 'visible' : 'hidden';
    // Throttle bar: zero line at the astern share of the range.
    const range = 1 - ship.minThrottle;
    const zero = -ship.minThrottle / range;
    const level = (ship.throttle - ship.minThrottle) / range;
    this.throttleZero.style.bottom = percent(zero);
    this.throttleFill.style.bottom = percent(Math.min(zero, level));
    this.throttleFill.style.height = percent(Math.abs(level - zero));
    this.throttleFill.classList.toggle('astern', ship.throttle < 0);
    const rudderPosition = (deg: number): string => percent(0.5 + (0.5 * deg) / ship.maxRudderDeg);
    this.rudderOrderMarker.style.left = rudderPosition(ship.rudderOrderDeg);
    this.rudderAngleMarker.style.left = rudderPosition(ship.rudderAngleDeg);

    if (nowMs - this.lastRefreshMs < HUD_REFRESH_INTERVAL_MS) {
      return;
    }
    this.lastRefreshMs = nowMs;
    this.pausedBanner.hidden = !stats.paused;
    const heading = Math.round(ship.headingDeg) % 360;
    this.headingText.textContent = `${String(heading).padStart(3, '0')}°`;
    this.fields.speed.textContent = `${ship.speedKnots.toFixed(1)} kn`;
    this.fields.heading.textContent = `${heading}°`;
    this.fields.throttle.textContent = `${Math.round(ship.throttle * 100)} % · ${Math.round(ship.rpm)} d/dk`;
    const side = (deg: number): string =>
      Math.abs(deg) < 0.5 ? '0°' : `${deg > 0 ? 'S' : 'İ'} ${Math.abs(deg).toFixed(0)}°`;
    this.fields.rudder.textContent = `${side(ship.rudderOrderDeg)} / ${side(ship.rudderAngleDeg)}`;
    const signed = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;
    this.fields.attitude.textContent = `${signed(ship.rollDeg)} / ${signed(ship.pitchDeg)}`;
    const target = sea.targetWindSpeedMs === null ? '' : ` → ${sea.targetWindSpeedMs.toFixed(1)}`;
    this.fields.wind.textContent = `Bf ${sea.beaufort} · ${sea.windSpeedMs.toFixed(1)}${target} m/s · ${Math.round(sea.windFromDeg) % 360}°`;
    this.fields.relativeWind.textContent = relativeWindText(sea.windFromDeg, ship.headingDeg);
    this.fields.apparentWind.textContent =
      ship.apparentWindMs < 0.05
        ? '–'
        : `${ship.apparentWindMs.toFixed(1)} m/s · ${relativeWindText(ship.apparentWindFromRelativeDeg, 0)}`;
    this.fields.hs.textContent = `${sea.significantWaveHeightM.toFixed(2)} m`;
    this.fields.camera.textContent = stats.cameraModeLabel;
    this.fields.fps.textContent = stats.fps.toFixed(0);
    this.fields.cpu.textContent = stats.cpuFrameMs === null ? '–' : `${stats.cpuFrameMs.toFixed(2)} ms`;
    this.fields.gpu.textContent = !stats.gpuTimingSupported
      ? 'desteklenmiyor'
      : stats.gpuFrameMs === null
        ? 'ölçülüyor…'
        : `${stats.gpuFrameMs.toFixed(2)} ms`;
    this.fields.resolution.textContent = `${stats.renderWidth} × ${stats.renderHeight}`;
    this.fields.simTime.textContent = formatDuration(stats.simTimeSeconds);
  }

  private addRow(label: string): HTMLElement {
    const row = element('div', 'hud-row');
    const value = element('span', 'hud-value', '–');
    row.append(element('span', 'hud-label', label), value);
    this.root.append(row);
    return value;
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function svgElement(tag: string, attributes: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

function percent(fraction: number): string {
  return `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(2)}%`;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
