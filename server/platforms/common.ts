import type { LogItem, PlatformStatus } from '../../shared/protocol.ts';
import type { ChatEvent } from '../core/club.ts';

/**
 * Maps an approximate US-dollar value onto YouTube's 1..11 Super Chat tiers so that effects are comparable
 * across platforms. 0 = below the smallest tier: thanked in the log only, no on-stream effect (avoids
 * effect spam from 1-coin TikTok roses etc.).
 */
export function tierFromUsd(usd: number): number {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 300, 400, 500];
  let t = 0;
  for (let i = 0; i < steps.length; i++) if (usd >= steps[i] - 1e-9) t = i + 1;
  return t;
}

// Approximate conversion rates used ONLY to pick an effect tier. On-stream text always shows the original unit.
export const RATES = {
  bitUsd: 0.01,                                   // 100 Bits ≈ $1
  twitchSubUsd: { '1000': 5, '2000': 10, '3000': 25, prime: 5 } as Record<string, number>,
  kickUsd: 0.01,                                  // 1 KICK ≈ $0.01 (approximation)
  kickSubUsd: 5,
  tiktokCoinUsd: 0.013,                           // 1 coin ≈ $0.013 (varies by region / package)
};

export interface PlatformDeps {
  onEvent: (ev: ChatEvent) => void;
  onStatus: () => void;
  log: (level: LogItem['level'], msg: string) => void;
  kvGet: <T>(key: string, fallback: T) => T;
  kvSet: (key: string, value: unknown) => void;
  setAvatar?: (memberId: string, url: string) => void;
}

export function newStatus(configured: boolean): PlatformStatus {
  return { state: 'disconnected', channel: '', detail: '', messages: 0, retryInMs: 0, configured, auth: null };
}

export const proxied = (url: string | undefined | null) => (url ? `/api/avatar?u=${encodeURIComponent(url)}` : undefined);

/** Hosts whose profile pictures the server may proxy (no open proxy). */
export const AVATAR_HOSTS = /(^|\.)(ggpht\.com|googleusercontent\.com|jtvnw\.net|kick\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|ibyteimg\.com|muscdn\.com)$/;

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});
