# NEON CLUB LIVE — İlerleme / Progress

## English summary

All seven planned stages are implemented: club scene, rigged characters and animation, music / beat analysis,
camera director and events, YouTube chat, Super Chat effects and admin panel, OBS integration, performance work and
tests. Later additions: Twitch, Kick and (optional, unofficial) TikTok; support policy; balcony and two-level navigation;
GPU-instanced crowd for 1,500+ avatars; door queue with optional supporter priority; phone audio fix.

Verified in the development environment (no GPU, software rendering): unit and integration tests (`npm test`),
production build, headless smoke test with resource-leak check, a 1,500-avatar demo in the browser, and screenshots.
**Not verified:** real YouTube / Twitch / Kick / TikTok connections (only mocked), and FPS on the target GPU – run
`npm run benchmark` on your PC. The Turkish development log follows below.

---

✅ yazıldı ve bu ortamda çalıştırılarak doğrulandı · 🟡 yazıldı, kısmen doğrulandı · ⬜ yapılmadı

| Aşama | Kapsam | Durum |
| --- | --- | --- |
| 0 | PROGRESS.md, ARCHITECTURE.md, varlık araştırması | ✅ |
| 1 | Altyapı (Vite + TS + Node), Three.js sahnesi, kulüp ortamı | ✅ |
| 2 | Rig'li karakterler, 37 animasyon, IK, navigasyon + slot rezervasyonu | ✅ |
| 3 | Müzik oynatıcı, analiz (bass/mid/treble/spektrum/beat/BPM), ışık senkronu | ✅ (yerel dosya BPM tespiti gerçek müzikle test edilmedi) |
| 4 | Kamera yönetmeni (12 çekim), dinamik etkinlikler (10), oylamalar | ✅ |
| 5 | YouTube canlı sohbet (videos.list, streamList gRPC, list polling) | 🟡 mock testli; gerçek yayına karşı denenemedi |
| 6 | Super Chat sistemi, yönetim paneli (TR/EN) | ✅ (gerçek Super Chat olayı yalnızca mock ile) |
| 7 | OBS, performans, testler, betikler, lisanslar | 🟡 hedef GPU'da benchmark kullanıcı tarafından çalıştırılmalı |

## Doğrulama (bu geliştirme ortamında, GPU yok — SwiftShader yazılım render)

* `npm test` → 27/27 test geçti: komut ayrıştırma (TR/EN), moderasyon, mesaj tekilleştirme, kanal kimliği,
  bekleme süreleri, kapasite, VIP/sahne, Super Chat kuyruğu + tarihî mesaj koruması, demo/canlı ayrımı,
  oylama, duo, engelleme, acil durdurma, URL → video id, REST/gRPC normalizasyon, mock API ile
  `pollingIntervalMillis`, `nextPageToken` devamı, exponential backoff, kota/sohbet kapalı/yayın bitti durumları,
  navigasyon (300+ slot, tüm slotlara erişim, basamak/engel kontrolü, 0.9 m slot aralığı).
* `npm run smoke` (50 ve 100 karakter) → geçti: tüm karakterler kapıdan girip dans ediyor, ayrılınca kapıdan
  çıkıyor; Super Chat, etkinlik değişimi, oylama, bağlantı kopma simülasyonu, kalite değişimi hatasız;
  iki boş-kulüp anında GPU kaynakları aynı (195 geometri / 31 doku) → sızıntı yok.
* `npm run build` → üretim derlemesi başarılı; `npm start` üretim sunucusu ile smoke testi çalıştı.
* Ekran görüntüleriyle kontrol edilen: geniş açı, DJ yakın çekim, kullanıcı yakın çekim, yörünge, balkon,
  Rooftop/Retro/Techno etkinlikleri, Super Chat efektleri, 1080×1920 dikey yerleşim, yönetim paneli.

**FPS iddiası yok.** SwiftShader (CPU) ile ölçülen 1–15 FPS hedef bilgisayar hakkında bilgi vermez.
Hedef PC'de: `/live` OBS'de açıkken panel → *Benchmark çalıştır* veya `npm run benchmark -- 100 high`.

## Ek: Twitch, Kick, TikTok (çok platform)

* Twitch: resmi EventSub WebSocket, cihaz kodu ile giriş, Bits/abonelik/hediye abonelik; `session_reconnect` desteği.
* Kick: resmi Public API; uygulama token'ı ile abonelik, ayrı webhook portu, RSA imza doğrulaması.
* TikTok: resmi API olmadığı için gayri resmi `tiktok-live-connector`; panelden açıkça onaylanmadan çalışmaz.
* Tüm platformlar aynı anda çalışabilir; kimlikler ayrı, ~1 $ altındaki hediyeler efekt üretmez.
* Doğrulama: 10 yeni test (sahte Twitch WebSocket sunucusu, Kick imza/webhook, TikTok seri sayımı, çok platformlu kulüp).
  Gerçek Twitch/Kick/TikTok sunucularına bu ortamdan erişilemedi → 🟡.

## Ek: Destek politikası

* Efekt merdiveni (1 $ → 50 $+), ~1 $ altındaki hediyelerin 2 dk boyunca kişi başı toplanması.
* Geçici VIP (varsayılan 60 dk), destekçinin otomatik katılımı (kapasite dahilinde), kalıcı VIP yalnızca yönetici verirse.
* Hediye yağmurunda toplu teşekkür bandı ve hızlanan kuyruk; panelde Efekti atla / Kuyruğu temizle.
* Ücretli mesajlarda link/@etiket/küfür filtresi; para sıralaması ve "şu kadar gönder" hedefi bilerek yok.
* 8 yeni test (toplam 45) ve ekran görüntüsüyle toplu bant + atlama kontrolü.

## Ek: 1500+ kapasite, balkon, kapı sırası

* Balkon açıldı: merdiven + sahanlık, iki katlı yol bulma (A*, katlar arası geçiş sahanlıkta), ~680 balkon yeri.
* Kapasite 1547 yer (1510 sınır): geniş pist, yoğun kalabalık (kompakt danslar), balkon, VIP, lounge, sahne.
* GPU kalabalığı: LOD3 (~2 bin köşe) + pişirilmiş animasyon dokusu + görünüm dokusu; arketip başına 1 çizim.
  Kameraya yakın 50–220 kişi tam karakter (havuzlanmış), kapıdan aynı anda en fazla 40 kişi geçer.
* Kapı sırası: doluyken !katıl sıraya alır; bekleyen bağış yaparsa toplam miktara göre öne geçer; ekranda kart + bildirimler,
  !sıra komutu, panelde öncelik kapatma ve "her N öncelikliden sonra 1 ücretsiz" ayarı.
* Doğrulama: 1500 demo karakter tarayıcıda çalıştı (SwiftShader, FPS anlamsız), 50 test, duman testi (havuz sınırlı, kaynak artışı duruyor).
  Hedef GPU'da 1500 kişilik FPS ölçülmedi → benchmark: `npm run benchmark -- 1500 high`.

## Bilinen sınırlamalar / yapılacaklar

* Karakter kıyafetleri ve saçları prosedürel (CC0 taban mesh'in yardımcı geometrisinden); MakeHuman'ın
  dokulu kıyafet/saç paketine bu ortamdan erişilemedi. Daha gerçekçi görünüm için CC0/CC-BY lisanslı,
  aynı `game_engine` iskeletine uyan kıyafet modelleri eklenebilir (ASSET_LICENSES.md'ye yazılarak).
* Cilt/yüz dokusu yok (renk + dudak/kaş/sakal maskesi). Yüz morph'ları ile 8 vücut tipi × renk/kıyafet
  kombinasyonları üretiliyor.
* Profil fotoğrafı yalnızca Google görsel sunucularından (ggpht / googleusercontent) proxy'leniyor.
* `streamList` gRPC yolu gerçek YouTube'a karşı denenemedi (ortamda ağ/anahtar yok); hata verirse otomatik
  olarak polling'e geçiyor.
* KTX2 / doku atlası kullanılmıyor (mevcut varlıklar tek 1024² maske + prosedürel dokular kullanıyor).
* VRAM kullanımı tarayıcı tarafından açığa çıkarılmadığı için kaynak sayısı olarak raporlanıyor.

## Günlük

### Aşama 0
- Depo boştu; sıfırdan başlandı. Erişilebilen ve lisansı net tek gerçekçi insan kaynağı MakeHuman/MPFB2 (CC0).

### Aşama 1
- Vite + TypeScript + Node sunucu; kulüp: LED duvar (shader, 7 desen), LED dans pisti, DJ kabini, VIP, lounge,
  bar, giriş + kırmızı halı, neon tabelalar, balkon + cam korkuluk, hoparlörler, disko topları + yansıyan
  ışık lekeleri, lazerler, hareketli spotlar, sis, parlak zemin, bloom/ton eşleme/vinyet, kalite profilleri.

### Aşama 2
- `tools/build_characters.py`: 8 arketip (4 kadın, 4 erkek, farklı ten/vücut/yüz), 3 LOD, 46 giyilebilir parça.
- IK tabanlı prosedürel animasyon: 22 dans + 2 grup koreografisi + duo + yürüme/koşma/oturma/jestler + 3 DJ hareketi.
- A* navigasyon (merdiven yükseklik kontrolü), slot/koltuk rezervasyonu, yerel kaçınma, takılma kurtarma.
- Hata düzeltmeleri: bloom'a yayılan NaN (sıfır normaller) → normaller düzeltildi + koruyucu geçiş;
  A* Float32 yuvarlama hatası; mobilya arasında kalan koltuklar otomatik eleniyor.

### Aşama 3–4
- Web Audio oynatıcı + crossfade + analiz; yerleşik özgün synth (9 tür); ışıklar/LED/lazer vuruşa bağlı.
- Kamera yönetmeni (geçişlerde kısa karartma, çarpışma kısıtları), 10 etkinlik + sohbet oylaması.

### Aşama 5–6
- YouTube bağlayıcı (gRPC streamList + polling yedeği, backoff, kota, token kalıcılığı), SQLite.
- Super Chat efekt kuyruğu, TR/EN yönetim paneli, demo sürücüsü.

### Aşama 7
- Benchmark (gerçek ölçüm), smoke testi, setup.bat / start.bat / live-window.bat / setup.sh, OAuth yardımcı betiği,
  README (OBS + ses yakalama), ASSET_LICENSES.md, LICENSE.
