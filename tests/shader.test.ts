import { describe, expect, it } from 'vitest';
import { composeWgsl, formatCompilationMessage, resolveSourceLine } from '../src/core/shader';

const composed = composeWgsl('test', [
  { label: 'a.wgsl', code: 'const A: f32 = 1.0;\nconst B: f32 = 2.0;\n' },
  { label: 'b.wgsl', code: 'fn f() -> f32 {\n  return A + C;\n}' },
]);

describe('composeWgsl', () => {
  it('concatenates chunks on separate lines', () => {
    expect(composed.code).toBe(
      'const A: f32 = 1.0;\nconst B: f32 = 2.0;\nfn f() -> f32 {\n  return A + C;\n}\n',
    );
  });

  it('maps composed lines back to their chunk', () => {
    expect(resolveSourceLine(composed, 1)).toEqual({ label: 'a.wgsl', line: 1 });
    expect(resolveSourceLine(composed, 2)).toEqual({ label: 'a.wgsl', line: 2 });
    expect(resolveSourceLine(composed, 3)).toEqual({ label: 'b.wgsl', line: 1 });
    expect(resolveSourceLine(composed, 4)).toEqual({ label: 'b.wgsl', line: 2 });
  });
});

describe('formatCompilationMessage', () => {
  it('prints the chunk location, source line and a caret under the span', () => {
    const text = formatCompilationMessage(composed, {
      type: 'error',
      message: "unresolved value 'C'",
      lineNum: 4,
      linePos: 14,
      length: 1,
    });
    expect(text).toBe(
      "[WGSL error] test (b.wgsl:2:14): unresolved value 'C'\n" +
        '    2 |   return A + C;\n' +
        '      |              ^',
    );
  });

  it('handles messages without a location', () => {
    const text = formatCompilationMessage(composed, {
      type: 'warning',
      message: 'something general',
      lineNum: 0,
      linePos: 0,
      length: 0,
    });
    expect(text).toBe('[WGSL warning] test: something general');
  });
});
