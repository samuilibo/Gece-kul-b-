import type { ChatEvent } from '../core/club.ts';

/** Accepts watch / youtu.be / live / embed / shorts / studio URLs or a bare 11-char id. */
export function extractVideoId(input: string): string | null {
  const s = (input ?? '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music|gaming)\./, '');
  const ok = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);
  if (host === 'youtu.be') return ok(u.pathname.split('/')[1]);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'studio.youtube.com') {
    if (u.searchParams.get('v')) return ok(u.searchParams.get('v'));
    const m = /^\/(?:live|embed|shorts|v|video|live_chat)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/.exec(u.pathname);
    if (m) return m[1];
    const st = /^\/video\/([A-Za-z0-9_-]{11})\//.exec(u.pathname);
    if (st) return st[1];
  }
  return null;
}

type Raw = Record<string, any>;
const typeKey = (t: unknown) => String(t ?? '').toLowerCase().replace(/_/g, '');

/**
 * Converts a liveChatMessage resource (REST camelCase JSON or gRPC object) into the
 * internal ChatEvent. Returns 'ended' for chatEndedEvent and null for types we ignore.
 */
export function normalizeItem(raw: Raw, historicalBefore: number): ChatEvent | 'ended' | null {
  const sn: Raw = raw.snippet ?? {};
  const au: Raw = raw.authorDetails ?? {};
  const id = String(raw.id ?? '');
  const type = typeKey(sn.type);
  if (type === 'chatendedevent') return 'ended';
  if (!id || !au.channelId) return null;
  const ts = Date.parse(sn.publishedAt ?? '') || Date.now();
  const base = {
    id,
    source: 'youtube' as const,
    ts,
    historical: ts < historicalBefore,
    author: {
      id: String(au.channelId), name: String(au.displayName ?? ''),
      avatar: au.profileImageUrl ? `/api/avatar?u=${encodeURIComponent(String(au.profileImageUrl))}` : undefined,
      isOwner: !!au.isChatOwner, isMod: !!au.isChatModerator, isMember: !!au.isChatSponsor,
    },
  };
  switch (type) {
    case 'textmessageevent':
      return { ...base, kind: 'text', text: String(sn.textMessageDetails?.messageText ?? sn.displayMessage ?? '') };
    case 'superchatevent': {
      const d: Raw = sn.superChatDetails ?? {};
      return { ...base, kind: 'superchat', text: String(d.userComment ?? ''), amountText: String(d.amountDisplayString ?? ''), tier: Number(d.tier) || 1 };
    }
    case 'superstickerevent': {
      const d: Raw = sn.superStickerDetails ?? {};
      return { ...base, kind: 'sticker', text: String(d.superStickerMetadata?.altText ?? ''), amountText: String(d.amountDisplayString ?? ''), tier: Number(d.tier) || 1 };
    }
    case 'newsponsorevent':
      return { ...base, kind: 'member', text: String(sn.newSponsorDetails?.memberLevelName ?? ''), tier: 3 };
    case 'membermilestonechatevent': {
      const d: Raw = sn.memberMilestoneChatDetails ?? {};
      return { ...base, kind: 'milestone', text: String(d.userComment ?? ''), tier: 3 };
    }
    case 'membershipgiftingevent': {
      const d: Raw = sn.membershipGiftingDetails ?? {};
      return { ...base, kind: 'gift', text: `${Number(d.giftMembershipsCount) || 1} × ${String(d.giftMembershipsLevelName ?? 'membership')}`, tier: 4 };
    }
    case 'giftmembershipreceivedevent':
      return { ...base, kind: 'other', text: String(sn.displayMessage ?? '') };
    default:
      return null;   // tombstones, deletions, bans, polls, sponsor-only mode…
  }
}
