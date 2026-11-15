import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdminStatus, LogItem } from '../../shared/protocol.ts';
import type { ChatEvent } from '../core/club.ts';
import { extractVideoId, normalizeItem } from './normalize.ts';

const API = 'https://www.googleapis.com/youtube/v3';
const PARTS = ['id', 'snippet', 'authorDetails'];
const COST_LIST = 5;       // liveChatMessages.list quota units (YouTube Data API quota table)
const COST_VIDEOS = 1;

export interface YtConfig {
  apiKey: string;
  oauth?: { clientId: string; clientSecret: string; refreshToken: string };
  useGrpc: boolean;
}

export interface YtDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  minPollMs: () => number;
  loadToken: (chatId: string) => string | undefined;
  saveToken: (chatId: string, token: string) => void;
  onEvent: (ev: ChatEvent) => void;
  onStatus: () => void;
  log: (level: LogItem['level'], msg: string) => void;
  grpcFactory?: GrpcFactory;       // injectable for tests
}

type GrpcStream = { on(ev: string, cb: (...a: any[]) => void): void; cancel(): void };
type GrpcFactory = (auth: { key?: string; bearer?: string }) => Promise<{ open(req: Record<string, unknown>): GrpcStream; close(): void }>;

class ApiError extends Error {
  constructor(public status: number, public reason: string, message: string) { super(message); }
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

export function backoffMs(attempt: number, rnd = Math.random()): number {
  const base = Math.min(60000, 1000 * 2 ** Math.min(attempt, 6));
  return Math.round(base / 2 + (base / 2) * rnd);          // "equal jitter"
}

export class YouTubeConnector {
  status: AdminStatus['youtube'];
  private abort: AbortController | null = null;
  private f: typeof fetch;
  private now: () => number;
  private sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private accessToken = '';
  private accessExpires = 0;
  private chatId = '';

  constructor(private cfg: YtConfig, private deps: YtDeps) {
    this.f = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.status = {
      state: 'disconnected', transport: 'none', videoId: '', title: '', detail: '', hasKey: !!cfg.apiKey,
      hasOAuth: !!cfg.oauth?.refreshToken, quotaUsed: 0, messages: 0, viewers: null, retryInMs: 0,
    };
  }

  get connected() { return this.abort !== null; }

  private set(patch: Partial<AdminStatus['youtube']>) { Object.assign(this.status, patch); this.deps.onStatus(); }

  disconnect() {
    this.abort?.abort();
    this.abort = null;
    this.set({ state: 'disconnected', transport: 'none', detail: '', retryInMs: 0 });
  }

  /** Resolves once the first connection attempt has either succeeded or failed terminally. */
  async connect(url: string): Promise<boolean> {
    this.abort?.abort();
    const videoId = extractVideoId(url);
    if (!videoId) { this.set({ state: 'error', detail: 'invalid-url' }); return false; }
    if (!this.cfg.apiKey && !this.cfg.oauth?.refreshToken) { this.set({ state: 'error', detail: 'no-credentials', videoId }); return false; }
    const ac = (this.abort = new AbortController());
    this.set({ state: 'connecting', videoId, title: '', detail: '', transport: 'none', messages: 0 });
    try {
      const info = await this.videoInfo(videoId, ac.signal);
      if (!info) { this.fail('error', 'video-not-found'); return false; }
      this.set({ title: info.title, viewers: info.viewers });
      if (!info.chatId) { this.fail(info.ended ? 'ended' : 'chat_disabled', info.ended ? 'stream-ended' : 'no-active-live-chat'); return false; }
      this.chatId = info.chatId;
    } catch (e) {
      this.handleTerminal(e) || this.fail('error', String((e as Error).message));
      return false;
    }
    void this.run(ac);
    return true;
  }

  private fail(state: AdminStatus['youtube']['state'], detail: string) {
    this.abort?.abort();
    this.abort = null;
    this.set({ state, detail, transport: 'none', retryInMs: 0 });
    this.deps.log(state === 'ended' ? 'info' : 'error', `youtube: ${state} (${detail})`);
  }

  /** Maps API error reasons that must stop the loop. Returns true when handled. */
  private handleTerminal(e: unknown): boolean {
    if (!(e instanceof ApiError)) return false;
    const r = e.reason;
    if (r === 'liveChatEnded') this.fail('ended', r);
    else if (r === 'liveChatDisabled') this.fail('chat_disabled', r);
    else if (r === 'liveChatNotFound' || r === 'videoNotFound') this.fail('error', r);
    else if (r === 'keyInvalid' || r === 'badRequest' && /API key/i.test(e.message) || r === 'accessNotConfigured' || r === 'forbidden' || r === 'authError') this.fail('error', `${r}: ${e.message}`.slice(0, 200));
    else return false;
    return true;
  }

  // ------------------------------------------------------------------ main loop
  private async run(ac: AbortController) {
    const signal = ac.signal;
    let attempt = 0;
    let grpcFailures = 0;
    let useGrpc = this.cfg.useGrpc;
    let token = this.deps.loadToken(this.chatId);
    // Without a stored position the first page is backlog: mark anything older than "now" as
    // historical so that old Super Chats are never replayed.
    let historicalBefore = token ? 0 : this.now() - 5000;
    let lastInfo = this.now();

    const deliver = (items: any[]) => {
      for (const raw of items ?? []) {
        const ev = normalizeItem(raw, historicalBefore);
        if (ev === 'ended') { this.fail('ended', 'chatEndedEvent'); return false; }
        if (ev) { this.status.messages++; this.deps.onEvent(ev); }
      }
      return true;
    };
    const advance = (next?: string) => {
      if (next) { token = next; this.deps.saveToken(this.chatId, next); }
      historicalBefore = 0;
    };

    while (!signal.aborted) {
      try {
        if (useGrpc) {
          this.set({ transport: 'grpc' });
          const more = await this.streamOnce(token, signal, (res) => {
            if (this.status.state !== 'connected') this.set({ state: 'connected', detail: '', retryInMs: 0 });
            attempt = 0; grpcFailures = 0;
            const ok = deliver(res.items);
            advance(res.nextPageToken);
            return ok;
          });
          if (!more) return;
          continue;                      // server closed the stream normally: resume from token
        }
        this.set({ transport: 'polling' });
        const res = await this.listOnce(token, signal);
        if (signal.aborted) return;
        if (this.status.state !== 'connected') this.set({ state: 'connected', detail: '', retryInMs: 0 });
        attempt = 0;
        if (!deliver(res.items)) return;
        advance(res.nextPageToken);
        if (res.offlineAt) { this.fail('ended', 'offlineAt'); return; }
        if (this.now() - lastInfo > 120000) {
          lastInfo = this.now();
          const info = await this.videoInfo(this.status.videoId, signal).catch(() => null);
          if (info) this.set({ viewers: info.viewers });
        }
        const wait = Math.max(Number(res.pollingIntervalMillis) || 0, this.deps.minPollMs());
        await this.sleep(wait, signal);
      } catch (e) {
        if (signal.aborted) return;
        if (this.handleTerminal(e)) return;
        const err = e as ApiError & { code?: number };
        const reason = err.reason ?? '';
        if (reason === 'pageTokenInvalid' || reason === 'invalidPageToken') {
          token = undefined; historicalBefore = this.now() - 5000;
          this.deps.log('warn', 'youtube: page token expired, resuming from live edge');
          continue;
        }
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
          const wait = 15 * 60000;
          this.set({ state: 'quota', detail: reason, retryInMs: wait });
          this.deps.log('error', 'youtube: API quota exhausted; retrying in 15 min');
          await this.sleep(wait, signal);
          continue;
        }
        if (useGrpc) {
          grpcFailures++;
          if (reason === 'grpc-unavailable-module' || err.code === 12 || grpcFailures >= 3) {
            useGrpc = false;
            this.deps.log('warn', `youtube: streamList unavailable (${err.message}); falling back to liveChatMessages.list polling`);
            continue;
          }
        }
        if (err.status === 401 && this.cfg.oauth) this.accessExpires = 0;
        const wait = backoffMs(attempt++);
        this.set({ state: 'reconnecting', detail: `${reason || err.message}`.slice(0, 160), retryInMs: wait });
        this.deps.log('warn', `youtube: ${err.message}; retry #${attempt} in ${wait} ms`);
        await this.sleep(wait, signal);
      }
    }
  }

  // ------------------------------------------------------------------ REST
  private async auth(): Promise<{ key?: string; bearer?: string }> {
    const o = this.cfg.oauth;
    if (!o?.refreshToken) return { key: this.cfg.apiKey };
    if (this.now() < this.accessExpires - 60000) return { bearer: this.accessToken };
    const r = await this.f('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken, grant_type: 'refresh_token' }),
    });
    const j = await r.json() as { access_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) throw new ApiError(401, 'authError', `OAuth refresh failed: ${j.error ?? r.status}`);
    this.accessToken = j.access_token;
    this.accessExpires = this.now() + (j.expires_in ?? 3600) * 1000;
    return { bearer: this.accessToken };
  }

  private async get(path: string, params: Record<string, string | undefined>, cost: number, signal: AbortSignal): Promise<any> {
    const a = await this.auth();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    if (a.key) q.set('key', a.key);
    this.status.quotaUsed += cost;
    let r: Response;
    try {
      r = await this.f(`${API}/${path}?${q}`, { signal, headers: a.bearer ? { authorization: `Bearer ${a.bearer}` } : {} });
    } catch (e) {
      throw new ApiError(0, 'network', `network error: ${(e as Error).message}`);
    }
    const j = await r.json().catch(() => ({})) as any;
    if (!r.ok) {
      const reason = j?.error?.errors?.[0]?.reason ?? (r.status === 403 ? 'forbidden' : r.status >= 500 ? 'backendError' : 'badRequest');
      // never echo the request url: it contains the API key
      throw new ApiError(r.status, reason, `HTTP ${r.status} ${reason}: ${String(j?.error?.message ?? '').replace(/key=[^&\s]+/g, 'key=***')}`);
    }
    return j;
  }

  private async videoInfo(videoId: string, signal: AbortSignal) {
    const j = await this.get('videos', { part: 'snippet,liveStreamingDetails', id: videoId }, COST_VIDEOS, signal);
    const it = j.items?.[0];
    if (!it) return null;
    const d = it.liveStreamingDetails ?? {};
    return {
      title: String(it.snippet?.title ?? ''), chatId: d.activeLiveChatId as string | undefined,
      ended: !!d.actualEndTime, viewers: d.concurrentViewers != null ? Number(d.concurrentViewers) : null,
    };
  }

  private listOnce(token: string | undefined, signal: AbortSignal) {
    return this.get('liveChat/messages', {
      liveChatId: this.chatId, part: PARTS.join(','), maxResults: '200', profileImageSize: '88', pageToken: token,
    }, COST_LIST, signal);
  }

  // ------------------------------------------------------------------ gRPC (liveChatMessages.streamList)
  private streamOnce(token: string | undefined, signal: AbortSignal, onData: (res: any) => boolean): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      void (async () => {
        let client: Awaited<ReturnType<GrpcFactory>>;
        try {
          client = await (this.deps.grpcFactory ?? defaultGrpcFactory)(await this.auth());
        } catch (e) {
          reject(e instanceof ApiError ? e : new ApiError(0, 'grpc-unavailable-module', (e as Error).message));
          return;
        }
        this.status.quotaUsed += COST_LIST;
        const req: Record<string, unknown> = { liveChatId: this.chatId, part: PARTS, maxResults: 200, profileImageSize: 88 };
        if (token) req.pageToken = token;
        const call = client.open(req);
        let settled = false;
        const finish = (fn: () => void) => { if (!settled) { settled = true; signal.removeEventListener('abort', onAbort); client.close(); fn(); } };
        const onAbort = () => { call.cancel(); finish(() => resolve(false)); };
        signal.addEventListener('abort', onAbort, { once: true });
        call.on('data', (res: any) => { if (!onData(res)) { call.cancel(); finish(() => resolve(false)); } });
        call.on('end', () => finish(() => resolve(true)));
        call.on('error', (e: { code?: number; details?: string; message: string }) => {
          if (e.code === 1) { finish(() => resolve(!signal.aborted)); return; }   // CANCELLED
          const d = `${e.details ?? e.message}`;
          const reason = /quota/i.test(d) || e.code === 8 ? 'quotaExceeded'
            : /liveChatEnded|no longer live/i.test(d) ? 'liveChatEnded'
            : /liveChatDisabled|disabled/i.test(d) ? 'liveChatDisabled'
            : e.code === 5 ? 'liveChatNotFound'
            : e.code === 16 || e.code === 7 ? 'forbidden'
            : /page ?token/i.test(d) ? 'pageTokenInvalid' : `grpc-${e.code}`;
          const err = new ApiError(e.code === 16 ? 401 : 0, reason, `gRPC ${e.code}: ${d}`.slice(0, 300)) as ApiError & { code?: number };
          err.code = e.code;
          finish(() => reject(err));
        });
      })();
    });
  }
}

/** Lazily loads @grpc/grpc-js so the app still runs (with polling) if the module is missing. */
const defaultGrpcFactory: GrpcFactory = async (auth) => {
  const grpc = await import('@grpc/grpc-js');
  const loader = await import('@grpc/proto-loader');
  const here = dirname(fileURLToPath(import.meta.url));
  const def = await loader.load(join(here, 'proto', 'stream_list.proto'), { keepCase: false, longs: String, enums: String, defaults: false, oneofs: true });
  const pkg = grpc.loadPackageDefinition(def) as any;
  const Service = pkg.youtube.api.v3.V3DataLiveChatMessageService;
  const client = new Service('youtube.googleapis.com:443', grpc.credentials.createSsl(), {
    'grpc.keepalive_time_ms': 30000, 'grpc.keepalive_timeout_ms': 10000,
  });
  return {
    open(req) {
      const md = new grpc.Metadata();
      if (auth.bearer) md.set('authorization', `Bearer ${auth.bearer}`);
      else if (auth.key) md.set('x-goog-api-key', auth.key);
      return client.StreamList(req, md) as GrpcStream;
    },
    close() { client.close(); },
  };
};
