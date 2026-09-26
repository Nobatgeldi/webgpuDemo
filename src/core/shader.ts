/**
 * WGSL module helpers.
 *
 * WGSL has no #include, so shared code (uniform structs, helper functions) is
 * concatenated from several `.wgsl` chunks. Compilation messages refer to line
 * numbers of the concatenated source; this module maps them back to the
 * original chunk and prints them with the offending source line.
 */

export interface WgslChunk {
  /** Human-readable origin, usually the file name (e.g. "sky.wgsl"). */
  readonly label: string;
  readonly code: string;
}

interface ChunkRange {
  readonly label: string;
  /** 1-based first line of the chunk inside the composed source. */
  readonly firstLine: number;
  readonly lineCount: number;
}

export interface ComposedWgsl {
  /** Label of the resulting module (used for GPU object labels and logs). */
  readonly label: string;
  readonly code: string;
  readonly ranges: readonly ChunkRange[];
}

export function composeWgsl(label: string, chunks: readonly WgslChunk[]): ComposedWgsl {
  const ranges: ChunkRange[] = [];
  const parts: string[] = [];
  let nextLine = 1;
  for (const chunk of chunks) {
    // Normalise the trailing newline so that every chunk starts on a fresh line.
    const body = chunk.code.endsWith('\n') ? chunk.code.slice(0, -1) : chunk.code;
    const lineCount = body.split('\n').length;
    ranges.push({ label: chunk.label, firstLine: nextLine, lineCount });
    parts.push(body);
    nextLine += lineCount;
  }
  return { label, code: parts.join('\n') + '\n', ranges };
}

export interface SourceLocation {
  readonly label: string;
  /** 1-based line inside the original chunk. */
  readonly line: number;
}

/** Maps a 1-based line of the composed source back to its chunk. */
export function resolveSourceLine(composed: ComposedWgsl, composedLine: number): SourceLocation {
  for (const range of composed.ranges) {
    if (composedLine >= range.firstLine && composedLine < range.firstLine + range.lineCount) {
      return { label: range.label, line: composedLine - range.firstLine + 1 };
    }
  }
  return { label: composed.label, line: composedLine };
}

/** Structural subset of GPUCompilationMessage so formatting can be unit tested without a GPU. */
export interface CompilationMessageLike {
  readonly type: 'error' | 'warning' | 'info';
  readonly message: string;
  /** 1-based line, 0 when the message has no location. */
  readonly lineNum: number;
  /** 1-based column in UTF-16 code units, 0 when unknown. */
  readonly linePos: number;
  /** Length of the referenced span in UTF-16 code units. */
  readonly length: number;
}

export function formatCompilationMessage(
  composed: ComposedWgsl,
  message: CompilationMessageLike,
): string {
  const header = `[WGSL ${message.type}] ${composed.label}`;
  if (message.lineNum <= 0) {
    return `${header}: ${message.message}`;
  }
  const location = resolveSourceLine(composed, message.lineNum);
  const lines = composed.code.split('\n');
  const sourceLine = lines[message.lineNum - 1] ?? '';
  const gutter = String(location.line).padStart(5);
  const caretIndent = ' '.repeat(Math.max(0, message.linePos - 1));
  const caret = '^'.repeat(Math.max(1, message.length));
  return (
    `${header} (${location.label}:${location.line}:${message.linePos}): ${message.message}\n` +
    `${gutter} | ${sourceLine}\n` +
    `${' '.repeat(gutter.length)} | ${caretIndent}${caret}`
  );
}

export class ShaderCompilationError extends Error {
  override readonly name = 'ShaderCompilationError';

  constructor(
    readonly moduleLabel: string,
    readonly report: string,
  ) {
    super(`WGSL compilation failed for "${moduleLabel}":\n${report}`);
  }
}

/**
 * Creates a shader module and reports compilation messages to the console.
 * Rejects with {@link ShaderCompilationError} if the module has errors, so
 * that initialisation fails loudly instead of producing invalid pipelines.
 */
export async function createShaderModule(
  device: GPUDevice,
  composed: ComposedWgsl,
): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ label: composed.label, code: composed.code });
  const info = await module.getCompilationInfo();
  const errors: string[] = [];
  for (const message of info.messages) {
    const text = formatCompilationMessage(composed, message);
    if (message.type === 'error') {
      console.error(text);
      errors.push(text);
    } else if (message.type === 'warning') {
      console.warn(text);
    } else {
      console.info(text);
    }
  }
  if (errors.length > 0) {
    throw new ShaderCompilationError(composed.label, errors.join('\n'));
  }
  return module;
}
