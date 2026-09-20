require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const multer = require('multer');

const { getSettings, openDatabase, setSettings } = require('./src/database');
const { applyPackage, ImportPackageError, previewPackage } = require('./src/importer');
const {
  digest,
  flagDigest,
  hashPassword,
  normalizeEmail,
  normalizeUsername,
  randomToken,
  safeEqualHex,
  usernameKey,
  validateProfile,
  validateRegistration,
  validPasswordLength,
  verifyPassword,
} = require('./src/security');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3100);
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'arena.sqlite');
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(ROOT, 'uploads');
const SESSION_COOKIE = 'arena_session';
const SESSION_HOURS = 24;
const MAX_PARTICIPANTS = Math.max(50, Number.parseInt(process.env.MAX_PARTICIPANTS, 10) || 100);
const MAX_SSE_CLIENTS = Math.max(50, Number.parseInt(process.env.MAX_SSE_CLIENTS, 10) || 150);
const MAX_SSE_PER_IP = Math.max(50, Number.parseInt(process.env.MAX_SSE_PER_IP, 10) || 75);
const db = openDatabase(DB_PATH);
const app = express();
const sseClients = new Set();

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

function loadFlagSecret() {
  if (process.env.FLAG_SECRET && process.env.FLAG_SECRET.length >= 32) return process.env.FLAG_SECRET;
  const filename = path.join(path.dirname(path.resolve(DB_PATH)), '.flag-secret');
  if (fs.existsSync(filename)) return fs.readFileSync(filename, 'utf8').trim();
  const secret = randomToken(48);
  fs.writeFileSync(filename, secret, { encoding: 'utf8', flag: 'wx' });
  return secret;
}

const FLAG_SECRET = loadFlagSecret();

function nowIso() {
  return new Date().toISOString();
}

function optionalIsoDate(value) {
  const input = String(value ?? '').trim();
  if (!input) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(input);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59) return null;
  if (zone !== 'Z' && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return null;
  const date = new Date(input);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function phaseFromSettings(settings, date = new Date()) {
  const configured = settings.competition_status || 'draft';
  if (configured !== 'running') return configured;
  if (settings.start_time && date < new Date(settings.start_time)) return 'registration';
  if (settings.end_time && date >= new Date(settings.end_time)) return 'ended';
  return 'running';
}

function publicContestConfig() {
  const settings = getSettings(db);
  const status = phaseFromSettings(settings);
  return {
    name: settings.competition_name,
    subtitle: settings.competition_subtitle,
    status,
    registrationOpen: settings.registration_open === 'true' && status === 'registration',
    bonuses: [Number(settings.bonus_first), Number(settings.bonus_second), Number(settings.bonus_third)],
    startTime: settings.start_time || null,
    endTime: settings.end_time || null,
    serverTime: nowIso(),
  };
}

function bootstrapAdmin() {
  const hasAdmin = db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (hasAdmin) return;
  const username = normalizeUsername(process.env.ADMIN_USERNAME || 'admin');
  const password = process.env.ADMIN_PASSWORD || randomToken(15);
  const email = normalizeEmail(process.env.ADMIN_EMAIL || 'admin@localhost.local');
  const realName = String(process.env.ADMIN_REAL_NAME || '赛事管理员').trim();
  const className = String(process.env.ADMIN_CLASS || '网络安全工作室').trim();
  db.prepare(`
    INSERT INTO users(username, username_key, class_name, real_name, email, email_key, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?)
  `).run(username, usernameKey(username), className, realName, email, email, hashPassword(password), nowIso());
  console.log('\n[NEXUS ARENA] 已创建初始管理员');
  console.log(`  用户名: ${username}`);
  console.log(`  密码:   ${password}`);
  console.log('  请登录后妥善保存，并通过 npm run admin 修改密码。\n');
}

bootstrapAdmin();

app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.disable('x-powered-by');
const httpsEnabled = String(process.env.APP_ORIGIN || '').startsWith('https:');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      scriptSrcAttr: ["'none'"],
      ...(httpsEnabled ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  hsts: httpsEnabled ? undefined : false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

function sameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const expected = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).host : req.get('host');
    if (new URL(origin).host !== expected) return res.status(403).json({ error: '请求来源校验失败' });
  } catch {
    return res.status(403).json({ error: '请求来源校验失败' });
  }
  return next();
}
app.use('/api', sameOrigin);

function parseSession(req, _res, next) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return next();
  const row = db.prepare(`
    SELECT s.id AS session_id, s.csrf_token, s.expires_at,
           u.id, u.username, u.real_name, u.class_name, u.email, u.role, u.disabled, u.avatar_url
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(digest(token), nowIso());
  if (row && !row.disabled) req.auth = row;
  return next();
}
app.use(parseSession);

function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: '请先登录' });
  return next();
}

function requireStaff(req, res, next) {
  if (!req.auth || !['admin', 'judge'].includes(req.auth.role)) return res.status(403).json({ error: '需要裁判权限' });
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  return next();
}

function requireParticipant(req, res, next) {
  if (!req.auth || req.auth.role !== 'participant') return res.status(403).json({ error: '仅参赛者可以提交 Flag' });
  return next();
}

function csrfGuard(req, res, next) {
  if (!req.auth || req.get('x-csrf-token') !== req.auth.csrf_token) return res.status(403).json({ error: '会话校验失败，请刷新页面' });
  return next();
}

function createLimiter(max, windowMs, keyBuilder) {
  const buckets = new Map();
  let requestsSinceCleanup = 0;
  return (req, res, next) => {
    const now = Date.now();
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup >= 100) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
      requestsSinceCleanup = 0;
    }
    const key = keyBuilder(req);
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
    return next();
  };
}

const registrationLimiter = createLimiter(100, 10 * 60 * 1000, (req) => `register:${req.ip}`);
const authIpLimiter = createLimiter(200, 10 * 60 * 1000, (req) => `auth-ip:${req.ip}`);
const loginAccountLimiter = createLimiter(10, 10 * 60 * 1000, (req) => `auth-account:${normalizeEmail(req.body?.identifier)}`);
const accountUpdateLimiter = createLimiter(20, 10 * 60 * 1000, (req) => `account-update:${req.auth.id}`);
const submitLimiter = createLimiter(30, 60 * 1000, (req) => `submit:${req.auth?.id || req.ip}`);

function setSession(res, userId) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash, csrf_token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(digest(token), csrfToken, userId, createdAt, expiresAt);
  const secureCookie = String(process.env.APP_ORIGIN || '').startsWith('https:');
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? 'strict' : 'lax',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
    path: '/',
  });
  return csrfToken;
}

function clearSession(req, res) {
  if (req.auth) db.prepare('DELETE FROM sessions WHERE id = ?').run(req.auth.session_id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function audit(req, action, detail = '') {
  db.prepare('INSERT INTO audit_log(actor_id, action, detail, ip_address, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.auth?.id || null, action, String(detail).slice(0, 1000), req.ip || '', nowIso());
}

function broadcast(type, details = {}) {
  const payload = `event: update\ndata: ${JSON.stringify({ type, ...details, at: nowIso() })}\n\n`;
  for (const client of sseClients) writeSse(client, payload);
}

function writeSse(client, payload) {
  if (client.destroyed || client.writableEnded) {
    sseClients.delete(client);
    return;
  }
  try {
    if (!client.write(payload)) {
      sseClients.delete(client);
      client.end();
    }
  } catch {
    sseClients.delete(client);
    client.destroy();
  }
}

function leaderboard(includePrivate = false) {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.real_name, u.class_name, u.email, u.role, u.disabled, u.avatar_url, u.created_at,
           COUNT(s.id) AS solve_count,
           COALESCE(SUM(s.base_awarded + s.bonus_awarded), 0) AS score,
           MAX(s.solved_at) AS last_solve
    FROM users u
    LEFT JOIN solves s ON s.user_id = u.id
    WHERE u.role = 'participant' AND u.disabled = 0
    GROUP BY u.id
    ORDER BY score DESC,
             CASE WHEN MAX(s.solved_at) IS NULL THEN 1 ELSE 0 END,
             last_solve ASC,
             u.username COLLATE NOCASE ASC
  `).all();
  return rows.map((row, index) => {
    const common = {
      rank: index + 1,
      username: row.username,
      score: Number(row.score),
      solveCount: Number(row.solve_count),
      lastSolve: row.last_solve,
      avatarUrl: row.avatar_url || '',
    };
    if (!includePrivate) return common;
    return {
      ...common,
      id: row.id,
      realName: row.real_name,
      className: row.class_name,
      email: row.email,
      role: row.role,
      disabled: Boolean(row.disabled),
      createdAt: row.created_at,
    };
  });
}

function accountDirectory() {
  return db.prepare(`
    SELECT u.id, u.username, u.real_name AS realName, u.class_name AS className,
           u.email, u.role, u.disabled, u.avatar_url AS avatarUrl, u.created_at AS createdAt,
           COUNT(s.id) AS solveCount,
           COALESCE(SUM(s.base_awarded + s.bonus_awarded), 0) AS score
    FROM users u
    LEFT JOIN solves s ON s.user_id = u.id
    GROUP BY u.id
    ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'judge' THEN 1 ELSE 2 END,
             u.username COLLATE NOCASE ASC
  `).all().map((row) => ({
    ...row,
    disabled: Boolean(row.disabled),
    solveCount: Number(row.solveCount),
    score: Number(row.score),
  }));
}

function ownProfile(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    realName: user.real_name,
    className: user.class_name,
    email: user.email,
    avatarUrl: user.avatar_url || '',
  };
}

function hasLoginIdentifierConflict(profile, excludedUserId = 0) {
  const keys = [usernameKey(profile.username), normalizeEmail(profile.email)];
  return Boolean(db.prepare(`
    SELECT 1 FROM users WHERE id != ? AND (username_key IN (?, ?) OR email_key IN (?, ?)) LIMIT 1
  `).get(excludedUserId, ...keys, ...keys));
}

app.get('/api/health', (_req, res) => res.json({ ok: true, time: nowIso() }));
app.get('/api/contest', (_req, res) => res.json(publicContestConfig()));

app.post('/api/auth/register', registrationLimiter, (req, res) => {
  const config = publicContestConfig();
  if (!config.registrationOpen) return res.status(403).json({ error: '当前未开放注册' });
  const validated = validateRegistration(req.body || {});
  if (validated.error) return res.status(400).json({ error: validated.error });
  const participantCount = db.prepare("SELECT COUNT(*) AS value FROM users WHERE role = 'participant'").get().value;
  if (participantCount >= MAX_PARTICIPANTS) return res.status(403).json({ error: '参赛账号数量已达上限，请联系管理员' });
  try {
    const result = db.transaction(() => {
      if (hasLoginIdentifierConflict(validated)) return null;
      return db.prepare(`
        INSERT INTO users(username, username_key, class_name, real_name, email, email_key, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'participant', ?)
      `).run(
        validated.username,
        usernameKey(validated.username),
        validated.className,
        validated.realName,
        validated.email,
        validated.email,
        hashPassword(validated.password),
        nowIso(),
      );
    })();
    if (!result) return res.status(409).json({ error: '用户名或邮箱已被使用' });
    const csrfToken = setSession(res, Number(result.lastInsertRowid));
    return res.status(201).json({ ok: true, csrfToken });
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: '用户名或邮箱已被使用' });
    throw error;
  }
});

app.post('/api/auth/login', authIpLimiter, loginAccountLimiter, (req, res) => {
  const identifier = String(req.body?.identifier || '').normalize('NFKC').trim();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username_key = ? OR email_key = ?').get(usernameKey(identifier), normalizeEmail(identifier));
  if (!user || user.disabled || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: '账号或密码错误' });
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  const csrfToken = setSession(res, user.id);
  return res.json({ ok: true, csrfToken });
});

app.post('/api/auth/logout', requireAuth, csrfGuard, (req, res) => {
  clearSession(req, res);
  return res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.auth) return res.json({ user: null });
  return res.json({
    user: ownProfile(req.auth),
    csrfToken: req.auth.csrf_token,
  });
});

app.patch('/api/auth/profile', requireAuth, csrfGuard, accountUpdateLimiter, (req, res) => {
  const validated = validateProfile(req.body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  if (!validPasswordLength(req.body.currentPassword)) return res.status(400).json({ error: '当前密码长度需为 8-128 位' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  if (!verifyPassword(req.body.currentPassword, user.password_hash)) return res.status(400).json({ error: '当前密码错误' });
  const previous = ownProfile(user);
  const changedFields = Object.keys(validated).filter((field) => validated[field] !== previous[field]);
  try {
    const updated = db.transaction(() => {
      if (hasLoginIdentifierConflict(validated, req.auth.id)) return false;
      db.prepare(`UPDATE users SET username = ?, username_key = ?, real_name = ?, class_name = ?, email = ?, email_key = ? WHERE id = ?`)
        .run(validated.username, usernameKey(validated.username), validated.realName, validated.className, validated.email, validated.email, req.auth.id);
      // Bound only audit snapshots so its 1000-character cap never cuts through JSON.
      audit(req, 'profile.update', JSON.stringify({ changedFields, previousUsername: user.username.slice(0, 64), username: validated.username.slice(0, 64) }));
      return true;
    })();
    if (!updated) return res.status(409).json({ error: '用户名或邮箱已被使用' });
  } catch (error) {
    if (String(error.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) return res.status(409).json({ error: '用户名或邮箱已被使用' });
    throw error;
  }
  broadcast('profile');
  return res.json({ ok: true, user: ownProfile(db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id)) });
});

app.post('/api/auth/password', requireAuth, csrfGuard, accountUpdateLimiter, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!validPasswordLength(currentPassword)) return res.status(400).json({ error: '当前密码长度需为 8-128 位' });
  if (!validPasswordLength(newPassword)) return res.status(400).json({ error: '新密码长度需为 8-128 位' });
  if (typeof confirmPassword !== 'string' || confirmPassword !== newPassword) return res.status(400).json({ error: '两次输入的新密码不一致' });
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.auth.id);
  if (!verifyPassword(currentPassword, user.password_hash)) return res.status(400).json({ error: '当前密码错误' });
  const passwordHash = hashPassword(newPassword);
  const csrfToken = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, req.auth.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.auth.id);
    audit(req, 'profile.password.update');
    return setSession(res, req.auth.id);
  })();
  return res.json({ ok: true, csrfToken });
});

app.get('/api/challenges', requireAuth, (req, res) => {
  const phase = phaseFromSettings(getSettings(db));
  const isStaff = ['admin', 'judge'].includes(req.auth.role);
  if (!isStaff && !['running', 'ended'].includes(phase)) return res.status(403).json({ error: '题目尚未开放' });
  const rows = db.prepare(`
    SELECT c.id, c.slug, c.title, c.category, c.description, c.base_score, c.target_url, c.active, c.sort_order,
           COUNT(DISTINCT s.id) AS solve_count,
           MAX(CASE WHEN s.user_id = ? THEN 1 ELSE 0 END) AS solved,
           MIN(CASE WHEN s.user_id = ? THEN s.solve_rank END) AS solve_rank
    FROM challenges c
    LEFT JOIN solves s ON s.challenge_id = c.id
    WHERE c.active = 1 OR ? = 1
    GROUP BY c.id
    ORDER BY c.sort_order, c.category, c.base_score, c.id
  `).all(req.auth.id, req.auth.id, isStaff ? 1 : 0);
  const fileQuery = db.prepare('SELECT id, display_name, size, sha256 FROM challenge_files WHERE challenge_id = ? ORDER BY id');
  return res.json(rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    description: row.description,
    baseScore: row.base_score,
    targetUrl: row.target_url,
    active: Boolean(row.active),
    solveCount: Number(row.solve_count),
    solved: Boolean(row.solved),
    solveRank: row.solve_rank,
    files: fileQuery.all(row.id).map((file) => ({
      id: file.id,
      name: file.display_name,
      size: file.size,
      sha256: file.sha256,
      url: `/api/files/${file.id}/download`,
    })),
  })));
});

app.get('/api/files/:id/download', requireAuth, (req, res) => {
  const phase = phaseFromSettings(getSettings(db));
  const isStaff = ['admin', 'judge'].includes(req.auth.role);
  if (!isStaff && !['running', 'ended'].includes(phase)) return res.status(403).json({ error: '附件尚未开放' });
  const file = db.prepare(`
    SELECT f.*, c.active FROM challenge_files f
    JOIN challenges c ON c.id = f.challenge_id
    WHERE f.id = ?
  `).get(Number(req.params.id));
  if (!file || (!file.active && !isStaff)) return res.status(404).json({ error: '附件不存在' });
  const filename = path.resolve(UPLOAD_ROOT, file.storage_key);
  if (!filename.startsWith(path.resolve(UPLOAD_ROOT) + path.sep) || !fs.existsSync(filename)) return res.status(404).json({ error: '附件不存在' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.display_name)}`);
  return res.sendFile(filename);
});

app.post('/api/challenges/:id/submit', requireAuth, requireParticipant, csrfGuard, submitLimiter, (req, res) => {
  const answer = String(req.body?.flag ?? '');
  if (!answer || answer.length > 512) return res.status(400).json({ error: '请输入有效 Flag' });
  let committed = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    const settings = getSettings(db);
    if (phaseFromSettings(settings) !== 'running') {
      db.exec('ROLLBACK');
      return res.status(403).json({ error: '比赛当前不接受提交' });
    }
    const challenge = db.prepare('SELECT * FROM challenges WHERE id = ? AND active = 1').get(Number(req.params.id));
    if (!challenge) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: '题目不存在' });
    }
    const submittedDigest = flagDigest(answer, FLAG_SECRET);
    const stamp = nowIso();
    if (!safeEqualHex(submittedDigest, challenge.flag_digest)) {
      db.prepare(`INSERT INTO submissions(user_id, challenge_id, answer_digest, is_correct, ip_address, created_at)
                  VALUES (?, ?, ?, 0, ?, ?)`)
        .run(req.auth.id, challenge.id, submittedDigest, req.ip || '', stamp);
      db.exec('COMMIT');
      committed = true;
      return res.status(400).json({ correct: false, error: 'Flag 不正确' });
    }
    const existing = db.prepare('SELECT solve_rank, base_awarded, bonus_awarded FROM solves WHERE user_id = ? AND challenge_id = ?')
      .get(req.auth.id, challenge.id);
    if (existing) {
      db.prepare(`INSERT INTO submissions(user_id, challenge_id, answer_digest, is_correct, ip_address, created_at)
                  VALUES (?, ?, ?, 1, ?, ?)`)
        .run(req.auth.id, challenge.id, submittedDigest, req.ip || '', stamp);
      db.exec('COMMIT');
      committed = true;
      return res.json({ correct: true, duplicate: true, place: existing.solve_rank, awarded: 0 });
    }
    const place = Number(db.prepare('SELECT COALESCE(MAX(solve_rank), 0) + 1 AS next_rank FROM solves WHERE challenge_id = ?').get(challenge.id).next_rank);
    const bonuses = [Number(settings.bonus_first), Number(settings.bonus_second), Number(settings.bonus_third)];
    const bonus = place <= 3 ? bonuses[place - 1] : 0;
    db.prepare(`INSERT INTO solves(user_id, challenge_id, solve_rank, base_awarded, bonus_awarded, solved_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.auth.id, challenge.id, place, challenge.base_score, bonus, stamp);
    db.prepare(`INSERT INTO submissions(user_id, challenge_id, answer_digest, is_correct, ip_address, created_at)
                VALUES (?, ?, ?, 1, ?, ?)`)
      .run(req.auth.id, challenge.id, submittedDigest, req.ip || '', stamp);
    db.exec('COMMIT');
    committed = true;
    // Announce only committed solves and public identity fields.
    broadcast('solve', {
      username: req.auth.username,
      challenge: challenge.title,
      place,
      awarded: challenge.base_score + bonus,
    });
    broadcast('scoreboard');
    return res.json({ correct: true, duplicate: false, place, bonus, awarded: challenge.base_score + bonus });
  } catch (error) {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    throw error;
  }
});

app.get('/api/leaderboard', (_req, res) => res.json({ rows: leaderboard(false), updatedAt: nowIso() }));

app.get('/api/activity', (_req, res) => {
  const rows = db.prepare(`
    SELECT u.username, c.title, s.solve_rank, s.solved_at
    FROM solves s JOIN users u ON u.id = s.user_id JOIN challenges c ON c.id = s.challenge_id
    WHERE u.role = 'participant' AND u.disabled = 0
    ORDER BY s.solved_at DESC, s.id DESC LIMIT 12
  `).all();
  return res.json(rows.map((row) => ({ username: row.username, challenge: row.title, place: row.solve_rank, at: row.solved_at })));
});

app.get('/api/announcements', (_req, res) => {
  const rows = db.prepare('SELECT id, title, content, pinned, created_at FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT 50').all();
  return res.json(rows.map((row) => ({ id: row.id, title: row.title, content: row.content, pinned: Boolean(row.pinned), createdAt: row.created_at })));
});

app.get('/api/events', (req, res) => {
  if (sseClients.size >= MAX_SSE_CLIENTS) return res.status(503).json({ error: '实时连接已达上限，请稍后重试' });
  const clientIp = req.ip || '';
  const ipConnections = [...sseClients].filter((client) => client.sseIp === clientIp).length;
  if (ipConnections >= MAX_SSE_PER_IP) return res.status(429).json({ error: '当前网络的实时连接过多' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.sseIp = clientIp;
  sseClients.add(res);
  const cleanup = () => sseClients.delete(res);
  req.on('close', cleanup);
  res.on('error', cleanup);
  writeSse(res, `event: ready\ndata: ${JSON.stringify({ at: nowIso() })}\n\n`);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

const AVATAR_MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function avatarSignatureMatches(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/gif') return buffer.subarray(0, 4).toString('ascii') === 'GIF8';
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

app.post('/api/auth/avatar', requireAuth, csrfGuard, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择头像图片' });
  const mimeType = String(req.file.mimetype || '').toLowerCase();
  const extension = AVATAR_MIME_EXTENSIONS[mimeType];
  if (!extension || !avatarSignatureMatches(req.file.buffer, mimeType)) return res.status(400).json({ error: '头像必须是有效的 JPG、PNG、WEBP 或 GIF 图片' });

  const avatarDirectory = path.join(UPLOAD_ROOT, 'avatars');
  fs.mkdirSync(avatarDirectory, { recursive: true });
  const filename = `${randomToken(18)}.${extension}`;
  const storagePath = path.join(avatarDirectory, filename);
  const avatarUrl = `/uploads/avatars/${filename}`;
  const previous = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.auth.id)?.avatar_url || '';
  fs.writeFileSync(storagePath, req.file.buffer, { flag: 'wx' });
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.auth.id);
  if (previous.startsWith('/uploads/avatars/')) {
    const oldPath = path.resolve(UPLOAD_ROOT, previous.slice('/uploads/'.length));
    if (oldPath.startsWith(path.resolve(avatarDirectory) + path.sep) && oldPath !== storagePath) {
      try { fs.rmSync(oldPath, { force: true }); } catch {}
    }
  }
  audit(req, 'profile.avatar.update', `bytes=${req.file.size};type=${mimeType}`);
  return res.json({ ok: true, avatarUrl });
});

app.get('/api/admin/overview', requireAuth, requireStaff, (req, res) => {
  const settings = getSettings(db);
  const counts = {
    participants: db.prepare("SELECT COUNT(*) AS value FROM users WHERE role = 'participant'").get().value,
    challenges: db.prepare('SELECT COUNT(*) AS value FROM challenges').get().value,
    solves: db.prepare('SELECT COUNT(*) AS value FROM solves').get().value,
    submissions: db.prepare('SELECT COUNT(*) AS value FROM submissions').get().value,
  };
  return res.json({ counts, settings, phase: phaseFromSettings(settings), leaderboard: leaderboard(true), users: accountDirectory() });
});

app.get('/api/admin/challenges', requireAuth, requireStaff, (_req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.slug, c.title, c.category, c.base_score, c.target_url, c.active, c.sort_order,
           COUNT(s.id) AS solve_count
    FROM challenges c LEFT JOIN solves s ON s.challenge_id = c.id
    GROUP BY c.id ORDER BY c.sort_order, c.id
  `).all();
  return res.json(rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    baseScore: row.base_score,
    targetUrl: row.target_url,
    active: Boolean(row.active),
    solveCount: Number(row.solve_count),
  })));
});

app.patch('/api/admin/challenges/:id', requireAuth, requireAdmin, csrfGuard, (req, res) => {
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: '仅支持修改题目启用状态' });
  const result = db.prepare('UPDATE challenges SET active = ?, updated_at = ? WHERE id = ?').run(req.body.active ? 1 : 0, nowIso(), Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: '题目不存在' });
  audit(req, 'challenge.visibility', `challenge=${req.params.id};active=${req.body.active}`);
  broadcast('challenges');
  return res.json({ ok: true });
});

app.post('/api/admin/challenges/import/preview', requireAuth, requireAdmin, csrfGuard, upload.single('package'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择题目包' });
  const preview = previewPackage(req.file);
  return res.json({ filename: req.file.originalname, count: preview.length, challenges: preview });
});

app.post('/api/admin/challenges/import/apply', requireAuth, requireAdmin, csrfGuard, upload.single('package'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择题目包' });
  const result = applyPackage({ db, file: req.file, actorId: req.auth.id, flagSecret: FLAG_SECRET, uploadRoot: UPLOAD_ROOT });
  audit(req, 'challenges.import', `job=${result.jobId};count=${result.imported}`);
  broadcast('challenges');
  return res.status(201).json(result);
});

app.get('/api/admin/users', requireAuth, requireStaff, (_req, res) => res.json(accountDirectory()));

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, csrfGuard, (req, res) => {
  const userId = Number(req.params.id);
  const target = db.prepare('SELECT id, role, disabled FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (userId === req.auth.id) return res.status(400).json({ error: '不能在此修改自己的权限或状态' });
  const role = req.body?.role ?? target.role;
  const disabled = req.body?.disabled ?? Boolean(target.disabled);
  if (!['participant', 'judge', 'admin'].includes(role) || typeof disabled !== 'boolean') return res.status(400).json({ error: '用户权限参数无效' });
  const removesActiveAdmin = target.role === 'admin' && !target.disabled && (role !== 'admin' || disabled);
  if (removesActiveAdmin) {
    const activeAdmins = db.prepare("SELECT COUNT(*) AS value FROM users WHERE role = 'admin' AND disabled = 0").get().value;
    if (activeAdmins <= 1) return res.status(400).json({ error: '必须保留至少一个可用管理员账号' });
  }
  db.prepare('UPDATE users SET role = ?, disabled = ? WHERE id = ?').run(role, disabled ? 1 : 0, userId);
  if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  audit(req, 'user.update', `user=${userId};role=${role};disabled=${disabled}`);
  return res.json({ ok: true });
});

app.put('/api/admin/settings', requireAuth, requireAdmin, csrfGuard, (req, res) => {
  const input = req.body || {};
  const status = String(input.competitionStatus || '');
  const allowedStatuses = ['draft', 'registration', 'running', 'paused', 'ended'];
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: '比赛状态无效' });
  const bonuses = [input.bonusFirst, input.bonusSecond, input.bonusThird].map(Number);
  if (bonuses.some((value) => !Number.isInteger(value) || value < 0 || value > 1000)) return res.status(400).json({ error: '加分需为 0-1000 的整数' });
  if (!(bonuses[0] >= bonuses[1] && bonuses[1] >= bonuses[2])) return res.status(400).json({ error: '第一、二、三名加分需依次递减' });
  const name = String(input.competitionName || '').trim();
  const subtitle = String(input.competitionSubtitle || '').trim();
  if (name.length < 2 || name.length > 80 || subtitle.length > 120) return res.status(400).json({ error: '比赛名称或副标题长度无效' });
  const startTime = optionalIsoDate(input.startTime);
  const endTime = optionalIsoDate(input.endTime);
  if (startTime === null || endTime === null) return res.status(400).json({ error: '请输入有效的比赛时间' });
  if (startTime && endTime && startTime >= endTime) return res.status(400).json({ error: '结束时间必须晚于开始时间' });
  const updated = setSettings(db, {
    competition_name: name,
    competition_subtitle: subtitle,
    competition_status: status,
    registration_open: Boolean(input.registrationOpen),
    bonus_first: bonuses[0],
    bonus_second: bonuses[1],
    bonus_third: bonuses[2],
    start_time: startTime,
    end_time: endTime,
  });
  audit(req, 'contest.settings', `status=${status};bonuses=${bonuses.join('/')}`);
  broadcast('contest');
  return res.json({ ok: true, settings: updated });
});

app.post('/api/admin/announcements', requireAuth, requireAdmin, csrfGuard, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const content = String(req.body?.content || '').trim();
  const pinned = Boolean(req.body?.pinned);
  if (title.length < 2 || title.length > 100 || content.length < 2 || content.length > 3000) return res.status(400).json({ error: '公告标题或内容长度无效' });
  const result = db.prepare('INSERT INTO announcements(title, content, pinned, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(title, content, pinned ? 1 : 0, req.auth.id, nowIso());
  audit(req, 'announcement.create', `announcement=${result.lastInsertRowid}`);
  broadcast('announcements');
  return res.status(201).json({ id: Number(result.lastInsertRowid) });
});

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

app.get('/api/admin/leaderboard.csv', requireAuth, requireStaff, (_req, res) => {
  const rows = leaderboard(true);
  const header = ['排名', '用户名', '姓名', '班级', '邮箱', '分数', '解题数', '最后得分时间'];
  const lines = [header, ...rows.map((row) => [row.rank, row.username, row.realName, row.className, row.email, row.score, row.solveCount, row.lastSolve || ''])]
    .map((line) => line.map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leaderboard-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send(`\uFEFF${lines.join('\r\n')}`);
});

app.get('/api/admin/audit', requireAuth, requireStaff, (_req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.action, a.detail, a.ip_address, a.created_at, u.username
    FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.id DESC LIMIT 100
  `).all();
  return res.json(rows);
});

app.use('/vendor/lucide', express.static(path.join(ROOT, 'node_modules', 'lucide', 'dist', 'umd')));
app.use('/uploads/avatars', express.static(path.join(UPLOAD_ROOT, 'avatars'), {
  dotfiles: 'deny',
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  fallthrough: false,
}));
app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const isAvatarRequest = _req.path === '/api/auth/avatar';
    return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? (isAvatarRequest ? '头像不能超过 2 MB' : '题目包不能超过 50 MB') : '文件上传失败' });
  }
  if (error instanceof ImportPackageError) return res.status(400).json({ error: error.message });
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) return res.status(400).json({ error: '请求数据不是有效的 JSON' });
  console.error(error);
  return res.status(500).json({ error: process.env.NODE_ENV === 'production' ? '服务器处理请求时发生错误' : error.message });
});

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso()), 60 * 60 * 1000).unref();
setInterval(() => {
  for (const client of sseClients) writeSse(client, ': keepalive\n\n');
}, 25 * 1000).unref();

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[NEXUS ARENA] http://localhost:${PORT}`);
  });
}

module.exports = { app, db, FLAG_SECRET };
