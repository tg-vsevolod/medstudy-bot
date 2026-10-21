import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env, type Track } from './config.js';

export type Step = 'q_applicant' | 'q_track' | 'q_location' | 'registered';
export type Applicant = 'self' | 'child';
export type Location = 'prague' | 'relocating';
export type Attendance = 'offline' | 'online';
export type JobKind =
  | 'no_answer'
  | 'remind_3d'
  | 'remind_1d'
  | 'remind_1h'
  | 'remind_5m'
  | 'mk_end'
  | 'trial_offer';
export type Segment = 'all' | 'med' | 'tech' | 'offline' | 'online';

export interface User {
  id: number;
  username: string | null;
  first_name: string | null;
  step: Step;
  applicant: Applicant | null;
  track: Track | null;
  location: Location | null;
  attendance: Attendance | null;
  sheet_row: number | null;
  blocked: number;
  created_at: number;
  registered_at: number | null;
  last_question_at: number | null;
  bitrix_lead_id: number | null;
}

export interface Job {
  id: number;
  user_id: number;
  kind: JobKind;
  run_at: number;
  expires_at: number | null;
}

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });

export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    step TEXT NOT NULL DEFAULT 'q_applicant',
    applicant TEXT,
    track TEXT,
    location TEXT,
    attendance TEXT,
    sheet_row INTEGER,
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    registered_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    expires_at INTEGER,
    sent_at INTEGER,
    cancelled INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, kind)
  );
  CREATE INDEX IF NOT EXISTS jobs_due ON jobs (sent_at, cancelled, run_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const userColumns = new Set((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
for (const column of ['last_question_at', 'bitrix_lead_id']) {
  if (!userColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} INTEGER`);
}

const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');

export function getUser(id: number): User | undefined {
  return getUserStmt.get(id) as User | undefined;
}

export function upsertUser(from: { id: number; username?: string; first_name: string }): {
  user: User;
  isNew: boolean;
} {
  const existing = getUser(from.id);
  if (existing) {
    db.prepare('UPDATE users SET username = ?, first_name = ?, blocked = 0 WHERE id = ?').run(
      from.username ?? null,
      from.first_name,
      from.id,
    );
    return { user: getUser(from.id)!, isNew: false };
  }
  db.prepare('INSERT INTO users (id, username, first_name, created_at) VALUES (?, ?, ?, ?)').run(
    from.id,
    from.username ?? null,
    from.first_name,
    Date.now(),
  );
  return { user: getUser(from.id)!, isNew: true };
}

export function updateUser(id: number, fields: Partial<Omit<User, 'id'>>): User {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length > 0) {
    const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
    db.prepare(`UPDATE users SET ${assignments} WHERE id = @id`).run({ ...fields, id });
  }
  return getUser(id)!;
}

export const deleteUser = db.transaction((id: number) => {
  db.prepare('DELETE FROM jobs WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
});

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Повторная постановка уже отправленной задачи игнорируется, поэтому каждое сообщение уходит не больше одного раза. */
export function scheduleJob(userId: number, kind: JobKind, runAt: number, expiresAt: number | null = null): void {
  db.prepare(
    `INSERT INTO jobs (user_id, kind, run_at, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, kind) DO UPDATE
       SET run_at = excluded.run_at, expires_at = excluded.expires_at, cancelled = 0
       WHERE jobs.sent_at IS NULL`,
  ).run(userId, kind, runAt, expiresAt);
}

export function cancelJob(userId: number, kind: JobKind): void {
  db.prepare('UPDATE jobs SET cancelled = 1 WHERE user_id = ? AND kind = ? AND sent_at IS NULL').run(userId, kind);
}

/** Удаляет и уже отправленные напоминания, чтобы после переноса даты они пришли заново. */
export function resetReminders(userId: number): void {
  db.prepare("DELETE FROM jobs WHERE user_id = ? AND kind != 'no_answer'").run(userId);
}

export function dueJobs(now: number, limit = 100): Job[] {
  return db
    .prepare(
      `SELECT id, user_id, kind, run_at, expires_at FROM jobs
       WHERE sent_at IS NULL AND cancelled = 0 AND run_at <= ?
       ORDER BY run_at LIMIT ?`,
    )
    .all(now, limit) as Job[];
}

export function markJobSent(id: number): void {
  db.prepare('UPDATE jobs SET sent_at = ? WHERE id = ?').run(Date.now(), id);
}

const segmentFilters: Record<Segment, string> = {
  all: '1 = 1',
  med: "step = 'registered' AND track = 'med'",
  tech: "step = 'registered' AND track = 'tech'",
  offline: "step = 'registered' AND attendance = 'offline'",
  online: "step = 'registered' AND attendance = 'online'",
};

export function segmentUserIds(segment: Segment): number[] {
  const rows = db
    .prepare(`SELECT id FROM users WHERE blocked = 0 AND ${segmentFilters[segment]}`)
    .all() as { id: number }[];
  return rows.map((row) => row.id);
}

/** У пользователей, начавших опрос до появления last_question_at, он пустой, и лиды на них не создаются. */
export function abandonedUsers(cutoff: number): User[] {
  return db
    .prepare(
      `SELECT * FROM users
       WHERE step != 'registered' AND bitrix_lead_id IS NULL AND last_question_at <= ?
       ORDER BY last_question_at`,
    )
    .all(cutoff) as User[];
}

export function allUsers(): User[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all() as User[];
}

export interface Stats {
  total: number;
  registered: number;
  unfinished: number;
  blocked: number;
  med: number;
  tech: number;
  self: number;
  child: number;
  prague: number;
  relocating: number;
  offline: number;
  online: number;
  leads: number;
}

export function getStats(): Stats {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(step = 'registered'), 0) AS registered,
         COALESCE(SUM(step != 'registered'), 0) AS unfinished,
         COALESCE(SUM(blocked = 1), 0) AS blocked,
         COALESCE(SUM(step = 'registered' AND track = 'med'), 0) AS med,
         COALESCE(SUM(step = 'registered' AND track = 'tech'), 0) AS tech,
         COALESCE(SUM(step = 'registered' AND applicant = 'self'), 0) AS self,
         COALESCE(SUM(step = 'registered' AND applicant = 'child'), 0) AS child,
         COALESCE(SUM(step = 'registered' AND location = 'prague'), 0) AS prague,
         COALESCE(SUM(step = 'registered' AND location = 'relocating'), 0) AS relocating,
         COALESCE(SUM(attendance = 'offline'), 0) AS offline,
         COALESCE(SUM(attendance = 'online'), 0) AS online,
         COUNT(bitrix_lead_id) AS leads
       FROM users`,
    )
    .get() as Stats;
}
