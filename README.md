# WebGPU Açık Deniz Gemi Simülatörü

Tarayıcıda çalışan, ham WebGPU + WGSL ile yazılmış bir açık deniz gemi
simülatörü. Hedef: rüzgâra göre fiziksel olarak tutarlı üretilen FFT okyanusu
ve bu dalgalara gerçek kuvvetlerle tepki veren 6 serbestlik dereceli bir gemi.

> **Durum:** Faz 0 (iskelet) tamamlandı. Okyanus, gemi ve fizik sonraki
> fazlarda eklenecek; ayrıntılı yol haritası için [docs/PLAN.md](docs/PLAN.md).

## Gereksinimler

- Node.js 20.19+ (22 önerilir)
- WebGPU destekli tarayıcı: Windows'ta güncel **Google Chrome** veya
  **Microsoft Edge** (113+). WebGPU yoksa ya da GPU adaptörü alınamazsa sayfa
  Türkçe bir hata ekranı gösterir.

## Kurulum ve çalıştırma

```bash
npm install
npm run dev        # geliştirme sunucusu (http://localhost:5173)
npm run build      # üretim derlemesi → dist/
npm run preview    # derlemeyi yerelde sunar
npm run typecheck  # TypeScript tip denetimi
npm test           # Vitest birim testleri
```

## Kontroller

| Girdi | İşlev |
|---|---|
| Fare sürükle | Kamerayı hedef etrafında döndür |
| Tekerlek | Yakınlaş / uzaklaş (30–400 m) |
| P | Simülasyonu duraklat / sürdür |
| H | Arayüzü gizle / göster |
| F | Debug katmanı |

Gemi kontrolleri (W/S gaz, A/D dümen, Space dümeni ortala, C kamera modu)
Faz 4'te eklenecek.

## URL parametreleri

Tekrarlanabilir testler için başlangıç ayarları URL'den verilebilir:

```
?wind=6&dir=45&seed=1&quality=high&paused=1
```

| Parametre | Anlamı | Değerler |
|---|---|---|
| `wind` | Rüzgâr şiddeti (Beaufort) | 0–12, ondalıklı olabilir |
| `dir` | Rüzgârın **geldiği** yön, kuzeyden saat yönünde | derece, [0, 360) aralığına sarılır |
| `seed` | Okyanus gürültüsü tohumu | 0 – 4294967295 tamsayı |
| `quality` | Kalite ön ayarı | `low`, `medium`, `high` |
| `paused` | Duraklatılmış başla | `1`/`0`, `true`/`false` |

Geçersiz değerler varsayılana döner ve konsola uyarı yazılır. Faz 0'da yalnızca
`paused` etkilidir; `wind`, `dir`, `seed` ve `quality` ayrıştırılır, debug
katmanında görünür ve Faz 1'den itibaren okyanusu yönetir.

## Mimari özet

```
src/
  main.ts            giriş: URL parametreleri, GPU başlatma, hata ekranı
  app.ts             alt sistemlerin sahibi; kare akışı:
                     girdi → sabit adımlı simülasyon → kamera → GPU geçişleri → arayüz
  settings.ts        panel ile sistemler arasında paylaşılan ayarlar
  core/              gpu, shader (WGSL birleştirme + hata raporu), loop (120 Hz),
                     time, cameraRelative, canvasSize, readback, gpuTimer, urlParams
  render/            camera (reversed-Z), frameUniforms, renderTargets,
                     tonemapPass (ACES/AgX), gridPass (debug ızgarası)
  sky/               skyModel (güneş konumu/ışınımı), skyPass
  camera/            orbitCamera
  input/             klavye/fare durumu
  ui/                panel (lil-gui), hud, debugOverlay, errorScreen
  shaders/           *.wgsl (Vite ?raw ile içe aktarılır)
tests/               Vitest birim testleri
docs/PLAN.md         faz planı ve dosya listesi
```

**Kare akışı:** Simülasyon, ekran yenileme hızından bağımsız olarak 120 Hz sabit
adımla ilerler (accumulator; kare başına en fazla 12 adım, fazlası atılır).
Sahne, `rgba16float` HDR hedefe ve `depth32float` reversed-Z derinliğe çizilir
(önce opak geometri, en son gökyüzü uzak düzlemde `greater-equal` ile). Ton
eşleme geçişi pozlama, ACES/AgX, sRGB kodlama ve üçgen dağılımlı dither
uygulayıp sonucu ekrana yazar.

**Hassasiyet:** Dünya konumları CPU'da `double` tutulur; GPU'ya kameraya göreli
float32 gönderilir ve view matrisi yalnızca rotasyon içerir. Periyodik desenler
için kamera konumu CPU'da `double` ile periyoda göre sarılır, böylece başlangıç
noktasından binlerce kilometre uzakta da titreme olmaz.

**Hata yönetimi:** WebGPU yok / adaptör yok / cihaz oluşturulamadı / cihaz
kaybedildi durumlarında Türkçe açıklama ve öneriler gösterilir. WGSL derleme
iletileri (`getCompilationInfo`) kaynak dosya adı, satır ve işaretçiyle konsola
yazılır; yakalanmamış GPU hataları (`uncapturederror`) konsolu boğmayacak
şekilde sınırlanarak raporlanır.

**Ölçüm:** HUD'da FPS, CPU kare süresi ve (`timestamp-query` destekleniyorsa)
GPU süresi gösterilir. GPU zamanları staging buffer halkası ve `mapAsync` ile
asenkron okunur; render döngüsü hiçbir zaman GPU'yu beklemez.

## Koordinatlar ve birimler

- SI birimleri (m, s, kg, N).
- Y yukarı, sağ el koordinat sistemi; deniz seviyesi y = 0.
- **+X doğu, −Z kuzey** (dolayısıyla +Z güney). Pusula açıları kuzeyden saat
  yönünde ölçülür.

## Varsayımlar

- **Rüzgâr yönü**, denizcilikteki meteorolojik kurala göre rüzgârın *geldiği*
  yöndür (ör. 45° = kuzeydoğudan esen rüzgâr); dalgalar bunun tersine, rüzgârın
  gittiği yöne ilerler.
- **Faz 0 gökyüzü** analitik bir gradyandır: doğrudan güneş ışığı gerçek hava
  kütlesi formülü (Kasten & Young 1989) ve yaklaşık açık hava optik
  derinlikleriyle zayıflatılır; kubbe renkleri sanatsal anahtar renklerdir.
  Faz 2'de fiziksel tek saçılımlı atmosfer modeliyle değiştirilecek.
- **Işınım birimleri** şimdilik görelidir (öğlen zenit gökyüzü ≈ 1); güneş
  diski/gökyüzü oranı (~2·10⁵) gerçek dünyadaki büyüklük mertebesiyle uyumlu
  seçildi, böylece doğrudan/dağınık ışınım oranı açık bir günde olduğu gibi
  ~4:1 çıkar.
- **Kamera uzak düzlemi** 100 km (400 m yükseklikten geometrik ufuk ~71 km).
- **Piksel oranı** varsayılan olarak 2 ile sınırlıdır (panelden ayarlanabilir).

## Bilinen sınırlamalar

- Faz 0 yalnızca iskelettir: okyanus, gemi, fizik ve rüzgâr etkileri yok.
- Headless (ekransız) Chromium + SwiftShader ortamında WebGPU canvas'a sunum
  yapıldığında cihaz kaybediliyor ("A valid external Instance reference no
  longer exists"); bu, uygulamadan bağımsız bir test ortamı kısıtıdır (en basit
  WebGPU sayfasında da oluşur). Otomatik ekran görüntüsü doğrulaması bu yüzden
  canvas bağlamını offscreen dokuya yönlendiren bir test düzeneğiyle yapıldı.
  Gerçek tarayıcıda (Windows Chrome/Edge) bu durum beklenmez.

## Lisans

GPL-3.0 — ayrıntılar için [LICENSE](LICENSE).
