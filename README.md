# NEON CLUB LIVE

Interactive 3D nightclub for YouTube live streams. Viewers type `!katıl` / `!join` in the live chat, get a
unique rigged human avatar that walks in through the door, finds a free spot on the dance floor and dances
in sync with the music. Everything runs locally on your PC (Node.js + a browser view captured by OBS); no paid
AI services are used.

* `/live` — the full-screen stream output (add it to OBS)
* `/admin` — control panel (Turkish / English), never shown on stream

> **Türkçe özet:** `setup.bat` → `.env` içine YouTube API anahtarını yazın → `start.bat` → OBS'ye
> `http://localhost:3000/live` tarayıcı kaynağı ekleyin → yönetim panelinde yayın bağlantısını girip **Bağlan**.
> API anahtarı olmadan denemek için panelde **Demo başlat** düğmelerini kullanın.

---

## 1. Requirements

* Windows 11 (also runs on Linux/macOS for development)
* **Node.js 22.13+** (uses the built-in `node:sqlite`) — https://nodejs.org
* OBS Studio 30+
* Chrome or Edge (for testing / the window-capture alternative)
* Target hardware this was designed for: Intel Arc B580 12 GB, Ryzen 5 5600, 16 GB RAM

## 2. Install and start (Windows)

1. Unzip / clone the project, double-click **`setup.bat`** (installs dependencies, creates `.env`, builds).
2. Edit **`.env`** (see `.env.example`). For a real stream set `YOUTUBE_API_KEY` (or the OAuth values).
3. Put your licensed music into **`music/`** (optional — see `music/README.md`).
4. Double-click **`start.bat`**. It opens the admin panel at `http://localhost:3000/admin`.

Development mode with hot reload: `npm run dev`. Linux/macOS: `./setup.sh && npm start`.

## 3. Connecting to YouTube

1. Google Cloud Console → create a project → *APIs & Services* → enable **YouTube Data API v3**.
2. *Credentials* → **API key** → restrict it to YouTube Data API v3 → put it in `.env` as `YOUTUBE_API_KEY`.
3. Start your stream on YouTube, copy its URL (`youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/live/…` or
   the Studio URL) into the admin panel and press **Connect**.

What the server does (official API only):

* extracts the video id → `videos.list(part=snippet,liveStreamingDetails)` → `activeLiveChatId`
* **`liveChatMessages.streamList`** (gRPC, server streaming, low latency) when `YOUTUBE_USE_GRPC=1`;
  falls back automatically to **`liveChatMessages.list`** polling that waits `max(pollingIntervalMillis, minPollMs)`
* processes `id`, `snippet` and `authorDetails`; identity = **channel id**, never the display name
* de-duplicates every message id in SQLite; stores the `nextPageToken` so a restart resumes where it left off
* messages published before the connection (backlog) are marked historical: **old Super Chats never replay**
* reconnects with exponential backoff + jitter (1 s → 60 s); quota exhaustion waits 15 min;
  `liveChatEnded`, `liveChatDisabled`, `chatEndedEvent`, `offlineAt` stop cleanly and are shown in the panel
* API keys / tokens stay in the server process (`.env`) and are never sent to a browser or written to logs

**Quota:** every `list` call costs ~5 units. With the default daily quota (10 000 units) polling every 3 s
lasts ≈ 1.7 h; raise *Min poll interval* (`minPollMs` in settings) or request more quota for long streams.
`streamList` keeps one long-lived call open instead of polling.

### OAuth (optional)

If Google refuses key-only access for your stream, use OAuth instead:
create an OAuth client of type *Desktop app*, put the client id/secret in `.env`, run `node tools/oauth.mjs`,
open the printed link, approve **read-only** access and paste the printed `YOUTUBE_OAUTH_REFRESH_TOKEN` into `.env`.

> The gRPC `streamList` path is implemented against Google's published interface definition
> (`server/youtube/proto/stream_list.proto`) and covered by unit tests with a mocked transport, but it could not
> be exercised against a real YouTube stream during development. If it fails on your account the server logs a
> warning and switches to polling by itself.

## 4. Chat commands

| Turkish | English | Effect |
| --- | --- | --- |
| `!katıl` | `!join` | enter the club (one avatar per channel) |
| `!dans [tür]` | `!dance [style]` | random dance, or `hiphop`, `shuffle`, `break`, `robot`, `house`, `disco`, `techno`, `trance`, `slow`, `90s`… |
| `!shuffle` `!breakdance` `!robot` | | dance styles |
| `!zıpla` `!selam` `!alkış` | `!jump` `!wave` `!clap` | one-shot gestures |
| `!otur` / `!pist` | `!sit` / `!floor` | sit in the lounge (or VIP) / back to the floor |
| `!kıyafet` `!renk` | `!outfit` `!color` | new outfit / new colours (remembered per channel) |
| `!vip` | `!vip` | VIP area — channel members, moderators, supporters or users granted in the panel |
| `!sahne` | `!stage` | dance on stage for 45 s (4 places) |
| `!kamera` | `!camera` | close-up of your avatar (global cooldown) |
| `!müzik <tür>` | `!song <genre>` | vote for the next genre |
| `!etkinlik <no>` | `!event <no>` | vote for the next event while a vote is open |
| `!duo <isim>` / `!kabul` | `!duo <name>` / `!accept` | invite someone to a couple dance |
| `!çık` | `!leave` | leave the club |
| `!yardım` | `!help` | show the command list on stream |

Every command has a per-user cooldown and an on/off switch in the panel. Spam (repeats, floods → 60 s mute),
profanity in commands and inappropriate display names (replaced by `MisafirNNNN`) are filtered; add your own
words with `BAD_WORDS` in `.env`. Blocked channels are stored in SQLite.

## 5. Super Chat / Super Sticker / memberships

Real events from the API trigger **cosmetic** effects only — spotlight, golden avatar, DJ-screen thank-you,
confetti, indoor fireworks, special camera, stage time, light show, special dance — chosen by YouTube's tier
and configurable per effect in the panel. The on-stream banner shows the supporter name and the amount
**exactly as YouTube formats it** (original currency). Effects are queued, never overlap, and never replay.
Free viewers get the complete experience; there is no gambling, no paid random rewards and no fake activity.

Demo-mode events are generated only while demo mode is on, are labelled **SİMÜLASYON / SIMULATION** on stream,
use `demo:` ids, and are rejected by the server whenever a real stream is connected.

## 6. Music

`music/` (sub-folders = genres) — MP3, WAV, OGG. Playlist, shuffle, repeat, volume, crossfade, next/previous and
genre selection are in the panel. When a genre has no files, an **original built-in generative synthesiser**
plays it (EDM, Techno, Deep House, Progressive, Trance, Hip-hop, Disco, Synthwave, Turkish electronic with the
Hicaz scale). Web Audio analysis provides bass / mid / treble, a 64-band spectrum, level, onset-based beat
detection and BPM estimation; with built-in tracks the beat clock is sample-exact. Dances are locked to the
beat clock; LEDs, lasers, moving heads, speaker cones and the floor react to the kick. Use the panel's
*BPM* field to force a tempo for a file whose BPM is mis-detected, and **Tests → sync** to hear a metronome on
the detected grid.

**Only use music you have the rights to stream and monetise.** Do not grab audio from Spotify/YouTube.

## 7. OBS

### Browser Source (recommended)

1. *Sources → + → Browser*. URL `http://localhost:3000/live`, width **1920**, height **1080**
   (vertical: `http://localhost:3000/live?layout=portrait`, 1080 × 1920).
2. Tick **Control audio via OBS** — the club audio then appears as its own mixer channel.
3. Leave *Custom frame rate* off or set it to 60; *Shutdown source when not visible* off.
4. OBS → *Settings → Advanced → Sources* → keep **Enable Browser Source Hardware Acceleration** on.
5. *Settings → Video*: Base/Output 1920×1080, 60 FPS (or 30). Encoder: Intel **QuickSync AV1/H.264** on Arc.

The live page has no cursor, no buttons and no developer tools. If the audio badge “click to start audio”
appears in a normal browser tab, that is the browser's autoplay policy; OBS does not need it.

### Alternative: Chromium window capture

If the browser source has GPU-acceleration problems, run **`live-window.bat`** (or
`live-window.bat portrait`). It opens Edge/Chrome in a frameless app window with autoplay and background
throttling disabled. In OBS add **Window Capture** (method *Windows 10 (1903 and up)*) for that window and
**Application Audio Capture** for the browser process (or *Desktop Audio*). Keep the window un-minimised.

### Audio checklist

* Browser Source: *Control audio via OBS* on → one “Browser” mixer channel; set the stream mix with it.
* Window capture: Application Audio Capture (Windows 11) on the browser → no other desktop sounds leak in.
* Do **not** also capture Desktop Audio for the same signal (double audio / echo).

## 8. Performance

Quality presets **low / medium / high / ultra** (panel → Graphics) change render scale, MSAA, shadows, real
spotlights, beams, lasers, fog sprites, LOD distances and animation update rate. Implemented:

* 3 LODs per character (≈55k / 33k / 10k triangles), LOD distances scaled down above 150 avatars
* animation LOD: full rate near, 20–30 Hz mid, 10–30 Hz far, 5 Hz off-screen (matrices frozen in between)
* frustum culling, nearest-N name tags only, one draw call per character (region-palette shader)
* shared vertex buffers per archetype, reference-counted index buffers, pooled particles, `InstancedMesh`
  for all repeated club props, lasers, disco flecks and contact shadows
* dynamic render resolution with hysteresis, one shadow-casting light, beams are additive meshes
* NaN/overflow-safe bloom chain, explicit disposal of everything an avatar owns

**Measure, don't guess:** open `/live` in OBS or Edge on the target PC, then panel → *Run benchmark*
(or `npm run benchmark -- 100 high`). It fixes the resolution, cycles five shots for 6 s each and reports
average FPS, 5 % / 1 % lows, draw calls and triangles; results are stored under `bench-results/`.
No FPS numbers are claimed in this repository: development happened on a machine without a GPU, where the
software renderer cannot say anything about an Arc B580.

Not implemented (documented honestly): KTX2 texture compression and a texture atlas are not needed by the
current assets (characters use one shared 1024² mask and procedural colours, the club uses runtime canvas
textures); GPU memory is reported as resource counts, because browsers do not expose VRAM usage.

## 9. Demo mode and tests

Panel → *Demo & tests*: 10 / 50 / 100 / 300 simulated viewers, extra bots, custom chat line, simulated
Super Chat of any tier, disconnect simulation, 300-avatar load test, light / animation / camera / music-sync
tests, confetti, fireworks, DJ message. All of it is clearly labelled as simulation.

```
npm test            # unit tests: commands, moderation, dedupe, cooldowns, VIP/stage, Super Chat queue,
                    # demo/live separation, YouTube URL parsing, mocked polling/backoff/token resume, navigation
npm run smoke       # headless end-to-end run (demo crowd, effects, events, leak check)
npm run benchmark   # measured FPS on this PC (needs /live open)
/viewer?clip=shuffle_run&n=6   # animation test page
```

## 10. Characters and assets

Characters are generated by `tools/build_characters.py` from the **CC0** MakeHuman/MPFB2 base mesh, morph
targets, `game_engine` skeleton (53 bones) and weights. Clothes, hair, hats and accessories are generated
procedurally; all motions are original code with two-bone IK (planted feet, no sliding). See
**ASSET_LICENSES.md**. To rebuild: clone `https://github.com/makehumancommunity/mpfb2` and run
`python3 tools/build_characters.py --mpfb <path-to-mpfb2>` (needs numpy + pillow).

## 11. Project layout

See **ARCHITECTURE.md**; progress and known limitations are in **PROGRESS.md**.
