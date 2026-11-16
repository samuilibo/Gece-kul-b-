import {
  GENRES, GENRE_LABEL, SC_EFFECTS, defaultSettings,
  type ActionKind, type ChatLogItem, type ClubEvent, type CommandName, type Genre, type LogItem, type Member,
  type PublicState, type ServerMsg, type Settings, type Source, type SupportEffect, type VoteState,
} from '../../shared/protocol.ts';
import { EVENTS, eventById } from '../../shared/events.ts';
import { HELP_TEXT, fold, parseCommand } from './commands.ts';
import { Moderation } from './moderation.ts';
import type { Db } from '../db.ts';

export interface ChatEvent {
  id: string;
  source: Source;
  ts: number;
  historical?: boolean;      // replayed backlog: never triggers commands or effects
  author: { id: string; name: string; avatar?: string; isOwner?: boolean; isMod?: boolean; isMember?: boolean };
  kind: 'text' | 'superchat' | 'sticker' | 'member' | 'milestone' | 'gift' | 'other';
  text: string;
  amountText?: string;
  tier?: number;
}

type Audience = 'all' | 'admin';
const STAGE_CAPACITY = 4;
const STAGE_MS = 45000;
const VOTE_MS = 45000;
const EVENT_VOTE_MS = 60000;
const MAX_QUEUE = 50;

const GENRE_ALIASES: Record<string, Genre> = {
  edm: 'edm', techno: 'techno', tekno: 'techno', deephouse: 'deephouse', deep: 'deephouse', house: 'deephouse',
  progressive: 'progressive', prog: 'progressive', trance: 'trance', hiphop: 'hiphop', rap: 'hiphop', 'hip-hop': 'hiphop',
  disco: 'disco', disko: 'disco', synthwave: 'synthwave', synth: 'synthwave', retro: 'synthwave',
  turkish: 'turkish', turkce: 'turkish', turk: 'turkish', tr: 'turkish',
};

export function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export class ClubState {
  settings: Settings;
  members = new Map<string, Member>();
  mode: PublicState['mode'] = 'idle';
  event: ClubEvent = EVENTS[0];
  nextEvent: ClubEvent | null = EVENTS[1];
  eventEndsAt = 0;
  vote: VoteState | null = null;
  emergency = false;
  mod: Moderation;

  private voters = new Set<string>();
  private eventVoteOpened = false;
  private cooldowns = new Map<string, number>();
  private globalCd = new Map<string, number>();
  private lastSeen = new Map<string, number>();
  private supporters = new Set<string>();
  private granted = new Set<string>();
  private stage = new Map<string, number>();        // member id -> leaves stage at
  private invites = new Map<string, { from: string; expires: number }>();
  private queue: SupportEffect[] = [];
  private activeUntil = 0;
  private uidCounter = 0;
  private blockedIds: Set<string>;
  private idleMs: number;

  constructor(
    private db: Db,
    private send: (msg: ServerMsg, to: Audience) => void,
    private logFn: (level: LogItem['level'], scope: string, msg: string) => void,
    opts: { badWords?: string[]; idleMinutes?: number; now?: number } = {},
  ) {
    const stored = db.getJson<Partial<Settings>>('settings', {});
    this.settings = mergeSettings(defaultSettings(), stored);
    this.mod = new Moderation(opts.badWords ?? []);
    this.blockedIds = new Set(db.blocked().map((b) => b.id));
    this.idleMs = (opts.idleMinutes ?? 60) * 60000;
    this.eventEndsAt = (opts.now ?? Date.now()) + this.settings.eventMinutes * 60000;
    const ev = db.getJson<string>('event', 'neon');
    this.event = eventById(ev);
    this.nextEvent = this.pickNext();
  }

  // ------------------------------------------------------------------ state
  publicState(now = Date.now()): PublicState {
    return {
      mode: this.mode, members: [...this.members.values()], settings: this.settings, event: this.event,
      nextEvent: this.nextEvent, eventEndsAt: this.eventEndsAt, vote: this.vote, emergency: this.emergency, now,
    };
  }

  queueLength() { return this.queue.length; }

  setMode(mode: PublicState['mode']) {
    if (mode === this.mode) return;
    // Real and demo audiences never mix: switching mode clears the other kind.
    const drop = (s: Source) => (mode === 'live' ? s === 'demo' : s !== 'demo');
    if (mode !== 'idle') for (const m of [...this.members.values()]) if (drop(m.source)) this.remove(m.id, 'mode');
    if (mode !== 'idle') this.queue = this.queue.filter((e) => !drop(e.source));
    this.mode = mode;
    this.send({ t: 'mode', mode }, 'all');
  }

  patchSettings(patch: Partial<Settings>) {
    this.settings = mergeSettings(this.settings, patch);
    this.settings.maxCharacters = Math.max(1, Math.min(300, Math.round(this.settings.maxCharacters)));
    this.db.setJson('settings', this.settings);
    this.send({ t: 'settings', settings: this.settings }, 'all');
  }

  // ------------------------------------------------------------------ chat entry point
  handleChat(ev: ChatEvent, now = Date.now()): string {
    // strict separation of real and simulated traffic
    if (ev.source === 'demo' && this.mode !== 'demo') return 'rejected:demo-off';
    if (ev.source !== 'demo' && this.mode !== 'live') return 'rejected:not-live';
    if (ev.source !== 'demo' && !this.db.markProcessed(ev.id, now)) return 'duplicate';

    const name = this.mod.cleanName(ev.author.name, ev.author.id);
    let result = 'chat';
    if (ev.historical) result = 'historical';
    else if (this.emergency) result = 'emergency-stop';
    else if (this.blockedIds.has(ev.author.id)) result = 'blocked';
    else {
      this.lastSeen.set(ev.author.id, now);
      if (ev.kind !== 'text' && ev.kind !== 'other') result = this.handleSupport(ev, name, now);
      if (ev.kind === 'text' || ev.kind === 'superchat' || ev.kind === 'milestone') {
        const cmd = parseCommand(ev.text);
        if (cmd) {
          const r = this.handleCommand(ev, name, cmd.cmd, cmd.arg, now);
          result = ev.kind === 'text' ? r : `${result}+${r}`;
        } else if (ev.kind === 'text' && this.mod.isProfane(ev.text)) result = 'filtered';
      }
    }
    const item: ChatLogItem = {
      ts: now, source: ev.source, authorId: ev.author.id, author: name, text: ev.text.slice(0, 200),
      kind: ev.kind === 'milestone' ? 'member' : ev.kind === 'other' ? 'system' : ev.kind, result, amountText: ev.amountText,
    };
    this.send({ t: 'chat', item }, 'admin');
    return result;
  }

  // ------------------------------------------------------------------ commands
  private handleCommand(ev: ChatEvent, name: string, cmd: CommandName, arg: string, now: number): string {
    const cfg = this.settings.commands[cmd];
    if (!cfg?.on) return 'disabled';
    if (this.mod.isProfane(arg)) return 'filtered';
    const spam = this.mod.spamCheck(ev.author.id, `${cmd} ${arg}`, now);
    if (spam) return `spam:${spam}`;
    const cdKey = `${ev.author.id}:${cmd}`;
    if ((this.cooldowns.get(cdKey) ?? 0) > now) return 'cooldown';
    const id = ev.author.id;
    const me = this.members.get(id);
    const done = (r: string) => { this.cooldowns.set(cdKey, now + cfg.cooldown * 1000); return r; };
    const globalReady = (key: string, ms: number) => {
      if ((this.globalCd.get(key) ?? 0) > now) return false;
      this.globalCd.set(key, now + ms);
      return true;
    };

    if (cmd === 'join') {
      if (me) return 'already-in';
      if (this.members.size >= this.settings.maxCharacters) return 'full';
      const stored = this.db.getMember(id);
      const privileged = !!(ev.author.isMember || ev.author.isMod || ev.author.isOwner);
      const m: Member = {
        id, name, avatar: ev.author.avatar, source: ev.source, seed: hashSeed(id), outfit: stored?.outfit ?? 0,
        color: stored?.color ?? 0, zone: 'floor', sitting: false, joinedAt: now,
        vip: privileged || this.supporters.has(id) || this.granted.has(id) || !!stored?.vip,
      };
      this.members.set(id, m);
      this.persist(m, now);
      this.send({ t: 'join', member: m }, 'all');
      return done('joined');
    }
    if (cmd === 'help') {
      if (!globalReady('help', 30000)) return 'cooldown';
      this.send({ t: 'notice', kind: 'help', text: HELP_TEXT }, 'all');
      return done('help');
    }
    if (cmd === 'song') return this.voteSong(id, arg, now, done);
    if (cmd === 'event') return this.voteEvent(id, arg, done);
    if (!me) return 'not-joined';
    if (me.name !== name) { me.name = name; }

    const act = (action: ActionKind, a?: string) => {
      if (me.sitting) { me.sitting = false; if (me.zone === 'lounge') me.zone = 'floor'; this.sendUpdate(me); }
      this.send({ t: 'action', id, action, arg: a }, 'all');
    };
    switch (cmd) {
      case 'dance': act('dance', fold(arg).replace(/[^a-z0-9_]/g, '').slice(0, 20) || undefined); return done('dance');
      case 'shuffle': case 'breakdance': case 'robot': case 'jump': case 'wave': case 'clap':
        act(cmd); return done(cmd);
      case 'sit':
        if (me.zone === 'stage') return 'on-stage';
        me.sitting = true;
        if (me.zone === 'floor') me.zone = 'lounge';
        this.sendUpdate(me);
        return done('sit');
      case 'floor':
        me.sitting = false; me.zone = 'floor'; this.stage.delete(id); this.sendUpdate(me);
        return done('floor');
      case 'outfit': me.outfit++; this.persist(me, now); this.sendUpdate(me); return done('outfit');
      case 'color': me.color++; this.persist(me, now); this.sendUpdate(me); return done('color');
      case 'vip':
        if (!(me.vip || this.settings.vipOpen)) return 'vip-denied';
        if (me.zone === 'vip') { me.zone = 'floor'; me.sitting = false; } else { me.zone = 'vip'; me.sitting = false; this.stage.delete(id); }
        this.sendUpdate(me);
        return done('vip');
      case 'stage':
        if (me.zone === 'stage') return 'already-on-stage';
        if (this.stage.size >= STAGE_CAPACITY) return 'stage-full';
        this.toStage(me, now);
        return done('stage');
      case 'camera':
        if (!globalReady('camera', 20000)) return 'camera-busy';
        this.send({ t: 'camera', shot: 'user', target: id, hold: 8 }, 'all');
        return done('camera');
      case 'duo': {
        const q = fold(arg.replace(/^@/, ''));
        if (!q) return 'duo-no-target';
        const target = [...this.members.values()].find((m) => m.id !== id && fold(m.name).startsWith(q));
        if (!target) return 'duo-not-found';
        this.invites.set(target.id, { from: id, expires: now + 60000 });
        this.send({ t: 'notice', kind: 'info', text: { tr: `${me.name} → ${target.name}: dans daveti! (!accept)`, en: `${me.name} invited ${target.name} to dance! (!accept)` } }, 'all');
        return done('duo-invited');
      }
      case 'accept': {
        const inv = this.invites.get(id);
        if (!inv || inv.expires < now) return 'no-invite';
        const other = this.members.get(inv.from);
        this.invites.delete(id);
        if (!other) return 'no-invite';
        for (const m of [me, other]) if (m.sitting || m.zone !== 'floor') { m.sitting = false; m.zone = 'floor'; this.stage.delete(m.id); this.sendUpdate(m); }
        this.send({ t: 'duo', a: other.id, b: id }, 'all');
        return done('duo');
      }
      case 'leave': this.remove(id, 'left'); return done('left');
      default: return 'ignored';
    }
  }

  private toStage(m: Member, now: number) {
    m.zone = 'stage'; m.sitting = false;
    this.stage.set(m.id, now + STAGE_MS);
    this.sendUpdate(m);
  }

  private voteSong(id: string, arg: string, now: number, done: (r: string) => string): string {
    const g = GENRE_ALIASES[fold(arg).replace(/\s+/g, '')];
    if (!g) {
      this.send({ t: 'notice', kind: 'info', text: { tr: `Müzik oylaması: !müzik ${GENRES.join(' | ')}`, en: `Music vote: !song ${GENRES.join(' | ')}` } }, 'all');
      return 'song-help';
    }
    if (this.vote && this.vote.kind !== 'song') return 'vote-busy';
    if (!this.vote) {
      this.vote = { kind: 'song', options: GENRES.map((k) => ({ key: k, label: GENRE_LABEL[k], count: 0 })), endsAt: now + VOTE_MS };
      this.voters.clear();
    }
    if (this.voters.has(id)) return 'already-voted';
    this.voters.add(id);
    this.vote.options.find((o) => o.key === g)!.count++;
    this.send({ t: 'vote', vote: this.vote }, 'all');
    return done(`vote:${g}`);
  }

  private voteEvent(id: string, arg: string, done: (r: string) => string): string {
    if (!this.vote || this.vote.kind !== 'event') return 'no-event-vote';
    const n = parseInt(arg, 10);
    const opt = Number.isFinite(n) ? this.vote.options[n - 1] : this.vote.options.find((o) => fold(o.label).includes(fold(arg)) && arg.length > 1);
    if (!opt) return 'bad-option';
    if (this.voters.has(id)) return 'already-voted';
    this.voters.add(id);
    opt.count++;
    this.send({ t: 'vote', vote: this.vote }, 'all');
    return done(`vote:${opt.key}`);
  }

  // ------------------------------------------------------------------ paid / membership events (cosmetic only)
  private handleSupport(ev: ChatEvent, name: string, now: number): string {
    const sc = this.settings.superchat;
    const tier = Math.max(0, Math.min(11, ev.tier ?? (ev.kind === 'superchat' || ev.kind === 'sticker' ? 1 : 3)));
    if (tier < 1) return 'support:below-min';           // tiny gifts (e.g. single TikTok roses): logged, no effect
    if (this.settings.supporterVip) {
      this.supporters.add(ev.author.id);
      const m = this.members.get(ev.author.id);
      if (m && !m.vip) { m.vip = true; this.persist(m, now); this.sendUpdate(m); }
    }
    if (!sc.enabled) return 'support:effects-off';
    if (this.queue.length >= MAX_QUEUE) return 'support:queue-full';
    const effects = SC_EFFECTS.filter((e) => sc.effects[e].on && tier >= sc.effects[e].minTier);
    const effect: SupportEffect = {
      uid: `fx${++this.uidCounter}-${now}`,
      kind: ev.kind === 'superchat' ? 'superchat' : ev.kind === 'sticker' ? 'sticker' : ev.kind === 'gift' ? 'gift' : 'member',
      source: ev.source, memberId: ev.author.id, name, amountText: ev.amountText ?? '',
      comment: this.mod.isProfane(ev.text) ? '' : ev.text.slice(0, 120), tier, effects,
      durationMs: Math.min(20000, sc.baseDurationMs + (tier - 1) * 1300),
    };
    this.queue.push(effect);
    this.pump(now);
    return `support:queued(${effects.length})`;
  }

  private pump(now: number) {
    if (this.emergency || now < this.activeUntil || !this.queue.length) return;
    const e = this.queue.shift()!;
    this.activeUntil = now + e.durationMs + 600;
    const m = this.members.get(e.memberId);
    if (m && e.effects.includes('stage') && m.zone !== 'stage' && this.stage.size < STAGE_CAPACITY) this.toStage(m, now);
    this.send({ t: 'effect', effect: e }, 'all');
  }

  // ------------------------------------------------------------------ admin operations
  remove(id: string, why: string) {
    if (!this.members.delete(id)) return;
    this.stage.delete(id);
    this.invites.delete(id);
    this.send({ t: 'leave', id }, 'all');
    if (why !== 'left' && why !== 'mode') this.logFn('info', 'club', `removed ${id} (${why})`);
  }

  block(id: string, now = Date.now()) {
    const name = this.members.get(id)?.name ?? id;
    this.blockedIds.add(id);
    this.db.block(id, name, now);
    this.remove(id, 'blocked');
  }

  unblock(id: string) { this.blockedIds.delete(id); this.db.unblock(id); }

  grantVip(id: string, on: boolean, now = Date.now()) {
    if (on) this.granted.add(id); else this.granted.delete(id);
    const m = this.members.get(id);
    if (m) {
      m.vip = on;
      if (!on && m.zone === 'vip' && !this.settings.vipOpen) m.zone = 'floor';
      this.persist(m, now);
      this.sendUpdate(m);
    }
  }

  setEvent(id: string, now = Date.now()) {
    this.event = eventById(id);
    this.db.setJson('event', this.event.id);
    this.eventEndsAt = now + this.settings.eventMinutes * 60000;
    this.nextEvent = this.pickNext();
    this.eventVoteOpened = false;
    if (this.vote?.kind === 'event') { this.vote = null; this.send({ t: 'vote', vote: null }, 'all'); }
    this.send({ t: 'event', event: this.event, next: this.nextEvent, endsAt: this.eventEndsAt }, 'all');
  }

  openEventVote(now = Date.now()) {
    if (this.vote) return;
    const pool = EVENTS.filter((e) => e.id !== this.event.id);
    const picks: ClubEvent[] = [];
    while (picks.length < 3 && pool.length) picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    this.vote = { kind: 'event', options: picks.map((e) => ({ key: e.id, label: e.name.tr, count: 0 })), endsAt: now + EVENT_VOTE_MS };
    this.voters.clear();
    this.eventVoteOpened = true;
    this.eventEndsAt = Math.max(this.eventEndsAt, now + EVENT_VOTE_MS);
    this.send({ t: 'vote', vote: this.vote }, 'all');
  }

  setEmergency(on: boolean) {
    this.emergency = on;
    if (on) { this.queue = []; this.activeUntil = 0; this.vote = null; }
    this.send({ t: 'emergency', on }, 'all');
    this.logFn('warn', 'club', on ? 'EMERGENCY STOP engaged' : 'emergency stop released');
  }

  // ------------------------------------------------------------------ timers (call ~1/s)
  tick(now = Date.now()) {
    if (this.emergency) return;
    this.pump(now);
    for (const [id, until] of this.stage) {
      if (until > now) continue;
      this.stage.delete(id);
      const m = this.members.get(id);
      if (m && m.zone === 'stage') { m.zone = 'floor'; this.sendUpdate(m); }
    }
    for (const [id, inv] of this.invites) if (inv.expires < now) this.invites.delete(id);
    if (this.vote && this.vote.endsAt <= now) this.closeVote(now);
    if (this.settings.eventVoting && !this.eventVoteOpened && !this.vote && this.mode !== 'idle'
      && this.members.size > 0 && this.eventEndsAt - now < EVENT_VOTE_MS) this.openEventVote(now);
    if (now >= this.eventEndsAt && !(this.vote?.kind === 'event')) this.setEvent((this.nextEvent ?? this.pickNext()).id, now);
    // auto-leave for viewers that have been silent for a long time
    if (this.idleMs > 0) {
      for (const m of this.members.values()) {
        if (m.source !== 'demo' && now - (this.lastSeen.get(m.id) ?? m.joinedAt) > this.idleMs) this.remove(m.id, 'idle');
      }
    }
  }

  /** Housekeeping for long streams (call every few minutes). */
  sweep(now = Date.now()) {
    this.mod.sweep(now);
    for (const [k, v] of this.cooldowns) if (v < now) this.cooldowns.delete(k);
    for (const [k, v] of this.lastSeen) if (now - v > this.idleMs + 600000 && !this.members.has(k)) this.lastSeen.delete(k);
    this.db.pruneProcessed(now - 48 * 3600000);
  }

  private closeVote(now: number) {
    const v = this.vote!;
    this.vote = null;
    const top = [...v.options].sort((a, b) => b.count - a.count)[0];
    const winner = top && top.count > 0 ? top.key : undefined;
    this.send({ t: 'vote', vote: null, winner }, 'all');
    if (v.kind === 'song' && winner) this.send({ t: 'music', cmd: 'genre', arg: winner }, 'all');
    if (v.kind === 'event') {
      if (winner) this.nextEvent = eventById(winner);
      this.setEvent((this.nextEvent ?? this.pickNext()).id, now);
    }
  }

  private pickNext(): ClubEvent {
    const i = EVENTS.findIndex((e) => e.id === this.event.id);
    return EVENTS[(i + 1) % EVENTS.length];
  }

  /** Profile pictures that arrive after the join (Twitch). */
  setAvatar(id: string, url: string) {
    const m = this.members.get(id);
    if (!m || m.avatar === url) return;
    m.avatar = url;
    this.sendUpdate(m);
  }

  private sendUpdate(m: Member) { this.send({ t: 'update', member: m }, 'all'); }

  private persist(m: Member, now: number) {
    if (m.source === 'demo') return;   // simulated users are never stored
    this.db.saveMember({ id: m.id, name: m.name, outfit: m.outfit, color: m.color, vip: m.vip ? 1 : 0 }, now);
  }
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  const out = structuredClone(base) as Settings;
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(b ?? {})) {
      if (!(k in a)) continue;                      // unknown keys from old versions are dropped
      const cur = a[k];
      if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object') merge(cur as Record<string, unknown>, v as Record<string, unknown>);
      else if (typeof cur === typeof v) a[k] = v;
    }
  };
  merge(out as unknown as Record<string, unknown>, patch as Record<string, unknown>);
  return out;
}
