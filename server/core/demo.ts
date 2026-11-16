import { GENRES } from '../../shared/protocol.ts';
import type { ChatEvent, ClubState } from './club.ts';

const FIRST = ['Deniz', 'Ece', 'Mert', 'Zeynep', 'Kaan', 'Elif', 'Baran', 'Selin', 'Emre', 'Defne', 'Arda', 'Nil', 'Can', 'İpek', 'Ozan',
  'Luna', 'Max', 'Mia', 'Leo', 'Zoe', 'Noah', 'Ava', 'Kai', 'Ivy', 'Jay', 'Sara', 'Tom', 'Lina', 'Rex', 'Nova'];
const LAST = ['Yıldız', 'Dalga', 'Beat', 'Neon', 'Ritim', 'Gece', 'Wave', 'Bass', 'Pulse', 'Vibe', 'Storm', 'Echo', 'Flux', 'Volt', 'Sky'];
const ACTIONS = ['!dance', '!dans', '!shuffle', '!robot', '!breakdance', '!jump', '!zıpla', '!wave', '!selam', '!clap', '!outfit', '!kıyafet',
  '!color', '!renk', '!dance', '!dans', '!dance', '!sit', '!pist', '!vip', '!stage', '!sahne', '!camera', '!help'];
const SMALLTALK = ['bu şarkı çok iyi 🔥', 'selam herkese', 'DJ harika', 'nice drop!', 'hello from Berlin', 'kim var burada?', 'lights are insane'];
// Simulated amounts that really belong to each YouTube tier (tier 1 ≈ $1, 2 ≈ $2, 3 ≈ $5, 4 ≈ $10, 5 ≈ $20, 6 ≈ $50,
// 7 ≈ $100, 8 ≈ $200, 9 ≈ $300, 10 ≈ $400, 11 ≈ $500). Lira values stay inside the tier for 35–60 TRY per USD;
// above tier 7 the bands are too narrow for an uncertain exchange rate, so only USD / EUR are simulated there.
export const DEMO_AMOUNTS: { usd: string; eur: string; try: string }[] = [
  { usd: '$1.50', eur: '€1,50', try: '₺60,00' },
  { usd: '$3.00', eur: '€3,00', try: '₺150,00' },
  { usd: '$7.00', eur: '€7,00', try: '₺320,00' },
  { usd: '$15.00', eur: '€14,00', try: '₺650,00' },
  { usd: '$30.00', eur: '€28,00', try: '₺1.500,00' },
  { usd: '$75.00', eur: '€70,00', try: '₺3.300,00' },
  { usd: '$150.00', eur: '€140,00', try: '₺6.500,00' },
  { usd: '$250.00', eur: '€230,00', try: '' },
  { usd: '$350.00', eur: '€320,00', try: '' },
  { usd: '$450.00', eur: '€410,00', try: '' },
  { usd: '$500.00', eur: '€500,00', try: '' },
];
export function demoAmount(tier: number, r = Math.random()) {
  const row = DEMO_AMOUNTS[Math.max(1, Math.min(11, tier)) - 1];
  if (!row.try) return r < 0.6 ? row.usd : row.eur;
  return r < 0.5 ? row.try : r < 0.8 ? row.usd : row.eur;
}

/**
 * Simulation feed. Everything produced here carries source: 'demo' and ids prefixed
 * with "demo:"; ClubState rejects these events unless demo mode is active.
 */
export class DemoDriver {
  private bots: { id: string; name: string }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private session = 0;
  private pausedUntil = 0;
  rate = 1.2;                       // chat messages per second
  autoSuperchat = true;
  onDisconnectSim: ((phase: 'down' | 'up', ms: number) => void) | null = null;

  constructor(private club: ClubState) {}

  get running() { return this.timer !== null; }
  get count() { return this.bots.length; }

  start(count: number) {
    this.club.setMode('demo');
    if (!this.bots.length) this.session++;
    this.add(count);
    if (!this.timer) this.timer = setInterval(() => this.step(), 250);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const b of this.bots) this.club.remove(b.id, 'mode');
    this.bots = [];
    this.club.setMode('idle');
  }

  add(count: number) {
    if (this.club.mode !== 'demo') return;
    const base = this.bots.length;
    for (let i = 0; i < count; i++) {
      const n = base + i;
      const bot = { id: `demo:${this.session}-${n}`, name: `${FIRST[n % FIRST.length]}${LAST[(n * 7 + 3) % LAST.length]}${n >= FIRST.length ? Math.floor(n / FIRST.length) : ''}` };
      this.bots.push(bot);
      // staggered arrivals so the entrance animation is visible
      setTimeout(() => this.say(bot, n % 2 ? '!join' : '!katıl'), Math.min(i * (count > 60 ? 60 : 350), 30000));
    }
  }

  sayAsFirst(text: string) { return this.bots[0] ? this.say(this.bots[0], text) : 'no-bots'; }

  say(bot: { id: string; name: string }, text: string, extra: Partial<ChatEvent> = {}) {
    if (Date.now() < this.pausedUntil) return 'paused';
    return this.club.handleChat({ id: `demo-${++this.seq}`, source: 'demo', ts: Date.now(), author: { id: bot.id, name: bot.name }, kind: 'text', text, ...extra });
  }

  superchat(tier = 0, botIndex = -1) {
    if (!this.bots.length) return;
    const bot = this.bots[botIndex >= 0 ? botIndex % this.bots.length : Math.floor(Math.random() * this.bots.length)];
    // an explicit tier (panel button) is always a Super Chat; random ones also simulate stickers and memberships
    const r = tier ? 0 : Math.random();
    const kind: ChatEvent['kind'] = r < 0.7 ? 'superchat' : r < 0.85 ? 'sticker' : 'member';
    const t = kind === 'member' ? 3 : tier || 1 + Math.floor(Math.random() * 7);     // memberships are tier 3 like on YouTube
    this.say(bot, kind === 'member' ? 'Neon Üye' : 'Harika yayın! 🎉', { kind, tier: t, amountText: kind === 'member' ? '' : demoAmount(t) });
  }

  /** Simulated connection loss: the feed stops for `ms`, then resumes. */
  disconnectTest(ms = 8000) {
    this.pausedUntil = Date.now() + ms;
    this.onDisconnectSim?.('down', ms);
    setTimeout(() => this.onDisconnectSim?.('up', 0), ms);
  }

  private step() {
    if (!this.bots.length || this.club.mode !== 'demo') return;
    const n = this.rate * 0.25;
    let k = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    while (k-- > 0) {
      const bot = this.bots[Math.floor(Math.random() * this.bots.length)];
      const r = Math.random();
      if (r < 0.12) this.say(bot, SMALLTALK[Math.floor(Math.random() * SMALLTALK.length)]);
      else if (r < 0.16) this.say(bot, `!song ${GENRES[Math.floor(Math.random() * GENRES.length)]}`);
      else if (r < 0.2) this.say(bot, `!event ${1 + Math.floor(Math.random() * 3)}`);
      else if (r < 0.23) this.say(bot, `!duo ${this.bots[Math.floor(Math.random() * this.bots.length)].name.slice(0, 5)}`);
      else if (r < 0.27) this.say(bot, '!accept');
      else this.say(bot, ACTIONS[Math.floor(Math.random() * ACTIONS.length)]);
    }
    if (this.autoSuperchat && Math.random() < 0.006) this.superchat();
  }
}
