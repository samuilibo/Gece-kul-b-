import { fold } from './commands.ts';

// Compact starter list (TR + EN). Extend via BAD_WORDS in .env (comma separated).
const BASE_WORDS = [
  'amk', 'aq', 'amina', 'amcik', 'orospu', 'pic', 'sikerim', 'siktir', 'sikik', 'yarrak', 'yarak', 'gavat',
  'pezevenk', 'ibne', 'kahpe', 'gotveren', 'serefsiz', 'kaltak', 'surtuk', 'mal herif',
  'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'slut', 'asshole', 'dick', 'pussy',
  'rape', 'nazi', 'hitler', 'porn', 'porno', 'sex', 'seks',
];

function squash(s: string): string {
  // leetspeak + repeated letters: "s1k777tir" / "fuuuck"
  return fold(s)
    .replace(/[@4]/g, 'a').replace(/[1!|]/g, 'i').replace(/0/g, 'o').replace(/3/g, 'e').replace(/[5$]/g, 's').replace(/7/g, 't')
    .replace(/(.)\1{1,}/g, '$1');
}

export class Moderation {
  private words: string[];
  private last = new Map<string, { text: string; ts: number }>();
  private recent = new Map<string, number[]>();
  private muted = new Map<string, number>();

  constructor(extra: string[] = []) {
    this.words = [...BASE_WORDS, ...extra.map((w) => fold(w.trim())).filter(Boolean)].map((w) => squash(w));
  }

  isProfane(text: string): boolean {
    const s = squash(text);
    const rawTokens = s.split(/[^a-z0-9]+/).filter(Boolean);
    // "f.u.c.k" -> "fuck": runs of single letters are glued back together
    const tokens: string[] = [];
    let run = '';
    for (const t of rawTokens) {
      if (t.length === 1) { run += t; continue; }
      if (run) { tokens.push(run); run = ''; }
      tokens.push(t);
    }
    if (run) tokens.push(run);
    const joined = tokens.join('');
    for (const w of this.words) {
      if (w.includes(' ')) { if (s.includes(w)) return true; continue; }
      // short words must match a whole token; longer ones may be embedded
      if (w.length <= 4) { if (tokens.includes(w)) return true; } else if (joined.includes(w)) return true;
    }
    return false;
  }

  /** Display-name policy: strip control chars / zalgo / urls, mask profanity. */
  cleanName(name: string, id: string): string {
    let n = (name ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
      .replace(/[̀-ͯ]{2,}/g, '').replace(/^@/, '').trim();
    if (n.length > 24) n = n.slice(0, 23) + '…';
    const bad = !n || this.isProfane(n) || /https?:|www\.|\.(com|net|org|xyz|gg)\b/i.test(n);
    if (bad) {
      let h = 0;
      for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      return `Misafir${String(h % 10000).padStart(4, '0')}`;
    }
    return n;
  }

  /**
   * Flood control for commands. Returns a reason when the message must be ignored.
   *  - identical command repeated within 2.5 s
   *  - more than 8 commands in 30 s -> 60 s mute
   */
  spamCheck(userId: string, text: string, now: number): string | null {
    const until = this.muted.get(userId) ?? 0;
    if (until > now) return 'muted';
    const key = fold(text);
    const l = this.last.get(userId);
    if (l && l.text === key && now - l.ts < 2500) return 'repeat';
    this.last.set(userId, { text: key, ts: now });
    const arr = (this.recent.get(userId) ?? []).filter((t) => now - t < 30000);
    arr.push(now);
    this.recent.set(userId, arr);
    if (arr.length > 8) {
      this.muted.set(userId, now + 60000);
      return 'flood';
    }
    return null;
  }

  /** Periodic cleanup so long streams do not leak memory. */
  sweep(now: number) {
    for (const [k, v] of this.last) if (now - v.ts > 60000) this.last.delete(k);
    for (const [k, v] of this.recent) if (!v.length || now - v[v.length - 1] > 60000) this.recent.delete(k);
    for (const [k, v] of this.muted) if (v < now) this.muted.delete(k);
  }
}
