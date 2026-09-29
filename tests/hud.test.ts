import { describe, expect, it } from 'vitest';
import { normalizeSignedDeg, relativeWindText } from '../src/ui/hud';

describe('HUD relative wind', () => {
  it('names the side the wind comes from relative to the bow', () => {
    expect(relativeWindText(45, 0)).toBe('sancak 45°');
    expect(relativeWindText(300, 0)).toBe('iskele 60°');
    expect(relativeWindText(10, 10)).toBe('pruvadan');
    expect(relativeWindText(190, 10)).toBe('pupadan');
    expect(relativeWindText(20, 350)).toBe('sancak 30°');
  });

  it('wraps to (-180, 180]', () => {
    expect(normalizeSignedDeg(190)).toBe(-170);
    expect(normalizeSignedDeg(-190)).toBe(170);
    expect(normalizeSignedDeg(180)).toBe(180);
  });
});
