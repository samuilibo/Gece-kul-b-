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

## 3b. Twitch, Kick and TikTok

Every platform can run at the same time as YouTube; all viewers share one club. Identities stay separate
(`tw:`, `kick:`, `tt:` prefixes), each avatar carries a small platform colour dot, and banners name the platform.
All commands work the same on every platform.

| | Twitch | Kick | TikTok |
| --- | --- | --- | --- |
| API | **official** EventSub WebSocket | **official** Kick Public API (webhooks) | **unofficial** community library |
| Needs | `TWITCH_CLIENT_ID` + login in panel | `KICK_CLIENT_ID/SECRET` + a tunnel | `npm run enable-tiktok` + opt-in tick box (+ optional `TIKTOK_SIGN_API_KEY`) |
| Paid events | Bits, subs, resubs, gift subs | KICKs, subs, renewals, gift subs | gifts (streaks counted once) |

**Twitch.** Create an app at dev.twitch.tv (Client Type *Public*, redirect `http://localhost`), put its id into
`TWITCH_CLIENT_ID`. Panel → *Other platforms* → **Log in with Twitch** shows a code; open the link (works on a
phone), enter the code, approve read-chat access. Enter a channel (empty = your own) and press **Connect**. The
token is kept in the local SQLite database; it refreshes automatically. No public URL needed; reconnects follow
Twitch's `session_reconnect` without losing events.

**Kick.** Kick only delivers events to a public HTTPS webhook. The server opens a separate webhook-only listener
on `KICK_WEBHOOK_PORT` (default 3001) — the admin panel and `/live` are never exposed through it. Example with
Cloudflare Tunnel: `cloudflared tunnel --url http://localhost:3001`, then in kick.com → Settings → Developer → your
app: enable webhooks and set **Webhook URL** to `https://<generated-name>.trycloudflare.com/webhooks/kick`
(a quick tunnel's name changes each time it starts; a named tunnel keeps it). Put the app's client id/secret in
`.env`, enter your channel name in the panel and press **Connect**. The panel shows *waiting* until the first webhook
arrives. Every webhook is verified with Kick's RSA signature; unsigned or forged requests are rejected.

**TikTok.** TikTok has **no official API for LIVE chat**. The connector uses the community library
`tiktok-live-connector`, which relies on the third-party Euler Stream signing service. It is reverse engineered, can
break or be rate-limited at any time, and may conflict with TikTok's terms of service. It stays off until you tick
*“I understand the risks…”* in the panel. No TikTok login or cookies are used. Chat history from before the connection
is not replayed.
The library is **AGPL-3.0** licensed and therefore not bundled: enable it once with `npm run enable-tiktok`
(re-run after `npm ci`/`setup.bat`, since it is installed with `--no-save`). See ASSET_LICENSES.md.

**Paid-event tiers.** To compare platforms, amounts are converted (approximately, only to choose the effect tier)
to YouTube's tier table: 100 Bits ≈ $1, Twitch Tier 1/2/3 sub ≈ $5/$10/$25, 1 KICK ≈ $0.01, Kick sub ≈ $5,
1 TikTok coin ≈ $0.013. Below about $1 (for example a single TikTok rose) nothing happens on stream and the gift is only
logged, so small gifts cannot spam effects. The on-stream banner always shows the original unit (“500 Bits”,
“3× Gift Sub”, “Rose ×5 (5 coins)”). Panel → Super Chat → *Supporters get VIP automatically* can be switched off.

> These three connectors are implemented from the platforms' documentation and covered by tests with mocked
> servers (including Twitch's EventSub WebSocket and Kick's signature check), but they could not be tried against the
> real services from the development environment. Check the panel's status and logs on your first stream.

## 4. Chat commands

| Turkish | English | Effect |
| --- | --- | --- |
| `!katıl` | `!join` | enter the club (one avatar per channel); when it is full: join the door queue |
| `!sıra` | `!queue` | show your place in the door queue on stream |
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

## 4b. Capacity, balcony and the door queue

* Up to **1510 avatars** (panel → *Max characters*). Places: ~270 roomy places on the LED floor (every dance), ~550
  packed places around it and ~680 on the **balcony** (reached by the stairs on the south side), plus VIP, lounge and stage.
  Packed places only use compact dances so neighbours never touch.
* Only the ~50–220 viewers nearest the camera (depending on quality) are full skinned characters with name tags.
  Everyone else is drawn by the **GPU crowd**: their dances are pre-baked into textures and each body type is one
  instanced draw call. Clip timing uses the same beat clock, so switching between the two is invisible.
* At most 40 people walk through the club at the same time; others wait outside the door for a moment.
* **Door queue** when the club is full: `!join` puts you in line (first come, first served). Anyone who donates
  while waiting (any platform) moves ahead of the free queue; supporters are ordered by the **total amount** they
  donated while waiting (approximate value; YouTube uses its own tier table), earlier donors first on a tie. When a
  place frees up the first person in line walks in. On stream a card shows *Club full · N/N*, how many wait, the
  first five (★ = priority, with the amount in the platform's own unit) and how to join; joins, skips and `!queue`
  answers appear as short notices.
* Panel → Super Chat → *Door queue*: switch priority off, or let **one free viewer in after every N priority
  entries** (default 0 = strictly by amount, as requested).
* Please check each platform's rules on rewarding paid messages/gifts with perks before using priority on a
  monetised stream; turning priority off keeps a plain first-come queue.

## 5. Super Chat, gifts, Bits, KICKs, memberships — support policy

Principles: **thank people visibly; paid perks are cosmetic, plus queue priority only when the club is full.**
Free viewers get every command and every area once inside (VIP can also be opened to everyone). Nothing is random, nothing is a bet, there is no public money leaderboard
and no "send X to unlock Y" goal. The door-queue priority (section 4b) is the one exception and can be switched off.

**Effect ladder** (YouTube tiers; other platforms are converted approximately, see 3b). Each step adds to the previous:

| Tier | ≈ value | What happens |
| --- | --- | --- |
| below 1 | < $1 | nothing on stream; small gifts from the same person are **added up for 2 min** and fire once they reach $1 |
| 1 | $1 | thank-you banner (name + amount exactly as the platform reports it) + follow-spot on the avatar |
| 2 | $2 | + thank-you on the giant LED wall behind the DJ |
| 3 | $5 (memberships / subs) | + golden avatar + confetti |
| 4 | $10 | + close-up camera + special dance |
| 5 | $20 | + club-wide light show |
| 6+ | $50+ | + indoor fireworks + 45 s on stage |

**Cosmetic perks:** supporters get **temporary VIP access** (default 60 min, panel setting, 0 = off). Channel
members / subscribers / moderators are VIP while they are in the club. Only VIP granted by you in the panel is permanent.
A supporter who is not in the club yet **walks in automatically** if there is room (never above the character limit,
never for anonymous gifts).

**Fair queue:** effects never overlap. With a backlog every effect runs shorter (min 4 s), and during a gift bomb or
sub train the small ones are merged into one **combo banner** (“Thank you for the support! A, B, C +4”) so nobody
waits minutes for their thank-you. Big ones still get their own moment.

**Safety:** paid messages are shown only after the strictest filter (profanity, links and @mentions removed; can be
switched off entirely). Blocked users trigger nothing. Old or duplicated events never replay. The panel has
**Skip effect**, **Clear queue** and the emergency stop. Demo events are labelled SIMULATION and refused while a real
stream is connected. Gift recipients (gifted subs) get no paid effect — the gifter is thanked.

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
