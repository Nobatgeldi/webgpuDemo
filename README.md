# WebGPU Açık Deniz Gemi Simülatörü

Tarayıcıda çalışan, ham WebGPU + WGSL ile yazılmış bir açık deniz gemi
simülatörü. Hedef: rüzgâra göre fiziksel olarak tutarlı üretilen FFT okyanusu
ve bu dalgalara gerçek kuvvetlerle tepki veren 6 serbestlik dereceli bir gemi.

> **Durum:** Faz 0 (iskelet), Faz 1 (FFT okyanus çekirdeği), Faz 2 (görsel
> kalite) ve Faz 3 (su sorgusu, gövde, 6DOF yüzerlik fiziği) tamamlandı.
> Sürüş, kamera modları ve rüzgâr etkileri sonraki fazlarda; yol haritası için
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
| W / S (veya ↑ / ↓) | Gaz kolunu ileri / geri al (kol bırakıldığı yerde kalır; −%50…+%100, sıfırda durur) |
| A / D (veya ← / →) | Dümeni iskeleye / sancağa (emir ±35°, ~20°/s) |
| Boşluk | Dümeni ortala |
| C | Kamera modu: takip → serbest yörünge → köprüüstü |
| Fare sürükle | Kamerayı döndür (köprüüstünde etrafa bak) |
| Tekerlek | Yakınlaş / uzaklaş (30–400 m) |
| P | Simülasyonu duraklat / sürdür |
| H | Arayüzü gizle / göster |
| F | Debug katmanı |

Ayar panelindeki **Rüzgâr ve deniz** bölümünde Beaufort (0–12) ve m/s (0–40)
kaydırıcıları birbirine senkrondur; rüzgâr yönü, fetch ve dalga keskinliği
(choppiness) de buradan ayarlanır. **Kamera** bölümünde mod ve takip kamerasının
son girdiden kaç saniye sonra varsayılan açıya döneceği (varsayılan 3 s)
seçilir.

HUD: gemi yukarı pusula (K/D/G/B; mavi ok rüzgârın *geldiği* yönü gemiye göre
gösterir), gaz kolu çubuğu (sarı = tornistan), dümen göstergesi (üçgen = emir,
sarı çizgi = gerçek dümen açısı), hız (kn), rota, makine (% ve d/dk), dümen,
yalpa/baş-kıç, rüzgâr (Bf, m/s, yön), bağıl rüzgâr, Hs, kamera modu, FPS ve GPU
süresi.

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
  sky/               atmosphereModel (fiziksel atmosfer, CPU referansı), atmosphere
                     (transmittance/sky-view LUT'ları, gökyüzü ışınımı), skyPass
  ship/              shipConfig, hull (parametrik gövde), hydrostatics, rigidBody (6DOF),
                     buoyancy (Kerner üçgen kesme), hydrodynamics (ITTC-1957, dalga
                     direnci, sönüm), propulsion (pervane + dümen), helm (gaz kolu/dümen emri),
                     waterHeightProvider (arayüz + analitik su), waterGrid (GPU su ızgarası),
                     ship, shipMesh/shipRenderer (görsel model), shipSystem (birleştirici)
  ocean/             beaufort, spectrumModel (JONSWAP + Donelan-Banner, CPU referansı),
                     windState, fftReference, spectrum/fft/cascades (GPU simülasyonu),
                     oceanMesh (clipmap), oceanPass (çizim), ocean (birleştirici)
  camera/            shipCamera (takip / serbest yörünge / köprüüstü)
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

**Gökyüzü ve ışık:** Rayleigh + Mie + ozon içeren fiziksel atmosfer (Hillaire
2020 yaklaşımı): bir kez hesaplanan transmittance LUT'u, güneş veya bulut örtüsü
değiştiğinde yeniden hesaplanan sky-view LUT'u ve ondan integre edilen gökyüzü
ışınımı. Doğrudan güneş ışığı aynı modelin CPU kopyasından gelir. Güçlü
rüzgârda (Bf 6 → 10) gökyüzü CIE standart kapalı gökyüzüne dönüşür, doğrudan
güneş zayıflar, pus yoğunlaşır. Otomatik pozlama gökyüzü parlaklığına uyum sağlar.

**Su gölgelendirmesi:** Schlick Fresnel ile gökyüzü yansıması ve su gövdesinden
saçılan ışık; GGX güneş parlaması. Parlamanın genişliği, piksel izdüşümünde
dokuların çözemediği eğim varyansından gelir: Cox-Munk ölçümüne göre toplam
eğim varyansından spektrumun çözülen kısmı çıkarılır (uzakta parıldama olmaz,
güneş yolu doğru genişlikte kalır). Dalga tepelerinden geçen ışık için SSS
yaklaşımı. Köpük: Jacobian eşiğin altına düşünce enjekte edilir, ping-pong
dokuda üstel olarak söner ve dalgalarla birlikte sürüklenir; eşik, köpük
örtüsü Monahan bağıntısını tutacak şekilde spektrumdan kalibre edilir.

**Doğrulama:** Debug katmanı (F), spektrumdan hesaplanan Hs'yi GPU yükseklik
alanlarından asenkron ölçülen Hs ile, GPU'da ölçülen köpük örtüsünü de Monahan
bağıntısıyla karşılaştırır (ör. Bf 8: Hs model 6.53 m / GPU 6.46 m; Bf 10:
köpük %28.9 / Monahan %27.0). Hata ayıklama panelindeki doku görüntüleyici
spektrumu, yer değiştirme ve türev dokularını, köpük/Jacobian'ı ve atmosfer
LUT'larını gösterir; tel kafes görünümü LOD halkalarını renklendirir.

**Gemi fiziği:** 120 Hz sabit adımda yarı-örtük Euler ile 6DOF rijit cisim
(quaternion, gövde eksenlerinde köşegen atalet, Euler denklemleri). Yüzerlik
Kerner yöntemiyle: ~500 üçgenlik kapalı fizik gövdesinin her üçgeni yerel su
yüzeyine göre kesilir, batmış parçalara ρ·g·d·A·n hidrostatik kuvveti
merkezlerinde uygulanır. Hidrodinamik: ITTC-1957 sürtünmesi, panel basınç
sönümü (dalıp çıkma sönüm oranına kalibre edilir) ve yalpa sönümü. Su
yüksekliği tek kaynaktan, GPU okyanusundan gelir: her kare gemiye hizalı
40×16'lık bir ızgara (geminin tahmini konumunda) ve kamera noktası compute
shader ile sorgulanır (x + D(x) = p için 4 sabit nokta iterasyonu), sonuçlar
staging halkasıyla 1–3 kare gecikmeyle okunur; fizik her adımda bu ızgaradan
bilineer ara değerleme yapar. Testlerde aynı fizik analitik su sağlayıcılarıyla
(düz su, sinüs/Gerstner) çalışır.

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
- **Kamera:** Takip modunda kamera geminin rotasını kritik sönümlü bir yayla
  (ω = 1.6 rad/s, ~2 s'de oturur) izler; varsayılan açı kıçın 25° sancak
  omuzluğundan, ufkun 14° üstünden. Kullanıcı sürükledikten sonra ayarlanan
  süre (3 s) geçince açı ω = 1.2 rad/s'lik yayla varsayılana döner; yakınlaştırma
  korunur. Bakış noktasının yüksekliği yumuşatılır (dalıp çıkma kamerayı
  sallamaz) ve geminin yalpa/baş-kıç eğiminin yalnızca %15'i ufka yansır.
  Kamera altındaki su yüzeyinin (GPU sorgusu) en az 1.5 m üstünde ve gövde +
  üst yapının sınır kutusunun 2 m dışında tutulur (kutunun en yakın yüzüne
  itilir). İlk su sorgusu sonucu gelene kadar su yüksekliği 1.2·Hs varsayılır.
  Köprüüstü kamerası ön camların hemen önünde, göz hizasında (güverte + 4.1 m)
  geminin tam yönelimiyle hareket eder; sürüklemeyle ±160°/±60° bakılabilir.

### Gemi
- **Boyutlar:** 50 m × 9 m, draft 2.5 m, 500 t, fribord 2.6 m, GM 1.2 m.
  Gövde kesit üsteli (şekil doluluğu) başlangıçta, dizayn draftında tam 500 t
  deplase edecek şekilde otomatik bulunur (blok katsayısı ≈ 0.43).
- **Ağırlık merkezi:** B'nin düşeyinde, KG = KB + BM − GM (KB 1.64 m, BM 4.24 m
  → KG ≈ 4.7 m omurgadan). Atalet yarıçapları: yalpa 0.38·B (+%20 eklenmiş
  atalet), baş-kıç 0.25·L, dönme 0.26·L. Beklenen yalpa periyodu 6.9 s, dalıp
  çıkma 2.3 s.
- **Sönüm:** Panel basınç sönümü dalıp çıkmada ζ = 0.2 verecek şekilde
  kalibre edilir (gerçekte ışınım sönümü); geminin ileri hızı 0.3–1.5 m/s
  üstünde bu sönümden çıkarılır (seyirde direnç = sürtünme + dalga direnci).
  Ek yalpa sönümü ζ = 0.05 doğrusal + karesel terim (yalpa omurgaları).
  Eklenmiş kütle yalnızca yalpada modellenmiştir.
- **Yanal sönüm:** Panellerin enine (sancak–iskele) hız bileşenine karşı
  sönümü, V gövdenin eğik panel normalleri yerine yatay (geminin enine ekseni)
  doğrultuda uygulanır. Aksi halde dönüşte yanal akışın eğik normallerdeki
  bileşenleri gemiyi içe yatıran sahte bir moment üretiyordu; gerçek gemilerde
  dönüşte dışa yatma görülür.
- **Direnç:** R = ½ρSV²·[(1 + k)·C_F(ITTC-1957) + C_R], k = 0.1; dalga direnci
  katsayısı C_R = 0.0068, Froude 0.15'ten 0.5'e düzgün artar (hızlı deplasman
  teknesinin ana tümseği). 22 kn'da toplam ≈ 250 kN.
- **Pervane:** D = 2.0 m, kıçta (x = −22 m, y = −1.6 m), maks. 900 d/dk,
  devir gaza τ = 4 s birinci derece gecikmeyle uyar. İtki
  T = T0·(n|n|·e − |n|·Va/Vref)·batıklık; n = d/dk ÷ maks., iz payı w = 0.1
  (Va = 0.9·V), tornistanda verim e = 0.6. Bollard itkisi T0 dizayn hızındaki
  direncin 1.7 katıdır; Vref tam gazda dizayn hızında (22 kn) itki = direnç
  olacak şekilde hesaplanır (ölçülen azami hız ≈ 21.9 kn). Pervane diski su
  dışına çıktıkça itki batık oranla orantılı kesilir.
- **Dümen:** 2.8 m², açıklık oranı 1.5, stok x = −24.2 m; ±35°, 5°/s. C_L
  eğimi 2π·AR/(AR + 2), stall 32°'de, sonrasında 90°'de tepe değerin %55'ine
  doğrusal düşüş; profil + indüklenmiş (e = 0.9) + stall sonrası sürükleme.
  Dümene gelen akış yerel su hızına pervane akımının momentum teorisindeki
  hızlanmasının yarısı (propwash payı 0.5) eklenerek bulunur; böylece dururken
  de gaz verince dümen etkilidir. Hücum açısı dümen açısı + yanal akış açısı.
  Sonuç: tam yolda (~22 kn) 35° dümende dönüş çapı ≈ 4.8 L, dışa yatma ≈ 15°.
- **Gaz kolu:** W/S tuşları kolu 0.4/s hızla hareket ettirir; kol ileriden
  tornistana geçerken sıfırda durur (tuş bırakılıp yeniden basılmalı). Dümen
  emri 20°/s hızla değişir; gerçek dümen açısı dümen makinesinin 5°/s hızıyla
  emri izler.
- **Su ızgarası:** Gemi çevresinde 8 m pay, 40 × 16 örnek (~1.7 m aralık); daha
  kısa dalgalar yüzerlikte ortalanır.
- **Güverte kapalıdır:** Fizik ve görsel gövde kapalı olduğundan gövde içinde su
  görünmez; ayrı bir stencil maskesi gerekmedi.

### Görüntü

- **Rüzgâr yönü**, denizcilikteki meteorolojik kurala göre rüzgârın *geldiği*
  yöndür (ör. 45° = kuzeydoğudan esen rüzgâr); dalgalar bunun tersine, rüzgârın
  gittiği yöne ilerler.
- **Atmosfer:** Dünya parametreleri (Rayleigh 5.8/13.6/33.1·10⁻⁶ m⁻¹, H = 8 km;
  Mie 4·10⁻⁶ m⁻¹, H = 1.2 km, g = 0.8; ozon 25 km merkezli). Çoklu saçılım,
  tek saçılım kaynağının %35'i kadar izotropik bir terimle yaklaşık alınır
  (Hillaire'in MS LUT'u yerine). Gözlemci deniz seviyesindedir.
- **Işınım birimleri** görelidir: atmosfer dışında güneş ışınımı ≈ 4 (R/G/B
  3.2/4.0/4.1); güneş diski parlaklığı (~5·10⁴) böylece `rgba16float` aralığında
  kalır. Ekrana eşleme otomatik pozlamayla yapılır (anahtar 0.6; ortalama
  gökyüzü parlaklığı 0.002'nin altına inince gece karanlık kalır).
- **Fırtına gökyüzü:** Bulut örtüsü 12 → 26 m/s rüzgârda 0 → 0.9'a yükselir;
  bulutlar doğrudan güneşin (1 − örtü) kadarını geçirir ve açık gökyüzü küresel
  ışınımının %35'ini dağınık ışık olarak iletir (CIE kapalı gökyüzü dağılımı).
  Panelden kapatılabilir.
- **Köpük:** Yalnızca iki uzun dalga kaskadı köpürür; ömür 4 s (e-katlanma).
  Etkin kırılma payı, Monahan örtüsünün %40'ı olarak alınmış ve kalıcı durumda
  GPU ölçümünün Monahan'ı ±%20 içinde izlemesi için ayarlanmıştır.
- **Kamera uzak düzlemi** 100 km (400 m yükseklikten geometrik ufuk ~71 km).
- **Piksel oranı** varsayılan olarak 2 ile sınırlıdır (panelden ayarlanabilir).

## Bilinen sınırlamalar

- Gemiye rüzgâr kuvveti, dümen suyu izi ve sprey henüz yok (Faz 5).
- Manevra modeli yarı-deneyseldir: gövdenin yanal kaldırma kuvveti (Munk
  momenti, çapraz akış) ayrı olarak modellenmez, panel sönümünden gelir; dönüş
  çapı hedef aralığın (3–5 L) üst kısmında, tek pervane dönme yönü (propeller walk)
  yok.
- Köprüüstü kamerası üst yapının içinden değil ön camın hemen önünden bakar
  (iç mekân modeli yok).
- Hidrodinamik sönüm su parçacığı (yörünge) hızlarını hesaba katmaz; bu yüzden
  dalgalarda geminin yavaş ortalama sürüklenmesi (düzensiz denizde ~0.2 m/s)
  yön olarak fiziksel değildir. Slamming ve yeşil su (güverteye su) etkileri yok.
- Su sorgusu sonuçları 1–3 kare (~50 ms) gecikmelidir; ızgara gemiyi tahmini
  konumunda örnekler, ama dalganın bu süredeki ilerlemesi telafi edilmez.
- Köpük dokusu en büyük kaskadın çözünürlüğündedir; düşük kalitede (128²)
  yakın plandaki köpük lekeleri iri görünür.
- Çok yüksekten bakıldığında en büyük kaskadın 1 km'lik tekrarını kırmak için
  ayrı bir düşük frekanslı modülasyon yoktur (normal kamera mesafelerinde fark
  edilmedi).
- Gece gökyüzü (ay, yıldızlar) ve gerçek bulut geometrisi yoktur.
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
