import { describe, expect, it } from 'vitest';
import { FLAG_CONFIG, FlagCloth } from '../src/effects/flagCloth';

const DT = 1 / 120;
const bottom = [0, 10, 0];
const top = [0, 10 + FLAG_CONFIG.hoistM, 0];

function centroid(cloth: FlagCloth): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  const n = cloth.positions.length / 3;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += (cloth.positions[3 * i + k] as number) / n;
  return c;
}

describe('flag cloth', () => {
  it('streams downwind in a steady breeze and stays intact', () => {
    const cloth = new FlagCloth();
    cloth.reset(bottom, top, [0, 0, 1]);
    // Wind towards +X.
    for (let i = 0; i < 10 * 120; i++) cloth.step(DT, i * DT, bottom, top, [0, 0, 1], 10, 0, 0);
    const [cx, cy] = centroid(cloth);
    expect(cx).toBeGreaterThan(0.5);
    // Held up by the wind: the centroid stays near hoist height.
    expect(cy).toBeGreaterThan(9.8);
    for (const value of cloth.positions) expect(Number.isFinite(value)).toBe(true);
    // Fly edge no further than the flag length (+ small stretch) from the hoist.
    const tip = 3 * cloth.index(cloth.columns - 1, 0);
    const reach = Math.hypot(cloth.positions[tip] as number, (cloth.positions[tip + 2] as number));
    expect(reach).toBeLessThan(FLAG_CONFIG.flyM * 1.1);
  });

  it('hangs down in calm air', () => {
    const cloth = new FlagCloth();
    cloth.reset(bottom, top, [1, 0, 0]);
    for (let i = 0; i < 10 * 120; i++) cloth.step(DT, i * DT, bottom, top, [1, 0, 0], 0, 0, 0);
    const [cx, cy] = centroid(cloth);
    expect(Math.abs(cx)).toBeLessThan(0.3);
    expect(cy).toBeLessThan(10);
  });
});
