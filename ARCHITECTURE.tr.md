# NEON CLUB LIVE – Mimari

[English](ARCHITECTURE.md) · **Türkçe**

Canlı yayın sohbetleriyle (YouTube, Twitch, Kick, TikTok) yönetilen, yerelde çalışan gerçek zamanlı 3D gece kulübü.

## Genel bakış

```
YouTube  ── server/youtube   (videos.list → streamList gRPC, yedek: liveChatMessages.list sorgulama)
Twitch   ── server/platforms/twitch.ts  (EventSub WebSocket, cihaz koduyla giriş)
Kick     ── server/platforms/kick.ts    (ayrı porttan resmi webhook, RSA imza kontrolü)
TikTok   ── server/platforms/tiktok.ts  (isteğe bağlı, gayri resmi kütüphane, onayla açılır)
              │  ortak ChatEvent { id, source, author, kind, text, amountText, tier, usd }
              ▼
        server/core/club.ts  (ClubState – tek doğruluk kaynağı)
              tekilleştirme (SQLite) · moderasyon · komutlar (TR + EN) · bekleme süreleri
              üyeler · kapı sırası · oylamalar · etkinlikler · destek efekti kuyruğu · ayarlar
              ▼  WebSocket /ws
   ┌──────────┴────────────┐
   ▼                       ▼
 /live (yayın görüntüsü)   /admin (yönetim paneli)
 Three.js sahne + arayüz   durum, sohbet, ayarlar, demo/testler
 sadece istatistik yollar  ADMIN_TOKEN ile korunur
```

* **Sunucu yetkilidir.** Kimin içeride olduğu, VIP / sahne hakları, oylamalar, kapı sırası, efekt kuyruğu ve tüm ayarlar
  sunucuda tutulur. `/live` bunları sadece görselleştirir; yürüme, animasyon ve kamera tarayıcıda çözülür.
* **Gizli bilgiler sunucuda kalır.** API anahtarları ve OAuth token'ları `.env`'den (Twitch token'ları yerel SQLite
  veritabanından) okunur; WebSocket'ten gönderilmez, kayıtlara yazılmaz.
* **Gerçek ve demo ayrımı.** Her olayda `source: youtube | twitch | kick | tiktok | demo` vardır. Demo olayları yalnızca demo
  modunda, gerçek olaylar yalnızca canlı modda kabul edilir; mod değişince diğer türdekiler çıkarılır. Demo karakterlerinde
  DEMO rozeti bulunur.

## Klasörler

| Yol | İçerik |
| --- | --- |
| `server/index.ts` | HTTP (statik dosyalar, müzik, profil resmi vekili), WebSocket, panel komutları, mod yönetimi |
| `server/core/` | `club.ts` (durum, komutlar, sıra, efektler), `commands.ts`, `moderation.ts`, `demo.ts` |
| `server/youtube/` | URL → video kimliği, `videos.list`, `streamList` (gRPC), `list` sorgulama, yeniden deneme, kota |
| `server/platforms/` | Twitch, Kick, TikTok bağlayıcıları + ortak seviye dönüşümü |
| `server/db.ts` | `node:sqlite`: üyeler, engellenenler, işlenmiş mesaj kimlikleri, ayarlar, kayıtlar |
| `shared/` | Sunucu ve tarayıcının ortak protokol tipleri ve etkinlik tanımları |
| `src/live/` | Yayın görüntüsü: motor, kulüp, karakterler, ses, kamera, efektler, arayüz |
| `src/admin/` | Yönetim paneli (saf TypeScript, TR / EN) |
| `src/viewer/` | Karakter / animasyon test sayfası |
| `tools/` | Karakter üretim hattı (Python), duman testi, benchmark, OAuth yardımcısı, komut satırı yönetimi |
| `public/assets/` | Üretilmiş GLB karakterler ve yüz maskesi |
| `tests/` | Vitest birim ve entegrasyon testleri |

## Tarayıcı (`/live`) alt sistemleri

* **Motor** – WebGL 2, kalite ayarları, dinamik çözünürlük, son işleme (temizleme → bloom → vinyet).
* **Kulüp** – prosedürel PBR kulüp: LED pist ve duvarlar (shader), DJ kabini, VIP, lounge, bar, giriş, neon tabelalar,
  merdivenli balkon, hoparlörler, disko topları, lazerler, hareketli spotlar, sis. Tekrarlanan nesneler `InstancedMesh`.
* **Karakterler** – MakeHuman (CC0) tabanlı 8 arketip, 4 LOD; kıyafet / saç / aksesuarlar tek modelin parçaları; bölge
  paleti shader'ı ile karakter başına tek çizim çağrısı.
* **Animasyon** – özgün prosedürel hareket kütüphanesi: her hareket iki kemikli IK ile çözülen bir "kukla" poz fonksiyonu,
  `AnimationClip`'e pişirilir. Klip zamanı **vuruş** cinsindendir; danslar müziğe kilitlenir.
* **Kalabalık** – veriler `Dancer` nesnelerinde; havuzdan alınan detaylı `Character` yalnızca "kahramanlara" (kameraya en
  yakın, yürüyen, hareket yapan, öne çıkarılan) takılır. Diğer herkes **CrowdGPU** ile çizilir: arketip başına animasyon
  matrisleri bir dokuya pişirilir, görünümler ortak bir dokuda saklanır, arketip başına tek toplu çizim.
* **Yol bulma** – iki katlı ızgara (zemin + balkon, merdiven sahanlığında birleşir), A*, geniş (0,9 m) ve sıkışık (0,58 m,
  kompakt danslar) yer rezervasyonu, yerel çarpışma kaçınma, kapı geçiş sınırı.
* **Ses** – crossfade'li Web Audio çalma listesi, analiz (bantlar, spektrum, seviye), vuruş algılama, BPM tahmini,
  dosya yoksa özgün üretken synth.
* **Kamera yönetmeni** – 13 çekim, 10–25 sn, kararmalı geçiş; duvar, balkon döşemesi ve insanlara karşı kısıtlar.
* **Efektler** – havuzlu konfeti ve havai fişek; destek efektleri sunucuda sıraya alınır.
* **Arayüz** – 16:9 ve 9:16 için HTML / CSS katmanı (logo, sayı, şarkı, etkinlik, oylama, kapı sırası, bantlar).

## Protokol

Tek WebSocket uç noktası `/ws?role=live|admin&token=…`; mesaj tipleri `shared/protocol.ts` içinde.
Sunucu → istemciler: `snapshot`, `join`, `leave`, `update`, `action`, `duo`, `effect`, `effectStop`, `event`, `vote`,
`queue`, `queueNotice`, `settings`, `mode`, `notice`, `music`, `camera`, `test`, `emergency`; sadece panele `chat`, `log`,
`status`. Yayın → sunucu: `stats`, `musicInfo`, `clientError`, `bench`. Panel → sunucu: `connect`, `disconnect`, `platform`,
`settings`, `kick`, `block`, `unblock`, `grantVip`, `demo`, `music`, `camera`, `event`, `eventVote`, `effects`, `test`,
`emergency`, `clearLogs`.

## Performans stratejisi

Kahraman / GPU kalabalığı ayrımı, 4 LOD, animasyon LOD'u (uzakta düşük güncelleme, ekran dışında dondurulmuş matrisler),
görüş alanı dışını çizmeme, havuzlanmış karakter ve parçacıklar, toplu çizim, tek gölge düşüren ışık, hüzmeler için
eklemeli modeller, dinamik çözünürlük, uzun yayınlar için sınırlı kuyruk ve önbellekler. Gerçek FPS yalnızca hedef
bilgisayarda yerleşik benchmark ile ölçülür.
