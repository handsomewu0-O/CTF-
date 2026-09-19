const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { normalizeChallengeCategory } = require('./challenge-categories');

const DEFAULT_SETTINGS = {
  competition_name: '天选杯——网安工作室个人挑战赛',
  competition_subtitle: 'SECURITY LAB · QUALIFIER',
  competition_status: 'draft',
  registration_open: 'false',
  bonus_first: '30',
  bonus_second: '20',
  bonus_third: '10',
  start_time: '',
  end_time: '',
};

function openDatabase(filename) {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      class_name TEXT NOT NULL,
      real_name TEXT NOT NULL,
      email TEXT NOT NULL,
      email_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'participant' CHECK(role IN ('participant', 'judge', 'admin')),
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      base_score INTEGER NOT NULL CHECK(base_score > 0),
      flag_digest TEXT NOT NULL,
      attachment_url TEXT NOT NULL DEFAULT '',
      target_url TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      challenge_id INTEGER NOT NULL REFERENCES challenges(id),
      answer_digest TEXT NOT NULL,
      is_correct INTEGER NOT NULL,
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_submissions_user_time ON submissions(user_id, created_at);

    CREATE TABLE IF NOT EXISTS solves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      challenge_id INTEGER NOT NULL REFERENCES challenges(id),
      solve_rank INTEGER NOT NULL,
      base_awarded INTEGER NOT NULL,
      bonus_awarded INTEGER NOT NULL,
      solved_at TEXT NOT NULL,
      UNIQUE(user_id, challenge_id),
      UNIQUE(challenge_id, solve_rank)
    );

    CREATE TABLE IF NOT EXISTS challenge_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id),
      source_name TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  const challengeColumns = db.prepare('PRAGMA table_info(challenges)').all();
  if (!challengeColumns.some((column) => column.name === 'target_url')) {
    db.exec("ALTER TABLE challenges ADD COLUMN target_url TEXT NOT NULL DEFAULT ''");
  }

  // Avatar paths are kept in the user record while image bytes live outside SQLite.
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((column) => column.name === 'avatar_url')) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
  }

  const updateCategory = db.prepare('UPDATE challenges SET category = ? WHERE category = ?');
  db.prepare('SELECT DISTINCT category FROM challenges').all().forEach(({ category }) => {
    const normalized = normalizeChallengeCategory(category);
    if (normalized && normalized !== category) updateCategory.run(normalized, category);
  });

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  const seedSettings = db.transaction(() => {
    Object.entries(DEFAULT_SETTINGS).forEach(([key, value]) => insertSetting.run(key, value));
  });
  seedSettings();

  return db;
}

function getSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value]));
}

function setSettings(db, values) {
  const statement = db.prepare(`
    INSERT INTO settings(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  db.transaction(() => Object.entries(values).forEach(([key, value]) => statement.run(key, String(value))))();
  return getSettings(db);
}

module.exports = { DEFAULT_SETTINGS, getSettings, openDatabase, setSettings };
