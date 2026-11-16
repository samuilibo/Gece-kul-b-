import type { CommandName } from '../../shared/protocol.ts';

// Turkish-aware lowercase: "İ" -> "i", "I" -> "ı" is NOT wanted for commands, so we
// normalise both dotted/dotless variants to plain ASCII before matching aliases.
export function fold(s: string): string {
  return s
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

const ALIASES: Record<CommandName, string[]> = {
  join: ['join', 'katil', 'gir'],
  dance: ['dance', 'dans'],
  shuffle: ['shuffle'],
  breakdance: ['breakdance', 'break'],
  robot: ['robot'],
  jump: ['jump', 'zipla'],
  wave: ['wave', 'selam'],
  clap: ['clap', 'alkis'],
  sit: ['sit', 'otur'],
  outfit: ['outfit', 'kiyafet'],
  color: ['color', 'colour', 'renk'],
  vip: ['vip'],
  stage: ['stage', 'sahne'],
  floor: ['floor', 'pist'],
  camera: ['camera', 'kamera'],
  song: ['song', 'muzik', 'music'],
  duo: ['duo', 'duet'],
  accept: ['accept', 'kabul'],
  leave: ['leave', 'cik', 'cikis'],
  help: ['help', 'yardim', 'komutlar'],
  event: ['event', 'etkinlik', 'oy', 'vote'],
  queue: ['queue', 'sira', 'siram', 'line', 'kuyruk'],
};

const LOOKUP = new Map<string, CommandName>();
for (const [cmd, list] of Object.entries(ALIASES)) for (const a of list) LOOKUP.set(a, cmd as CommandName);

export interface ParsedCommand { cmd: CommandName; arg: string; raw: string }

/** Parses "!komut arg". Returns null for normal chat messages. */
export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim();
  if (!t.startsWith('!') || t.length < 2 || t.length > 120) return null;
  const m = /^!\s?(\S+)(?:\s+(.*))?$/u.exec(t);
  if (!m) return null;
  const cmd = LOOKUP.get(fold(m[1]));
  if (!cmd) return null;
  return { cmd, arg: (m[2] ?? '').trim().slice(0, 60), raw: t };
}

export const HELP_TEXT = {
  tr: '!katıl (doluysa sıraya girer, !sıra) · !dans · !shuffle · !robot · !breakdance · !zıpla · !selam · !otur · !kıyafet · !renk · !vip · !sahne · !kamera · !müzik <tür> · !duo <isim> · !accept · !çık',
  en: '!join (queues when full, !queue) · !dance · !shuffle · !robot · !breakdance · !jump · !wave · !sit · !outfit · !color · !vip · !stage · !camera · !song <genre> · !duo <name> · !accept · !leave',
};
