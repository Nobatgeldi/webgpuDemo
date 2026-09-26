# WebGPU Açık Deniz Gemi Simülatörü

Tarayıcıda çalışan, ham WebGPU + WGSL ile yazılmış bir açık deniz gemi
simülatörü. Hedef: rüzgâra göre fiziksel olarak tutarlı üretilen FFT okyanusu
ve bu dalgalara gerçek kuvvetlerle tepki veren 6 serbestlik dereceli bir gemi.

> **Durum:** Faz 0 (iskelet) ve Faz 1 (FFT okyanus çekirdeği) tamamlandı.
> Görsel kalite, gemi ve fizik sonraki fazlarda eklenecek; yol haritası için
> [docs/PLAN.md](docs/PLAN.md).

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

## Cloudflare Workers'a dağıtım

Üretim derlemesi (`dist/`) [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
olarak yüklenir ve her istek önce `worker/index.ts` üzerinden geçer. Worker
yalnızca `GET`/`HEAD` kabul eder ve yanıtlara şu başlıkları ekler
(`worker/headers.ts`):

- **Önbellek:** içerik özetli `/assets/*` dosyaları 1 yıl `immutable`;
  `index.html` ve diğer yollar her yüklemede yeniden doğrulanır, böylece yeni
  dağıtım hemen görünür.
- **Güvenlik:** `Content-Security-Policy` (yalnızca aynı köken; lil-gui'nin
  satır içi stili ve gömülü yazı tipi için gerekli istisnalarla),
  `X-Content-Type-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`,
  `Permissions-Policy`.

```bash
npx wrangler login   # ilk seferde Cloudflare hesabına giriş
npm run cf:dev       # derle + Worker'ı yerelde çalıştır (http://localhost:8787)
npm run deploy       # derle + Cloudflare'e dağıt
```

Worker adı ve ayarları `wrangler.jsonc` içindedir. CI'da dağıtım için
`CLOUDFLARE_API_TOKEN` ve `CLOUDFLARE_ACCOUNT_ID` ortam değişkenleri yeterlidir.

## Kontroller

| Girdi | İşlev |
|---|---|
| Fare sürükle | Kamerayı hedef etrafında döndür |
| Tekerlek | Yakınlaş / uzaklaş (30–400 m) |
| P | Simülasyonu duraklat / sürdür |
| H | Arayüzü gizle / göster |
| F | Debug katmanı |

Ayar panelindeki **Rüzgâr ve deniz** bölümünde Beaufort (0–12) ve m/s (0–40)
kaydırıcıları birbirine senkrondur; rüzgâr yönü, fetch ve dalga keskinliği
(choppiness) de buradan ayarlanır. Gemi kontrolleri (W/S gaz, A/D dümen, Space
dümeni ortala, C kamera modu) Faz 4'te eklenecek.

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

Geçersiz değerler varsayılana döner ve konsola uyarı yazılır. `quality`
FFT çözünürlüğünü (128/256/512), kaskad sayısını (2/3/3) ve ağ çözünürlüğünü
belirler; şimdilik yalnızca URL'den seçilir (panelde Faz 6'da gelecek).
Varsayılan: Bf 5, 225°, fetch 300 km, `medium`.

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
  ocean/             beaufort, spectrumModel (JONSWAP + Donelan-Banner, CPU referansı),
                     windState, fftReference, spectrum/fft/cascades (GPU simülasyonu),
                     oceanMesh (clipmap), oceanPass (çizim), ocean (birleştirici)
  camera/            orbitCamera
  input/             klavye/fare durumu
  ui/                panel (lil-gui), hud, debugOverlay, errorScreen
  shaders/           *.wgsl (Vite ?raw ile içe aktarılır)
tests/               Vitest birim testleri
docs/PLAN.md         faz planı ve dosya listesi
worker/              Cloudflare Worker: statik derlemeyi sunar, yanıt başlıkları
wrangler.jsonc       Worker yapılandırması
```

**Kare akışı:** Simülasyon, ekran yenileme hızından bağımsız olarak 120 Hz sabit
adımla ilerler (accumulator; kare başına en fazla 12 adım, fazlası atılır).
Sahne, `rgba16float` HDR hedefe ve `depth32float` reversed-Z derinliğe çizilir
(önce opak geometri, en son gökyüzü uzak düzlemde `greater-equal` ile). Ton
eşleme geçişi pozlama, ACES/AgX, sRGB kodlama ve üçgen dağılımlı dither
uygulayıp sonucu ekrana yazar.

**Okyanus:** Rüzgâr hızı ve fetch'ten JONSWAP parametreleri (α, ω_p, γ = 3.3)
hesaplanır; spektrum Donelan-Banner yön dağılımıyla dalga sayısı düzlemine
aktarılır. Her kare GPU'da: (yalnızca deniz durumu değiştiyse) başlangıç
spektrumu h0(k), zaman evrimi, sekiz gerçek alanın (yükseklik, yatay yer
değiştirme, eğimler, Jacobian türevleri) A + iB paketlemesiyle dört kompleks
spektruma indirgenmesi, workgroup paylaşımlı belleğinde Stockham FFT (satır +
sütun), `rgba16float` dokulara açma ve mip üretimi. Üç kaskad çakışmayan dalga
sayısı bantlarını taşır. Yüzey, kameraya göre grid'e oturtulmuş eş merkezli
clipmap halkalarıyla çizilir; halka sınırlarında geomorph ve eşleşen mip seçimi
çatlakları önler, en dış halka düz bir eteklikle ufka (80 km) uzanır.

**Doğrulama:** Debug katmanı (F), spektrumdan hesaplanan Hs'yi GPU yükseklik
alanlarından asenkron ölçülen Hs ile karşılaştırır (ör. Bf 8: model 6.53 m,
GPU 6.46 m).

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

### Deniz durumu
- **Beaufort ↔ m/s:** Bf → m/s için WMO bağıntısı v = 0.836·B^1.5 kullanılır
  (her tamsayı Bf için sınıfın ortasına düşer, ör. Bf 6 → 12.3 m/s); m/s → Bf
  için tablo sınırlarının orta noktaları (ör. 0.25, 1.55, 3.35 m/s) esas alınır.
- **Fetch doygunluğu:** JONSWAP'ın α ve ω_p eğrileri γ = 3.3 ile tam gelişmiş
  denizde Pierson-Moskowitz enerjisini ~%50 aşar. Bu yüzden etkin fetch, JONSWAP
  enerjisinin PM enerjisine (Hs = 0.21·U₁₉.₅²/g, U₁₉.₅ = 1.026·U₁₀) eşit olduğu
  boyutsuz fetch'te (χ ≈ 1.2·10⁴) sınırlanır. Sonuç (300 km fetch): Bf 4 → 1.01 m,
  Bf 6 → 3.41 m, Bf 8 → 6.54 m, Bf 10 → 8.8 m, Bf 12 → 11.3 m.
- **Sakin deniz:** U < 0.05 m/s spektrumu sıfırlar (sıfıra bölme yok); Bf 0
  ayna gibi düz bir yüzey verir.
- **Rüzgâra ters dalgalar:** Donelan-Banner dağılımının rüzgâra ters (|θ| > 90°)
  kısmı %5'ine indirilir (±90° çevresinde yumuşak geçişle).
- **Rüzgâr geçişi:** Hız en fazla 1 (m/s)/s, yön en fazla 10°/s değişir; geçiş
  süresince h0 her kare yeniden üretilir. Gauss gürültüsü seed'den bir kez
  üretildiği için dalga deseni sıçramaz.
- **Kaskadlar:** 1000 m / 151.3 m / 23.7 m (tam katı değil). Görev tanımındaki
  250 m örneği Bf 10–12'de tepe dalga boyunu (230–600 m) kapsamadığı için en
  büyük kaskad 1000 m seçildi. Kaskad c + 1, k = 6·2π/L_{c+1}'de devralır; son
  kaskad Nyquist'e kadar gider.
- **Zaman döngüsü:** Dalga frekansları 2π/4096 s'nin katlarına yuvarlanır;
  okyanus 4096 s'de bir birebir tekrar eder, buna karşılık faz saatler sonra da
  float32 ile hassas hesaplanır (frekans hatası < %0.6).
- **Dalga keskinliği:** Varsayılan λ = 0.9; yatay yer değiştirme D = i(k/|k|)h
  olarak tanımlandığından pozitif λ tepeleri sivriltir (Gerstner benzeri).
- **Hs (HUD):** Sürekli spektrumun tamamından (4√m0) hesaplanır.
- **Kamera (geçici):** Su yüksekliği sorgusu Faz 3'te gelene kadar orbit kamera
  deniz seviyesinin en az 1.5 m + 1.2·Hs üstünde tutulur.

### Görüntü

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

- Gemi, fizik ve gemiye rüzgâr etkileri henüz yok (Faz 3–5).
- Okyanus gölgelendirmesi temel düzeydedir: köpük, alt yüzey saçılımı, fiziksel
  atmosfer ve mesafeye bağlı pürüzlülük (uzak parıldamaya karşı) Faz 2'de.
- Dalga yer değiştirmesi en dış clipmap halkasında (~8–10 km) sönümlenir;
  ötesindeki eteklik düzdür (dalgalar yalnızca normal dokularıyla görünür).
- Kalite ön ayarı çalışma anında değiştirilemez (yalnızca URL).
- Performans gerçek donanımda henüz ölçülmedi.
- Headless (ekransız) Chromium + SwiftShader ortamında WebGPU canvas'a sunum
  yapıldığında cihaz kaybediliyor ("A valid external Instance reference no
  longer exists"); bu, uygulamadan bağımsız bir test ortamı kısıtıdır (en basit
  WebGPU sayfasında da oluşur). Otomatik ekran görüntüsü doğrulaması bu yüzden
  canvas bağlamını offscreen dokuya yönlendiren bir test düzeneğiyle yapıldı.
  Gerçek tarayıcıda (Windows Chrome/Edge) bu durum beklenmez.

## Lisans

GPL-3.0 — ayrıntılar için [LICENSE](LICENSE).
