// TikTok LIVE chat and gifts.
//
// IMPORTANT: TikTok has no official public API for reading LIVE chat. This connector uses the community
// library "tiktok-live-connector" (reverse engineered, unaffiliated with TikTok/ByteDance), which needs the
// third-party Euler Stream signing service. It may break without notice, may be rate limited, and its use
// may conflict with TikTok's terms. It is therefore OFF until the operator explicitly accepts this in the
// admin panel. No TikTok login or cookies are ever sent.
// The library is licensed AGPL-3.0 and is therefore NOT a dependency of this project; it is installed
// separately by the operator (npm run enable-tiktok) and loaded dynamically.
import type { ChatEvent } from '../core/club.ts';
import { backoffMs } from '../youtube/connector.ts';
import { RATES, newStatus, proxied, sleep, tierFromUsd, type PlatformDeps } from './common.ts';

type Raw = Record<string, any>;

function tUser(u: Raw | undefined) {
  const id = String(u?.userId ?? u?.id ?? u?.idStr ?? '');
  const handle = String(u?.uniqueId ?? u?.displayId ?? '');
  const avatar = u?.profilePicture?.url?.[0] ?? u?.profilePicture?.urls?.[0] ?? u?.avatarThumb?.urlList?.[0] ?? u?.profilePicture?.urlList?.[0];
  return {
    id: `tt:${id || handle}`, name: String(u?.nickname || handle || 'TikTok'), avatar: proxied(avatar),
    isOwner: false, isMod: !!(u?.isModerator ?? u?.userAttr?.isAdmin), isMember: !!(u?.isSubscriber ?? u?.subscribeInfo?.isSubscribe),
  };
}

/** Exported for tests. Returns null for non-final steps of a gift streak so a streak is counted once. */
export function normalizeTikTok(kind: 'chat' | 'gift', e: Raw, seq: string): ChatEvent | null {
  const author = tUser(e.user);
  if (author.id === 'tt:') return null;
  const msgId = String(e.common?.msgId ?? e.msgId ?? e.common?.messageId ?? '');
  if (kind === 'chat') return { id: `tt:${msgId || seq}`, source: 'tiktok', ts: Date.now(), author, kind: 'text', text: String(e.content ?? e.comment ?? '') };
  const giftType = Number(e.gift?.type ?? e.giftDetails?.giftType ?? e.extendedGiftInfo?.type ?? 0);
  const repeatEnd = Number(e.repeatEnd) === 1 || e.repeatEnd === true;
  if (giftType === 1 && !repeatEnd) return null;
  const count = Math.max(1, Number(e.repeatCount) || 1);
  const each = Number(e.gift?.diamondCount ?? e.giftDetails?.diamondCount ?? e.extendedGiftInfo?.diamond_count ?? 0);
  const name = String(e.gift?.name ?? e.giftDetails?.giftName ?? e.extendedGiftInfo?.name ?? 'Gift');
  const coins = each * count;
  return {
    id: `tt:gift:${msgId || `${author.id}:${e.giftId}:${e.groupId ?? ''}:${count}:${seq}`}`, source: 'tiktok', ts: Date.now(), author, kind: 'superchat', text: '',
    amountText: `${name} ×${count}${coins ? ` (${coins.toLocaleString('en-US')} coins)` : ''}`, tier: tierFromUsd(coins * RATES.tiktokCoinUsd), usd: coins * RATES.tiktokCoinUsd,
  };
}

export class TikTokConnector {
  status = newStatus(true);
  private abort: AbortController | null = null;
  private conn: Raw | null = null;
  private seq = 0;

  constructor(private signApiKey: string, private deps: PlatformDeps) {}

  get active() { return this.abort !== null; }
  private set(p: Partial<typeof this.status>) { Object.assign(this.status, p); this.deps.onStatus(); }

  async connect(username: string, accepted: boolean) {
    this.disconnect();
    const user = username.replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '').trim();
    if (!accepted) { this.set({ state: 'error', detail: 'unofficial-not-accepted' }); return false; }
    if (!user) { this.set({ state: 'error', detail: 'username required' }); return false; }
    let mod: Raw;
    // Optional add-on (AGPL-3.0), not shipped with this MIT project: installed by the operator with `npm run enable-tiktok`.
    const pkg = 'tiktok-live-connector';
    try { mod = await import(pkg); } catch { this.set({ state: 'error', detail: 'not installed: run "npm run enable-tiktok"' }); return false; }
    const ac = (this.abort = new AbortController());
    this.set({ state: 'connecting', channel: user, detail: '', messages: 0 });
    void this.run(mod, user, ac);
    return true;
  }

  disconnect() {
    this.abort?.abort();
    this.abort = null;
    void this.conn?.disconnect?.().catch(() => {});
    this.conn = null;
    this.set({ state: 'disconnected', detail: '', retryInMs: 0 });
  }

  private async run(mod: Raw, user: string, ac: AbortController) {
    let attempt = 0;
    while (!ac.signal.aborted) {
      const conn = new mod.TikTokLiveConnection(user, {
        processInitialData: false,          // never replay chat/gifts that happened before connecting
        enableExtendedGiftInfo: false,
        fetchRoomInfoOnConnect: true,
        ...(this.signApiKey ? { signApiKey: this.signApiKey } : {}),
      });
      this.conn = conn;
      const ended = new Promise<string>((resolve) => {
        conn.on(mod.WebcastEvent.CHAT, (e: Raw) => this.emit(normalizeTikTok('chat', e, String(++this.seq))));
        conn.on(mod.WebcastEvent.GIFT, (e: Raw) => this.emit(normalizeTikTok('gift', e, String(++this.seq))));
        conn.on(mod.WebcastEvent.STREAM_END, () => resolve('ended'));
        conn.on(mod.ControlEvent.DISCONNECTED, () => resolve('disconnected'));
      });
      try {
        await conn.connect();
        attempt = 0;
        this.set({ state: 'connected', detail: '', retryInMs: 0 });
        this.deps.log('info', `tiktok: connected to @${user} (unofficial connector)`);
        const why = await Promise.race([ended, new Promise<string>((r) => ac.signal.addEventListener('abort', () => r('abort'), { once: true }))]);
        if (why === 'abort') return;
        if (why === 'ended') { this.set({ state: 'ended', detail: 'stream ended' }); this.abort = null; return; }
      } catch (e) {
        if (ac.signal.aborted) return;
        const offline = (e as Error)?.constructor?.name === 'UserOfflineError' || /offline|not live/i.test(String((e as Error)?.message));
        if (offline) {
          this.set({ state: 'waiting', detail: 'user is not live; retrying every 60 s', retryInMs: 60000 });
          await sleep(60000, ac.signal);
          continue;
        }
        this.deps.log('warn', `tiktok: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
      void conn.disconnect?.().catch(() => {});
      const wait = Math.max(5000, backoffMs(attempt++));
      this.set({ state: 'reconnecting', retryInMs: wait });
      await sleep(wait, ac.signal);
    }
  }

  private emit(ev: ChatEvent | null) {
    if (!ev || !this.active) return;
    this.status.messages++;
    this.deps.onEvent(ev);
  }
}
