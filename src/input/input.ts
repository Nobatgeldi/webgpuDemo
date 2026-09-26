/**
 * Keyboard and mouse state collected from DOM events and consumed once per
 * frame. Keys are identified by `KeyboardEvent.code` (physical position), so
 * WASD works on any keyboard layout, including Turkish Q/F.
 */

/** Pixels of wheel delta treated as one wheel notch (DOM_DELTA_PIXEL mode). */
const WHEEL_PIXELS_PER_NOTCH = 100;
/** Lines of wheel delta treated as one wheel notch (DOM_DELTA_LINE mode). */
const WHEEL_LINES_PER_NOTCH = 3;

export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private dragX = 0;
  private dragY = 0;
  private wheel = 0;
  private dragging = false;
  private activePointer: number | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private lastInteractionMs = Number.NEGATIVE_INFINITY;
  private readonly abort = new AbortController();

  constructor(private readonly surface: HTMLElement) {
    const signal = this.abort.signal;
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });
    window.addEventListener('blur', this.onBlur, { signal });
    surface.addEventListener('pointerdown', this.onPointerDown, { signal });
    surface.addEventListener('pointermove', this.onPointerMove, { signal });
    surface.addEventListener('pointerup', this.onPointerUp, { signal });
    surface.addEventListener('pointercancel', this.onPointerUp, { signal });
    surface.addEventListener('wheel', this.onWheel, { signal, passive: false });
    surface.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
  }

  /** True while the key with the given `code` is held. */
  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True if the key was pressed since the previous {@link Input.endFrame}. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Mouse drag since the previous frame (CSS pixels). */
  get dragDeltaX(): number {
    return this.dragX;
  }

  get dragDeltaY(): number {
    return this.dragY;
  }

  /** Wheel movement since the previous frame in notches (positive = towards the user / zoom out). */
  get wheelNotches(): number {
    return this.wheel;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** performance.now() of the last user camera interaction (drag or wheel). */
  get lastCameraInteractionMs(): number {
    return this.lastInteractionMs;
  }

  /** Clears per-frame accumulators. Call at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    this.dragX = 0;
    this.dragY = 0;
    this.wheel = 0;
  }

  dispose(): void {
    this.abort.abort();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isTextEntryTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (!event.repeat) {
      this.pressed.add(event.code);
    }
    this.down.add(event.code);
    if (event.code === 'Space') {
      event.preventDefault(); // Avoid scrolling or activating focused buttons.
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.down.clear();
    this.endDrag();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.activePointer !== null || (event.button !== 0 && event.button !== 2)) {
      return;
    }
    this.activePointer = event.pointerId;
    this.dragging = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.lastInteractionMs = performance.now();
    this.surface.setPointerCapture(event.pointerId);
    this.surface.classList.add('dragging');
    this.surface.focus({ preventScroll: true });
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointer) {
      return;
    }
    this.dragX += event.clientX - this.lastPointerX;
    this.dragY += event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.lastInteractionMs = performance.now();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointer) {
      return;
    }
    if (this.surface.hasPointerCapture(event.pointerId)) {
      this.surface.releasePointerCapture(event.pointerId);
    }
    this.endDrag();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    let notches: number;
    switch (event.deltaMode) {
      case WheelEvent.DOM_DELTA_LINE:
        notches = event.deltaY / WHEEL_LINES_PER_NOTCH;
        break;
      case WheelEvent.DOM_DELTA_PAGE:
        notches = event.deltaY;
        break;
      default:
        notches = event.deltaY / WHEEL_PIXELS_PER_NOTCH;
    }
    this.wheel += notches;
    this.lastInteractionMs = performance.now();
  };

  private endDrag(): void {
    this.dragging = false;
    this.activePointer = null;
    this.surface.classList.remove('dragging');
  }
}

/** Input types that consume typed characters; checkboxes and buttons do not. */
const TEXT_INPUT_TYPES = new Set(['text', 'number', 'search', 'email', 'password', 'url', 'tel']);

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}
