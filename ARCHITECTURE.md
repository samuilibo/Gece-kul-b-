# NEON CLUB LIVE – Architecture

**English** · [Türkçe](ARCHITECTURE.tr.md)

A locally running, real-time 3D nightclub driven by live-stream chats (YouTube, Twitch, Kick, TikTok).

## Overview

```
YouTube  ── server/youtube   (videos.list → streamList gRPC, fall-back: liveChatMessages.list polling)
Twitch   ── server/platforms/twitch.ts  (EventSub WebSocket, device-code login)
Kick     ── server/platforms/kick.ts    (official webhooks on a separate port, RSA signature check)
TikTok   ── server/platforms/tiktok.ts  (optional, unofficial library, opt-in)
              │  normalised ChatEvent { id, source, author, kind, text, amountText, tier, usd }
              ▼
        server/core/club.ts  (ClubState – the single source of truth)
              de-duplication (SQLite) · moderation · commands (TR + EN) · cooldowns
              members · door queue · votes · events · support-effect queue · settings
              ▼  WebSocket /ws
   ┌──────────┴────────────┐
   ▼                       ▼
 /live (stream output)    /admin (control panel)
 Three.js scene + HUD     status, chat, settings, demo/tests
 reports stats only       authenticated with ADMIN_TOKEN
```

* **The server is authoritative.** Who is inside, VIP / stage rights, votes, the door queue, the effect queue and all
  settings live on the server. `/live` only visualises them; walking, animation and camera work happen in the browser.
* **Secrets stay on the server.** API keys and OAuth tokens are read from `.env` (Twitch tokens from the local SQLite
  database) and never sent over the WebSocket or written to logs.
* **Real vs. demo.** Every event has `source: youtube | twitch | kick | tiktok | demo`. Demo events are accepted only in
  demo mode and real ones only in live mode; switching mode removes the other kind. Demo avatars carry a DEMO badge.

## Directories

| Path | Content |
| --- | --- |
| `server/index.ts` | HTTP (static files, music, avatar proxy), WebSocket, admin commands, mode handling |
| `server/core/` | `club.ts` (state, commands, queue, effects), `commands.ts`, `moderation.ts`, `demo.ts` |
| `server/youtube/` | URL → video id, `videos.list`, `streamList` (gRPC), `list` polling, back-off, quota |
| `server/platforms/` | Twitch, Kick, TikTok connectors + shared tier conversion |
| `server/db.ts` | `node:sqlite`: members, blocked users, processed message ids, settings, logs |
| `shared/` | Protocol types and event definitions shared by server and browser |
| `src/live/` | Stream output: engine, club, characters, audio, camera, effects, HUD |
| `src/admin/` | Admin panel (plain TypeScript, EN / TR) |
| `src/viewer/` | Character / animation test page |
| `tools/` | Character build pipeline (Python), smoke test, benchmark, OAuth helper, CLI admin |
| `public/assets/` | Generated GLB characters and the face mask |
| `tests/` | Vitest unit and integration tests |

## Browser (`/live`) subsystems

* **Engine** – WebGL 2 renderer, quality presets, dynamic resolution, post-processing (sanitise → bloom → vignette).
* **Club** – procedural PBR club: LED floor and walls (shaders), DJ booth, VIP, lounge, bar, entrance, neon signs,
  balcony with stairs, speakers, mirror balls, lasers, moving heads, haze. Repeated props are `InstancedMesh`.
* **Characters** – 8 MakeHuman (CC0) based archetypes with 4 LODs; clothes / hair / accessories as parts of one
  mesh; one draw call per character with a region-palette shader.
* **Animation** – original procedural motion library: each motion is a "puppet" pose function solved with two-bone IK
  and baked into an `AnimationClip`. Clip time is measured in **beats**, so dances lock to the music.
* **Crowd** – `Dancer` objects hold the data; a pooled detailed `Character` is attached only to "heroes" (nearest to
  the camera, moving, gesturing, highlighted). Everyone else goes to **CrowdGPU**: animation matrices baked into a float
  texture per archetype, looks stored in a shared look texture, one instanced draw call per archetype.
* **Navigation** – two-level grid (ground floor + balcony, linked at the stair landing), A*, place reservation with
  roomy (0.9 m) and packed (0.58 m, compact dances) places, local avoidance, door throttle.
* **Audio** – Web Audio playlist with crossfade, analyser (bands, spectrum, level), onset beat detection, BPM estimate,
  original generative synth when no files exist.
* **Camera director** – 13 shots, 10–25 s, fade cuts, constraints against walls, the balcony slab and people.
* **Effects** – pooled confetti and fireworks; supporter effects are queued on the server.
* **HUD** – HTML / CSS overlay for 16:9 and 9:16 (logo, count, song, event, votes, door queue, banners).

## Protocol

One WebSocket endpoint `/ws?role=live|admin&token=…`; messages are typed in `shared/protocol.ts`.
Server → clients: `snapshot`, `join`, `leave`, `update`, `action`, `duo`, `effect`, `effectStop`, `event`, `vote`,
`queue`, `queueNotice`, `settings`, `mode`, `notice`, `music`, `camera`, `test`, `emergency`, and for the admin only
`chat`, `log`, `status`. Live → server: `stats`, `musicInfo`, `clientError`, `bench`. Admin → server: `connect`,
`disconnect`, `platform`, `settings`, `kick`, `block`, `unblock`, `grantVip`, `demo`, `music`, `camera`, `event`,
`eventVote`, `effects`, `test`, `emergency`, `clearLogs`.

## Performance strategy

Hero / GPU-crowd split, 4 LODs, animation LOD (lower update rate far away, frozen matrices off-screen), frustum culling,
pooled characters and particles, instancing, one shadow-casting light, beams as additive meshes, dynamic resolution,
bounded queues and caches for long streams. Real FPS is only measured with the built-in benchmark on the target PC.
