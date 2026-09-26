# Uygulama Planı

Bu doküman, görev tanımındaki fazların nasıl uygulanacağını ve hangi dosyaların
hangi fazda ekleneceğini özetler. Her faz sonunda `npm run typecheck`,
`npm test` ve `npm run build` hatasız geçmeli; ardından commit atılır ve onay
beklenir.

## Mimari ilkeler

- **Tek doğruluk kaynağı GPU okyanusu.** Fizik, dalga yüksekliğini yalnızca
  `WaterHeightProvider` arayüzünden okur; GPU uygulaması asenkron `WaterQuery`,
  testlerde analitik uygulamalar (düz su, sinüs/Gerstner).
- **Kameraya göreli render.** Dünya konumları CPU'da `double`; GPU'ya
  `(dünya − kamera)` float32 olarak gider, view matrisi yalnızca rotasyon içerir.
  Periyodik desenler (okyanus kaskadları, ızgara) CPU'da `double` ile
  `mod patchSize` alınarak örneklenir.
- **Reversed-Z + depth32float**, uzak düzlem 100 km.
- **Sabit adımlı simülasyon (120 Hz)**, render'dan bağımsız; render döngüsü
  GPU→CPU okuma için asla beklemez (staging buffer halkası + `mapAsync`).
- **Kare başına GPU nesnesi oluşturma yok**: buffer/doku/bind group'lar
  başlangıçta ya da yalnızca yeniden boyutlandırmada oluşturulur.
- **WGSL'de `#include` yok**: ortak parçalar (`frame.wgsl`, `common.wgsl` …)
  `composeWgsl` ile birleştirilir; derleme hataları kaynak parça adı ve satırıyla
  konsola yazılır.

## Dosya listesi (hedef)

Parantez içindeki sayı, dosyanın ekleneceği fazdır.

```
index.html, vite.config.ts, tsconfig.json                  (0)
src/main.ts              giriş, hata ekranı, App başlatma       (0)
src/app.ts               alt sistemlerin sahibi, kare akışı     (0, her fazda genişler)
src/settings.ts          panel ↔ sistemler arası ayarlar        (0+)
src/core/
  gpu.ts                 adaptör/cihaz, özellikler, device.lost, uncapturederror (0)
  shader.ts              WGSL birleştirme + getCompilationInfo raporu           (0)
  loop.ts                120 Hz sabit adım + requestAnimationFrame sürücüsü     (0)
  time.ts                simülasyon saati, FPS/ortalama istatistikleri          (0)
  cameraRelative.ts      double → kameraya göreli float32, periyodik sarma      (0)
  canvasSize.ts          ResizeObserver, piksel oranı üst sınırı                (0)
  readback.ts            staging buffer halkası (mapAsync)                      (0)
  gpuTimer.ts            timestamp-query ile GPU süreleri                       (0)
  urlParams.ts           ?wind=&dir=&seed=&quality=&paused=                     (0)
  random.ts              seed'li PRNG + Box-Muller Gauss                        (1)
  constants.ts           fiziksel sabitler (g; ρ, ν Faz 3'te)                   (1)
src/render/
  renderConfig.ts, camera.ts, frameUniforms.ts, renderTargets.ts             (0)
  tonemapPass.ts         ACES/AgX + sRGB + dither                              (0)
  gridPass.ts            debug referans ızgarası (y = 0)                       (0)
  mipmaps.ts             compute ile mip üretimi (rgba16float)                 (1)
  debugTextureView.ts    FFT/spektrum doku görüntüleyici                       (2)
  debugLines.ts          kuvvet vektörleri, batmış üçgenler                    (3)
src/ocean/
  oceanConfig.ts         kaskad boyutları/bantları, kalite ön ayarları        (1)
  beaufort.ts            Bf ↔ m/s tablosu (doğrulama referansı)                (1)
  spectrumModel.ts       JONSWAP, yön dağılımı, fetch sınırı, Hs (CPU referansı) (1)
  spectrum.ts            GPU h0 üretimi (compute)                              (1)
  fftReference.ts        WGSL FFT'nin TS referansı (testler için)             (1)
  fft.ts                 GPU FFT (workgroup shared memory, Stockham radix-2)  (1)
  cascades.ts            3 kaskad, zaman evrimi, çıktı dokuları, mipmap        (1)
  oceanMesh.ts           kamera merkezli clipmap halkaları, morph, snap        (1)
  oceanPass.ts           okyanus çizimi                                        (1, 2)
  ocean.ts               simülasyon + çizimi birleştiren sınıf                 (1)
  windState.ts           hedef rüzgâra ~1 (m/s)/s ile yaklaşma                 (1)
src/core/bindings.ts     bind group layout girdisi yardımcıları               (1)
  foam.ts                Jacobian köpüğü, ping-pong kalıcı köpük               (2)
  waterQuery.ts          GPU yükseklik sorgusu + WaterHeightProvider (GPU)    (3)
src/sky/
  skyModel.ts, skyPass.ts   F0: analitik gradyan                               (0)
  atmosphere.ts          fiziksel tek saçılım: transmittance + sky-view LUT    (2, skyModel'in yerini alır)
src/ship/
  shipConfig.ts          ~50 m devriye gemisi parametreleri                    (3)
  hull.ts                parametrik gövde formu → fizik mesh'i + görsel mesh    (3)
  waterHeightProvider.ts arayüz + düz/sinüs/Gerstner analitik sağlayıcılar     (3)
  rigidBody.ts           6DOF, quaternion, yarı-örtük Euler                     (3)
  buoyancy.ts            Kerner üçgen kesme, hidrostatik kuvvet               (3)
  hydrodynamics.ts       ITTC-1957 sürtünme, basınç sürüklemesi, yalpa sönümü  (3)
  shipRenderer.ts        gövde + üst yapı çizimi                               (3)
  propulsion.ts          pervane (RPM gecikmesi, itki) + dümen (C_L, stall, propwash) (4)
  wind.ts                bağıl rüzgâr kuvveti ve momenti                       (5)
src/camera/
  orbitCamera.ts         F0 orbit kamera                                        (0)
  thirdPersonCamera.ts   takip / serbest orbit / köprüüstü modları             (4)
src/effects/
  wake.ts                dümen suyu köpük izi (gemi merkezli kayan doku)       (5)
  spray.ts               baş dalgası/sprey compute parçacıkları                (5)
  flag.ts                Verlet kumaş bayrak (bağıl rüzgâr)                    (5)
src/input/input.ts                                                            (0)
src/ui/ panel.ts, hud.ts, debugOverlay.ts, errorScreen.ts                    (0+)
src/shaders/*.wgsl       her geçişin WGSL kaynağı (?raw import)                (0+)
tests/*.test.ts                                                               (0+)
```

## Fazlar

### Faz 0 — İskelet ✅
Vite + TS (strict), WebGPU başlatma, Türkçe hata ekranı, `device.lost`,
`uncapturederror`, WGSL hata raporlama, resize + piksel oranı sınırı, 120 Hz
sabit adımlı döngü, HDR (`rgba16float`) hedef + ACES/AgX ton eşleme + sRGB +
dither, reversed-Z derinlik, orbit kamera, analitik gökyüzü gradyanı, debug
referans ızgarası, lil-gui panel, HUD (FPS, CPU/GPU süresi), debug katmanı,
URL parametre ayrıştırıcı, birim testleri.

### Faz 1 — Okyanus çekirdeği ✅
1. `beaufort.ts` + test (Bf ↔ m/s).
2. `spectrumModel.ts`: JONSWAP (α = 0.076 χ^−0.22, ω_p = 22 (g/U) χ^−0.33,
   γ = 3.3), Donelan-Banner yön dağılımı, rüzgâra ters bileşen bastırma, U → 0
   kararlılığı, **etkin fetch sınırı** ve Hs = 4√m0 (sayısal integral). Test:
   Bf 4/6/8 için Hs tablo değerinin ±%35'i.
3. `random.ts`: sabit seed'li Gauss gürültüsü (bir kez üretilir, GPU'ya
   yüklenir); rüzgâr değişince yalnızca genlikler yeniden hesaplanır.
4. `spectrum.ts` (compute): h0(k) ve h0*(−k); rüzgâr geçişi sürerken her kare.
5. `fft.ts`: satır/sütun FFT, workgroup shared memory, N ≤ 512. Yükseklik,
   Dx, Dz, eğimler ve Jacobian türevleri A + iB paketlemesiyle 4 kompleks
   FFT'ye iner. `fftReference.ts` aynı indeksleme/işaret kuralını izler ve
   naive DFT ile test edilir.
6. `cascades.ts`: 3 kaskad, çakışmayan dalga sayısı bantları; ara hesaplar
   `rgba32float`, örneklenen çıktılar `rgba16float` + kendi mip üretimimiz.
7. `oceanMesh.ts`: kamera merkezli clipmap, halka geçişlerinde morph, grid'e
   snap; en dış halka ufka kadar uzanır.
8. `oceanPass.ts`: temel shading (Fresnel + gökyüzü + güneş), sis.
9. Panel: Beaufort ↔ m/s senkron kaydırıcılar, yön, fetch, choppiness; HUD: Hs.

### Faz 2 — Görsel kalite
Fiziksel atmosfer (Rayleigh + Mie + ozon, Hillaire tarzı LUT'lar), güneş
diski ve ışınımı atmosferden; Schlick Fresnel, GGX güneş parlaması, gökyüzü
yansıması, SSS yaklaşımı, Jacobian köpüğü + kalıcı köpük (ping-pong, üstel
sönüm, rüzgârla kalibre edilen örtü oranı), mesafe/eğim varyansına bağlı
pürüzlülük (LEAN/Toksvig benzeri), sis/atmosferik perspektif, uzakta tiling'i
kırmak için düşük frekanslı modülasyon, FFT/spektrum doku görüntüleyici.

### Faz 3 — Gemi ve yüzerlik
`WaterQuery` (sabit nokta iterasyonu ile x + D(x) = p çözümü, staging halkası),
`WaterHeightProvider`, parametrik gövde, rijit cisim, Kerner üçgen yüzerliği,
sönüm (ITTC-1957, basınç sürüklemesi, yalpa sönümü), fizik testleri (denge
draftı ±%5, sürüklenmeme, 15° yalpanın sönümü), debug görselleştirme.

### Faz 4 — Sürüş ve kamera
Pervane (−%50…+%100 gaz, RPM zaman sabiti, sudan çıkınca itki kesilmesi),
dümen (±35°, ~5°/s, C_L(α) + stall, propwash), klavye kontrolleri,
third-person kamera (kritik sönümlü yaw takibi, hafif yalpa yansıtma, 3 s sonra
varsayılana dönüş, su ve gövde çarpışması), köprüüstü kamerası, tam HUD.

### Faz 5 — Rüzgâr etkileri ve detay
Gemiye bağıl rüzgâr kuvveti (heel + sürüklenme; test: yan rüzgârda rüzgâr
altına yatma), opsiyonel rüzgâr akıntısı (~%3 U10), dümen suyu köpük izi,
baş dalgası/sprey compute parçacıkları, bayrak.

### Faz 6 — Cilalama
Kalite ön ayarları (FFT 128/256/512, kaskad sayısı, LOD halka sayısı),
performans ölçümü ve optimizasyon (hedef: RTX 3060 1440p Yüksek ≥ 60 FPS,
entegre GPU Düşük ≥ 30 FPS), opsiyonel Playwright smoke testi, README.

## Önceden görülen teknik kararlar

- **Kaskad boyutları.** Görev tanımındaki 250 m / 37 m / 5 m bir örnek.
  Bf 10–12'de ve uzun fetch'te tepe dalga boyu 230–800 m'ye çıktığından en büyük
  kaskadın bu boyu kapsaması gerekir; Faz 1'de ~1000 m / ~150 m / ~22 m gibi tam
  katı olmayan boyutlarla başlanıp ölçümle ayarlanacak ve Varsayımlar'a
  yazılacak.
- **Fetch doygunluğu.** JONSWAP'ın α ve ω_p eğrileri γ = 3.3 ile tam gelişmiş
  denizde Pierson-Moskowitz enerjisini ~%50 aşar. Etkin fetch, JONSWAP m0'ı
  PM m0'ına (Hs ≈ 0.21 U²/g) eşitlendiği boyutsuz fetch'te (χ ≈ 1.2·10⁴)
  sınırlanacak; bu, Bf 6 için tablo değerini tutturur.
- **WaterQuery gecikmesi.** Sorgu sonuçları 1–2 kare geç gelir; gemi bu sürede
  ~0.4 m ilerleyebilir. Gövde köşelerini tek tek sorgulamak yerine gemi
  etrafında gemiye hizalı bir örnek ızgarası (öngörülen konumda) sorgulanıp
  fizik adımlarında bilineer ara değerleme yapılacak; pervane, dümen ve kamera
  noktaları ayrıca sorgulanır.
