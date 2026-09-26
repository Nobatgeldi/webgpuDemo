/**
 * Minimal WGSL struct layout calculator (uniform address space rules) for the
 * scalar/vector/matrix types used in our uniform blocks. Lets tests verify that
 * TypeScript-side offsets match the WGSL declarations.
 */

interface TypeLayout {
  readonly align: number;
  readonly size: number;
}

const TYPE_LAYOUTS: Record<string, TypeLayout> = {
  f32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  'vec2<f32>': { align: 8, size: 8 },
  'vec3<f32>': { align: 16, size: 12 },
  'vec4<f32>': { align: 16, size: 16 },
  'vec4<u32>': { align: 16, size: 16 },
  'mat4x4<f32>': { align: 16, size: 64 },
};

/** Splits struct members at commas that are not inside template arguments (array<T, N>). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '<') depth++;
    if (char === '>') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function typeLayout(type: string): TypeLayout | undefined {
  // Fixed-size arrays: element stride is the element size rounded up to its alignment
  // (uniform address space additionally requires 16-byte alignment).
  const array = /^array<(.+),(\d+)>$/.exec(type);
  if (array) {
    const element = typeLayout(array[1] as string);
    if (!element) {
      return undefined;
    }
    const align = Math.max(element.align, 16);
    const stride = Math.ceil(element.size / align) * align;
    return { align, size: stride * Number(array[2]) };
  }
  return TYPE_LAYOUTS[type];
}

export interface StructLayout {
  /** Byte offset of every member. */
  readonly offsets: Record<string, number>;
  readonly size: number;
}

export function computeStructLayout(source: string, structName: string): StructLayout {
  const match = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`).exec(source);
  if (!match || match[1] === undefined) {
    throw new Error(`struct ${structName} not found`);
  }
  const body = match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .join(' ');
  const offsets: Record<string, number> = {};
  let offset = 0;
  let structAlign = 1;
  for (const member of splitTopLevel(body)) {
    const trimmed = member.trim();
    if (trimmed === '') {
      continue;
    }
    const memberMatch = /^(\w+)\s*:\s*(.+)$/.exec(trimmed);
    if (!memberMatch) {
      throw new Error(`cannot parse member "${trimmed}"`);
    }
    const [, name, type] = memberMatch as unknown as [string, string, string];
    const layout = typeLayout(type.replace(/\s+/g, ''));
    if (!layout) {
      throw new Error(`unsupported type ${type}`);
    }
    offset = Math.ceil(offset / layout.align) * layout.align;
    offsets[name] = offset;
    offset += layout.size;
    structAlign = Math.max(structAlign, layout.align);
  }
  // Uniform address space: struct size rounded up to its alignment, at least 16.
  const align = Math.max(structAlign, 16);
  return { offsets, size: Math.ceil(offset / align) * align };
}
