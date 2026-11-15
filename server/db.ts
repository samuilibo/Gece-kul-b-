import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogItem } from '../shared/protocol.ts';

export interface StoredMember { id: string; name: string; outfit: number; color: number; vip: number }

/** Local SQLite store (node:sqlite, no native build step). */
export class Db {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, outfit INTEGER NOT NULL DEFAULT 0, color INTEGER NOT NULL DEFAULT 0,
        vip INTEGER NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blocked (id TEXT PRIMARY KEY, name TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS processed (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, scope TEXT NOT NULL, msg TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS processed_ts ON processed(ts);
    `);
  }

  getJson<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try { return JSON.parse(row.value) as T; } catch { return fallback; }
  }

  setJson(key: string, value: unknown) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  /** Returns true when the message id has not been seen before (and records it). */
  markProcessed(id: string, ts: number): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO processed (id, ts) VALUES (?, ?)').run(id, ts);
    return Number(r.changes) > 0;
  }

  pruneProcessed(olderThan: number) {
    this.db.prepare('DELETE FROM processed WHERE ts < ?').run(olderThan);
    this.db.prepare('DELETE FROM logs WHERE id < (SELECT COALESCE(MAX(id), 0) - 5000 FROM logs)').run();
  }

  getMember(id: string): StoredMember | undefined {
    return this.db.prepare('SELECT id, name, outfit, color, vip FROM members WHERE id = ?').get(id) as StoredMember | undefined;
  }

  saveMember(m: StoredMember, now: number) {
    this.db.prepare(`INSERT INTO members (id, name, outfit, color, vip, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, outfit = excluded.outfit, color = excluded.color, vip = excluded.vip, last_seen = excluded.last_seen`)
      .run(m.id, m.name, m.outfit, m.color, m.vip, now, now);
  }

  block(id: string, name: string, now: number) {
    this.db.prepare('INSERT OR REPLACE INTO blocked (id, name, ts) VALUES (?, ?, ?)').run(id, name, now);
  }

  unblock(id: string) { this.db.prepare('DELETE FROM blocked WHERE id = ?').run(id); }

  blocked(): { id: string; name: string }[] {
    return this.db.prepare('SELECT id, name FROM blocked ORDER BY ts DESC').all() as { id: string; name: string }[];
  }

  log(item: LogItem) {
    this.db.prepare('INSERT INTO logs (ts, level, scope, msg) VALUES (?, ?, ?, ?)').run(item.ts, item.level, item.scope, item.msg.slice(0, 2000));
  }

  recentLogs(limit = 200): LogItem[] {
    return (this.db.prepare('SELECT ts, level, scope, msg FROM logs ORDER BY id DESC LIMIT ?').all(limit) as unknown as LogItem[]).reverse();
  }

  clearLogs() { this.db.exec('DELETE FROM logs'); }

  close() { this.db.close(); }
}
