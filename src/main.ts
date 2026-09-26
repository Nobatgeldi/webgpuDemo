import './styles.css';
import { App } from './app';
import { GpuErrorReporter, initGpu } from './core/gpu';
import { parseLaunchOptions } from './core/urlParams';
import {
  describeDeviceLost,
  describeInitError,
  describeRuntimeError,
  showErrorScreen,
} from './ui/errorScreen';

function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) {
    throw new Error(`Missing #${id} element in index.html`);
  }
  return element;
}

async function main(): Promise<void> {
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[unhandled rejection]', event.reason);
  });

  const { options: launch, warnings } = parseLaunchOptions(window.location.search);
  for (const warning of warnings) {
    console.warn(`[url] ${warning}`);
  }

  let app: App | null = null;
  let deviceLost = false;
  try {
    const canvas = requireElement('gpu-canvas', HTMLCanvasElement);
    const errorReporter = new GpuErrorReporter();
    const gpu = await initGpu(canvas, {
      onDeviceLost: (info) => {
        console.error(`[WebGPU] device lost (${info.reason}): ${info.message}`);
        deviceLost = true;
        app?.stop();
        showErrorScreen(describeDeviceLost(info));
      },
      onUncapturedError: (error) => errorReporter.report(error),
    });
    app = await App.create({
      gpu,
      elements: {
        canvas,
        hud: requireElement('hud', HTMLElement),
        debugOverlay: requireElement('debug-overlay', HTMLElement),
      },
      launch,
      errorReporter,
      onFatalError: (error) => {
        console.error('[runtime] frame loop stopped:', error);
        showErrorScreen(describeRuntimeError(error));
      },
    });
    // The device may have been lost while pipelines were compiling.
    if (!deviceLost) {
      app.start();
    }
  } catch (error) {
    console.error('[init] failed:', error);
    app?.stop();
    showErrorScreen(describeInitError(error));
  }
}

void main();
