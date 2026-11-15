# NEON CLUB LIVE — Mimari

YouTube canlı sohbetiyle sürülen, yerelde çalışan gerçek zamanlı 3D gece kulübü simülasyonu.

## Genel bakış

```
YouTube Live Chat ──► server/youtube (streamList gRPC ► list polling yedeği)
                         │  ham mesajlar (id, snippet, authorDetails)
                         ▼
                 server/core/ChatRouter ── tekilleştirme (mesaj id, SQLite)
                         │                 moderasyon (spam / küfür / isim filtresi)
                         │                 komut ayrıştırma (TR + EN), bekleme süreleri
                         ▼
                 server/core/ClubState ── yetkili durum: üyeler, oylamalar,
                         │                 etkinlikler, efekt kuyruğu, ayarlar
                         ▼  WebSocket (/ws)
        ┌────────────────┴─────────────────┐
        ▼                                  ▼
  /live (yayın görüntüsü)            /admin (yönetim paneli)
  Three.js sahne + overlay           durum, sohbet akışı, ayarlar
  yalnızca OKUR, komut gönderemez    yetkili komutlar (admin belirteci)
```

- **Sunucu yetkilidir.** Kimin kulüpte olduğu, VIP/sahne hakkı, oylamalar, Super Chat efekt
  kuyruğu ve ayarlar sunucuda tutulur. `/live` istemcisi yalnızca görselleştirir; konum,
  navigasyon ve animasyon istemcide çözülür (tek yayın istemcisi olduğu için yeterli).
- **Gizli bilgiler yalnızca sunucuda.** API anahtarı / OAuth bilgileri `.env` içinden okunur,
  hiçbir WebSocket mesajına veya istemci paketine girmez.
- **Gerçek / demo ayrımı.** Her olay `source: "youtube" | "demo"` alanı taşır. Demo üreteci
  yalnızca demo modu açıkken çalışır; gerçek yayın bağlıyken demo olayları reddedilir.
  Demo karakterleri isimlerinde ve overlay'de `DEMO` rozetiyle işaretlenir.

## Dizin yapısı

| Yol | İçerik |
| --- | --- |
| `server/` | Node.js + TypeScript (tsx ile çalışır). HTTP (statik + REST), WebSocket, YouTube, SQLite |
| `server/youtube/` | URL→videoId, `videos.list`, `liveChatMessages.streamList` (gRPC), `liveChatMessages.list` (polling), backoff, kota yönetimi |
| `server/core/` | `ChatRouter`, `Moderation`, `Commands`, `ClubState`, `EffectQueue`, `EventManager`, `Demo` |
| `server/db.ts` | `node:sqlite` — üyeler, engelliler, işlenen mesaj kimlikleri, ayarlar, hata kayıtları |
| `shared/` | Sunucu ve istemcinin ortak tipleri ve protokolü |
| `src/live/` | Yayın görüntüsü: motor, kulüp, karakterler, ses, kamera, efektler, overlay |
| `src/admin/` | Yönetim paneli (çerçevesiz TypeScript, TR/EN) |
| `tools/` | Karakter üretim hattı (Python), benchmark ve duman testleri |
| `public/assets/` | Üretilmiş GLB karakterler ve dokular |
| `music/` | Kullanıcının kendi lisanslı MP3/WAV/OGG dosyaları |

## İstemci (/live) alt sistemleri

- **Engine** — WebGL2 renderer, kalite profilleri (low/medium/high/ultra), dinamik çözünürlük,
  post-processing (bloom, ton eşleme, vinyet), performans sayaçları.
- **Club** — prosedürel PBR kulüp: dans pisti, DJ kabini, LED duvarlar (shader), VIP, lounge,
  giriş + kırmızı halı, neon tabela, balkon, hoparlörler, disko topları, lazerler, hareketli
  spotlar, sis, yansıtıcı zemin. Tekrarlanan nesneler `InstancedMesh`.
- **Characters** — MakeHuman (CC0) tabanlı rig'li insan modelleri; kıyafet/saç/aksesuar
  kombinasyonları; LOD0/1/2; karakter başına tek çizim çağrısı (bölge paleti shader'ı).
- **Animation** — telifsiz, kod içinde yazılmış prosedürel hareket kütüphanesi. Her hareket
  "kukla" tanımıdır (pelvis, omurga, el/ayak hedefleri); iki kemikli IK ile çözülüp
  `AnimationClip` olarak pişirilir. Klip zamanı **vuruş** birimindedir; mikser hızı
  BPM/60 olduğundan danslar müziğe kilitlenir. Ayaklar IK ile yere sabitlenir.
- **Navigation** — ızgara tabanlı A*, bölge (pist/VIP/sahne/lounge) başına slot rezervasyonu,
  yerel kaçınma; karakterler iç içe geçmez, ışınlanmaz.
- **Audio** — Web Audio: çalma listesi, crossfade, analizör (bass/mid/treble, spektrum,
  RMS), enerji-akısı beat tespiti, BPM tahmini. Dosya yoksa yerleşik özgün üretken synth.
- **CameraDirector** — 9 çekim türü, 10–25 sn aralık, yumuşak geçiş, çarpışma kontrolü.
- **Effects** — Super Chat efektleri (spot, altın parıltı, konfeti, havai fişek, ışık şovu…),
  sıralı kuyruk sunucuda.
- **Overlay** — HTML/CSS yayın arayüzü, 16:9 ve 9:16.

## Protokol

Tek WebSocket uç noktası `/ws?role=live|admin&token=…`. Mesajlar `shared/protocol.ts`
içinde tiplenmiştir. Sunucu → istemci: `snapshot`, `member:join/leave/update`, `action`,
`effect`, `event`, `vote`, `music`, `settings`, `chat` (yalnızca admin), `log`, `stats`.
İstemci → sunucu: `live:stats`, `live:music` (BPM/parça bilgisi), `admin:*` komutları.

## Performans stratejisi

LOD + animasyon LOD (uzak karakterlerde düşük güncelleme hızı), frustum culling, nesne
havuzu, instancing, sınırlı gerçek zamanlı ışık (ışık hüzmeleri additive mesh), tek gölge
haritası, dinamik çözünürlük. Gerçek FPS yalnızca `tools/benchmark` ve yönetim panelindeki
benchmark ile hedef makinede ölçülür; ölçülmemiş değer iddia edilmez.
