/**
 * Benchmark run (?bench=1): measures each quality preset in turn on the
 * current display. For every preset: switch, warm up (pipelines, wave field,
 * effects reach steady state), then record frame times and GPU time.
 */
import type { QualityPreset } from './urlParams';
import { FrameTimeStats, type FrameTimeSummary } from './time';

export interface BenchmarkTiming {
  /** Seconds after a preset became active before measuring. */
  readonly warmupS: number;
  /** Measured seconds per preset. */
  readonly measureS: number;
}

export const DEFAULT_BENCHMARK_TIMING: BenchmarkTiming = { warmupS: 4, measureS: 10 };
/** Frame-time samples kept per measurement (enough for 10 s at 240 Hz). */
const BENCHMARK_SAMPLE_CAPACITY = 4096;
const MS_PER_S = 1000;

export interface BenchmarkResult extends FrameTimeSummary {
  readonly preset: QualityPreset;
  /** Mean GPU time of the timed passes (ms), null without timestamp queries. */
  readonly gpuMs: number | null;
  readonly width: number;
  readonly height: number;
}

export interface BenchmarkFrame {
  readonly nowMs: number;
  readonly frameMs: number;
  readonly activePreset: QualityPreset;
  readonly gpuMs: number | null;
  readonly width: number;
  readonly height: number;
}

type Phase = 'switching' | 'warmup' | 'measure';

export class Benchmark {
  readonly results: BenchmarkResult[] = [];
  private index = 0;
  private phase: Phase = 'switching';
  private phaseStartMs = 0;
  private readonly stats = new FrameTimeStats(BENCHMARK_SAMPLE_CAPACITY);
  private gpuSum = 0;
  private gpuCount = 0;

  constructor(
    readonly presets: readonly QualityPreset[],
    readonly timing: BenchmarkTiming = DEFAULT_BENCHMARK_TIMING,
  ) {}

  get done(): boolean {
    return this.index >= this.presets.length;
  }

  /** Preset the application should run now (the last one once done). */
  get requestedPreset(): QualityPreset {
    return this.presets[Math.min(this.index, this.presets.length - 1)] as QualityPreset;
  }

  /** Human-readable progress, e.g. "Orta: ölçülüyor 3/10 s"; null when done. */
  progress(nowMs: number, labels: Readonly<Record<QualityPreset, string>>): string | null {
    if (this.done) return null;
    const name = labels[this.requestedPreset];
    const elapsed = Math.floor((nowMs - this.phaseStartMs) / MS_PER_S);
    switch (this.phase) {
      case 'switching':
        return `${name}: hazırlanıyor`;
      case 'warmup':
        return `${name}: ısınma ${elapsed}/${this.timing.warmupS} s`;
      default:
        return `${name}: ölçülüyor ${elapsed}/${this.timing.measureS} s`;
    }
  }

  /** Feeds one frame. Returns true when a preset's measurement was completed. */
  update(frame: BenchmarkFrame): boolean {
    if (this.done) return false;
    const wanted = this.requestedPreset;
    if (frame.activePreset !== wanted) {
      this.phase = 'switching';
      return false;
    }
    const elapsedS = (frame.nowMs - this.phaseStartMs) / MS_PER_S;
    switch (this.phase) {
      case 'switching':
        this.phase = 'warmup';
        this.phaseStartMs = frame.nowMs;
        return false;
      case 'warmup':
        if (elapsedS >= this.timing.warmupS) {
          this.phase = 'measure';
          this.phaseStartMs = frame.nowMs;
          this.stats.reset();
          this.gpuSum = 0;
          this.gpuCount = 0;
        }
        return false;
      default: {
        this.stats.push(frame.frameMs);
        if (frame.gpuMs !== null) {
          this.gpuSum += frame.gpuMs;
          this.gpuCount++;
        }
        if (elapsedS < this.timing.measureS) return false;
        const summary = this.stats.summary();
        if (summary) {
          this.results.push({
            ...summary,
            preset: wanted,
            gpuMs: this.gpuCount > 0 ? this.gpuSum / this.gpuCount : null,
            width: frame.width,
            height: frame.height,
          });
        }
        this.index++;
        this.phase = 'switching';
        return true;
      }
    }
  }
}
