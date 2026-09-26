import { GpuInitError, describeError } from '../core/gpu';
import { ShaderCompilationError } from '../core/shader';

/**
 * Full-screen error message shown when WebGPU is unavailable, initialisation
 * fails or the GPU device is lost. All user-facing text is Turkish.
 */

export interface ErrorScreenContent {
  readonly title: string;
  readonly message: string;
  readonly hints?: readonly string[];
  /** Technical details (usually English browser/driver messages), collapsed by default. */
  readonly details?: string;
  readonly reloadButton?: boolean;
}

const BROWSER_HINTS: readonly string[] = [
  'Windows üzerinde Google Chrome veya Microsoft Edge’in güncel sürümünü (113 veya üzeri) kullanın.',
  'Tarayıcı ayarlarında “Donanım hızlandırmayı kullan” seçeneğinin açık olduğundan emin olun.',
  'Adres çubuğuna chrome://gpu (Edge’de edge://gpu) yazarak “WebGPU” satırının durumunu kontrol edin.',
];

export function showErrorScreen(content: ErrorScreenContent): void {
  const root = document.getElementById('error-screen');
  if (!root) {
    // Last resort when the page markup itself is broken.
    alert(`${content.title}\n\n${content.message}`);
    return;
  }
  root.replaceChildren();
  const card = document.createElement('div');
  card.className = 'error-card';

  const title = document.createElement('h1');
  title.textContent = content.title;
  card.append(title);

  const message = document.createElement('p');
  message.textContent = content.message;
  card.append(message);

  if (content.hints && content.hints.length > 0) {
    const list = document.createElement('ul');
    for (const hint of content.hints) {
      const item = document.createElement('li');
      item.textContent = hint;
      list.append(item);
    }
    card.append(list);
  }

  if (content.details) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Teknik ayrıntılar';
    const pre = document.createElement('pre');
    pre.textContent = content.details;
    details.append(summary, pre);
    card.append(details);
  }

  if (content.reloadButton) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Sayfayı yeniden yükle';
    button.addEventListener('click', () => window.location.reload());
    card.append(button);
  }

  root.append(card);
  root.hidden = false;
}

/** Maps an initialisation failure to a Turkish explanation. */
export function describeInitError(error: unknown): ErrorScreenContent {
  if (error instanceof GpuInitError) {
    switch (error.kind) {
      case 'no-webgpu':
        return {
          title: 'WebGPU desteklenmiyor',
          message:
            'Bu tarayıcı WebGPU arayüzünü sunmuyor. Simülatör, grafik ve fizik hesapları için WebGPU gerektirir.',
          hints: BROWSER_HINTS,
          details: error.message,
        };
      case 'no-adapter':
        return {
          title: 'Uygun GPU bulunamadı',
          message:
            'WebGPU mevcut, ancak tarayıcı kullanılabilir bir ekran kartı adaptörü döndürmedi. Ekran kartı sürücüsü engellenmiş veya güncel olmayabilir.',
          hints: [
            'Ekran kartı sürücünüzü üreticinin sitesinden güncelleyin.',
            ...BROWSER_HINTS,
          ],
          details: error.message,
          reloadButton: true,
        };
      case 'device-request-failed':
        return {
          title: 'GPU cihazı oluşturulamadı',
          message: 'Ekran kartı adaptörü bulundu, fakat WebGPU cihazı başlatılamadı.',
          hints: ['Diğer GPU yoğun sekmeleri kapatıp sayfayı yeniden yükleyin.', ...BROWSER_HINTS],
          details: error.message,
          reloadButton: true,
        };
      case 'canvas-context-failed':
        return {
          title: 'Çizim yüzeyi oluşturulamadı',
          message: 'Tarayıcı, tuval (canvas) için WebGPU bağlamı sağlamadı.',
          hints: BROWSER_HINTS,
          details: error.message,
          reloadButton: true,
        };
    }
  }
  if (error instanceof ShaderCompilationError) {
    return {
      title: 'Gölgelendirici derlenemedi',
      message:
        `“${error.moduleLabel}” WGSL gölgelendiricisi bu GPU/tarayıcı üzerinde derlenemedi. ` +
        'Ayrıntılı hata iletileri tarayıcı konsolunda da listelenmiştir.',
      details: error.report,
      reloadButton: true,
    };
  }
  return {
    title: 'Başlatma hatası',
    message: 'Simülatör başlatılırken beklenmeyen bir hata oluştu.',
    details: error instanceof Error && error.stack ? error.stack : describeError(error),
    reloadButton: true,
  };
}

export function describeRuntimeError(error: unknown): ErrorScreenContent {
  return {
    title: 'Beklenmeyen hata',
    message:
      'Simülasyon çalışırken beklenmeyen bir hata oluştu ve durduruldu. ' +
      'Ayrıntılar tarayıcı konsolunda da listelenmiştir.',
    details: error instanceof Error && error.stack ? error.stack : describeError(error),
    reloadButton: true,
  };
}

export function describeDeviceLost(info: GPUDeviceLostInfo): ErrorScreenContent {
  return {
    title: 'GPU bağlantısı kesildi',
    message:
      'Ekran kartı cihazı kaybedildi. Bu genellikle sürücü sıfırlandığında, GPU aşırı yüklendiğinde ' +
      'veya sistem uyku modundan döndüğünde olur. Sayfayı yeniden yükleyerek devam edebilirsiniz; ' +
      'simülasyon, URL parametrelerindeki başlangıç ayarlarıyla yeniden açılır.',
    details: `reason: ${info.reason}\n${info.message}`,
    reloadButton: true,
  };
}
