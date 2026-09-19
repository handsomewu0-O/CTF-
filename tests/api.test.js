const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const AdmZip = require('adm-zip');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-arena-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(testRoot, 'arena.sqlite');
process.env.UPLOAD_ROOT = path.join(testRoot, 'uploads');
process.env.FLAG_SECRET = 'test-only-secret-value-with-at-least-32-characters';
process.env.ADMIN_USERNAME = 'rootadmin';
process.env.ADMIN_PASSWORD = 'Test-Admin-Password-937!';
process.env.ADMIN_EMAIL = 'root@example.test';
process.env.MAX_SSE_CLIENTS = '60';
process.env.MAX_SSE_PER_IP = '50';

const { app, db } = require('../server');
let server;
let baseUrl;

class Client {
  constructor() {
    this.cookie = '';
    this.csrf = '';
  }

  async request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (this.cookie) headers.set('Cookie', this.cookie);
    if (this.csrf && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', this.csrf);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${baseUrl}${url}`, { ...options, headers, redirect: 'manual' });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    if (body?.csrfToken) this.csrf = body.csrfToken;
    return { response, body };
  }

  async register(username, realName) {
    return this.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username,
        realName,
        className: '网络安全 2024-1 班',
        email: `${username}@example.test`,
        password: 'Contestant-Password-937!',
      }),
    });
  }

  async login(identifier, password) {
    return this.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) });
  }
}

function createSseReader(response) {
  return {
    reader: response.body.getReader(),
    decoder: new TextDecoder(),
    buffer: '',
    updates: [],
  };
}

async function nextSseUpdate(stream, timeoutMs = 3000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('SSE update timeout')), timeoutMs);
  });
  try {
    while (true) {
      if (stream.updates.length) return stream.updates.shift();
      const result = await Promise.race([stream.reader.read(), timeout]);
      if (result.done) throw new Error('SSE stream closed before update');
      stream.buffer += stream.decoder.decode(result.value, { stream: true });
      const frames = stream.buffer.split('\n\n');
      stream.buffer = frames.pop() || '';
      for (const frame of frames) {
        if (!frame.split('\n').some((line) => line === 'event: update')) continue;
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine) stream.updates.push(JSON.parse(dataLine.slice(6)));
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('keeps registration closed by default and only opens it during registration phase', async () => {
  const initialContest = await new Client().request('/api/contest');
  assert.equal(initialContest.body.status, 'draft');
  assert.equal(initialContest.body.registrationOpen, false);

  const closedByDefault = await new Client().register('closed_default', '默认关闭');
  assert.equal(closedByDefault.response.status, 403);

  db.prepare("UPDATE settings SET value = 'true' WHERE key = 'registration_open'").run();
  const closedDuringDraft = await new Client().register('closed_draft', '草稿关闭');
  assert.equal(closedDuringDraft.response.status, 403);

  db.prepare("UPDATE settings SET value = 'registration' WHERE key = 'competition_status'").run();
  const first = new Client();
  const result = await first.register('cyber_one', '张三');
  assert.equal(result.response.status, 201);

  const me = await first.request('/api/auth/me');
  assert.equal(me.body.user.username, 'cyber_one');
  assert.equal(me.body.user.realName, '张三');
  assert.equal(me.body.user.className, '网络安全 2024-1 班');

  const forbidden = await first.request('/api/admin/overview');
  assert.equal(forbidden.response.status, 403);

  const duplicate = new Client();
  const duplicateResult = await duplicate.register('CYBER_ONE', '李四');
  assert.equal(duplicateResult.response.status, 409);
});

test('imports a challenge, starts the competition, and awards first three solves', async () => {
  const admin = new Client();
  const login = await admin.login('rootadmin', 'Test-Admin-Password-937!');
  assert.equal(login.response.status, 200);

  const missingCsrf = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missingCsrf.status, 403);

  const invalidForm = new FormData();
  invalidForm.set('package', new Blob(['{'], { type: 'application/json' }), 'broken.json');
  const invalidPreview = await admin.request('/api/admin/challenges/import/preview', { method: 'POST', body: invalidForm });
  assert.equal(invalidPreview.response.status, 400);

  const manifest = {
    version: 1,
    challenges: [{
      slug: 'first-capture',
      title: 'First Capture',
      category: 'MISC',
      description: '用于验证前三名加分的测试题。',
      baseScore: 100,
      flag: 'flag{transactional_first_blood}',
      target_url: '/targets/first-capture',
      active: true,
      sortOrder: 1,
      files: [],
    }],
  };
  const previewForm = new FormData();
  previewForm.set('package', new Blob([JSON.stringify(manifest)], { type: 'application/json' }), 'challenges.json');
  const preview = await admin.request('/api/admin/challenges/import/preview', { method: 'POST', body: previewForm });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.count, 1);
  assert.equal(preview.body.challenges[0].category, 'misc');
  assert.equal(preview.body.challenges[0].targetUrl, '/targets/first-capture');

  const applyForm = new FormData();
  applyForm.set('package', new Blob([JSON.stringify(manifest)], { type: 'application/json' }), 'challenges.json');
  const applied = await admin.request('/api/admin/challenges/import/apply', { method: 'POST', body: applyForm });
  assert.equal(applied.response.status, 201);
  assert.equal(applied.body.imported, 1);

  const settings = await admin.request('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({
      competitionName: 'API 测试赛',
      competitionSubtitle: 'TRANSACTION TEST',
      competitionStatus: 'running',
      registrationOpen: false,
      bonusFirst: 30,
      bonusSecond: 20,
      bonusThird: 10,
      startTime: '',
      endTime: '',
    }),
  });
  assert.equal(settings.response.status, 200);

  const names = [
    ['runner_two', '李四'],
    ['runner_three', '王五'],
  ];
  const contestants = [];
  const first = new Client();
  await first.login('cyber_one', 'Contestant-Password-937!');
  contestants.push(first);

  // Registration is closed now, so staff creates remaining test contestants directly.
  const { hashPassword, usernameKey } = require('../src/security');
  for (const [username, realName] of names) {
    db.prepare(`INSERT INTO users(username, username_key, class_name, real_name, email, email_key, password_hash, role, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'participant', ?)`)
      .run(username, usernameKey(username), '网络安全 2024-1 班', realName, `${username}@example.test`, `${username}@example.test`, hashPassword('Contestant-Password-937!'), new Date().toISOString());
    const client = new Client();
    await client.login(username, 'Contestant-Password-937!');
    contestants.push(client);
  }

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  assert.equal(eventResponse.status, 200);
  const eventStream = createSseReader(eventResponse);
  try {
    for (const [index, contestant] of contestants.entries()) {
      const challenges = await contestant.request('/api/challenges');
      assert.equal(challenges.response.status, 200);
      assert.equal(challenges.body[0].category, 'misc');
      assert.equal(challenges.body[0].targetUrl, '/targets/first-capture');
      const submission = await contestant.request(`/api/challenges/${challenges.body[0].id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ flag: 'flag{transactional_first_blood}' }),
      });
      assert.equal(submission.response.status, 200);
      assert.equal(submission.body.place, index + 1);
      assert.equal(submission.body.bonus, [30, 20, 10][index]);
      const update = await nextSseUpdate(eventStream);
      assert.equal(update.type, 'solve');
      assert.equal(update.username, ['cyber_one', 'runner_two', 'runner_three'][index]);
      assert.equal(update.challenge, 'First Capture');
      assert.equal(update.place, index + 1);
      assert.equal(update.awarded, [130, 120, 110][index]);
      assert.equal('realName' in update, false);
      assert.equal('email' in update, false);
      assert.equal('className' in update, false);
      assert.equal((await nextSseUpdate(eventStream)).type, 'scoreboard');
    }
  } finally {
    await eventStream.reader.cancel();
  }

  const publicBoard = await new Client().request('/api/leaderboard');
  assert.deepEqual(publicBoard.body.rows.map((row) => row.score), [130, 120, 110]);
  assert.equal('realName' in publicBoard.body.rows[0], false);
  assert.equal('email' in publicBoard.body.rows[0], false);
  assert.equal('className' in publicBoard.body.rows[0], false);

  const privateBoard = await admin.request('/api/admin/overview');
  assert.equal(privateBoard.response.status, 200);
  assert.equal(privateBoard.body.leaderboard[0].realName, '张三');
  assert.equal(privateBoard.body.leaderboard[0].username, 'cyber_one');

  const promotedUser = privateBoard.body.users.find((user) => user.username === 'runner_three');
  const promoted = await admin.request(`/api/admin/users/${promotedUser.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ role: 'judge' }),
  });
  assert.equal(promoted.response.status, 200);
  const directory = await admin.request('/api/admin/users');
  assert.equal(directory.body.find((user) => user.username === 'runner_three').role, 'judge');
  assert.equal(directory.body.some((user) => user.role === 'admin'), true);
  assert.equal(directory.body.some((user) => user.role === 'judge'), true);
  assert.equal(directory.body.some((user) => user.role === 'participant'), true);

  const rootAdmin = directory.body.find((user) => user.username === 'rootadmin');
  const removeLastAdmin = await admin.request(`/api/admin/users/${rootAdmin.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(removeLastAdmin.response.status, 400);

  const runnerTwo = directory.body.find((user) => user.username === 'runner_two');
  const disabled = await admin.request(`/api/admin/users/${runnerTwo.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(disabled.response.status, 200);
  const boardAfterDisable = await new Client().request('/api/leaderboard');
  assert.equal(boardAfterDisable.body.rows.some((row) => row.username === 'runner_two'), false);

  const invalidDate = await admin.request('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({
      competitionName: 'API 测试赛',
      competitionSubtitle: 'TRANSACTION TEST',
      competitionStatus: 'running',
      registrationOpen: false,
      bonusFirst: 30,
      bonusSecond: 20,
      bonusThird: 10,
      startTime: 'not-a-date',
      endTime: '',
    }),
  });
  assert.equal(invalidDate.response.status, 400);
  assert.match(invalidDate.body.error, /有效的比赛时间/);
});

test('rejects duplicate scoring and stores no raw flag in submissions', async () => {
  const contestant = new Client();
  await contestant.login('cyber_one', 'Contestant-Password-937!');
  const challenges = await contestant.request('/api/challenges');
  const challengeId = challenges.body[0].id;
  const eventResponse = await fetch(`${baseUrl}/api/events`);
  const eventStream = createSseReader(eventResponse);
  try {
    const duplicate = await contestant.request(`/api/challenges/${challengeId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ flag: 'flag{transactional_first_blood}' }),
    });
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.awarded, 0);

    const incorrect = await contestant.request(`/api/challenges/${challengeId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ flag: 'flag{incorrect_answer}' }),
    });
    assert.equal(incorrect.response.status, 400);

    // A known later event proves neither submission queued a solve announcement.
    const admin = new Client();
    await admin.login('rootadmin', 'Test-Admin-Password-937!');
    const announcement = await admin.request('/api/admin/announcements', {
      method: 'POST',
      body: JSON.stringify({ title: 'SSE barrier', content: 'Validate event ordering.', pinned: false }),
    });
    assert.equal(announcement.response.status, 201);
    assert.equal((await nextSseUpdate(eventStream)).type, 'announcements');
  } finally {
    await eventStream.reader.cancel();
  }

  const solveCount = db.prepare('SELECT COUNT(*) AS value FROM solves WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('cyber_one').value;
  assert.equal(solveCount, 1);
  const rawLeak = db.prepare("SELECT COUNT(*) AS value FROM submissions WHERE answer_digest LIKE '%transactional_first_blood%'").get().value;
  assert.equal(rawLeak, 0);
});

test('allows a 50-person shared network login burst without the old 20-request lockout', async () => {
  const client = new Client();
  for (let index = 0; index < 50; index += 1) {
    const result = await client.login(`missing-user-${index}`, 'Wrong-Password-937!');
    assert.equal(result.response.status, 401);
  }

  for (let index = 0; index < 10; index += 1) {
    const result = await client.login('same-missing-user', 'Wrong-Password-937!');
    assert.equal(result.response.status, 401);
  }
  const accountLimited = await client.login('same-missing-user', 'Wrong-Password-937!');
  assert.equal(accountLimited.response.status, 429);
});

test('limits SSE connections per shared IP and across the server', async () => {
  app.set('trust proxy', 1);
  const streams = [];
  try {
    const sharedIpHeaders = { 'X-Forwarded-For': '198.51.100.10' };
    const sharedStreams = await Promise.all(Array.from({ length: 50 }, () => (
      fetch(`${baseUrl}/api/events`, { headers: sharedIpHeaders })
    )));
    assert.equal(sharedStreams.every((response) => response.status === 200), true);
    streams.push(...sharedStreams);

    const perIpLimited = await fetch(`${baseUrl}/api/events`, { headers: sharedIpHeaders });
    assert.equal(perIpLimited.status, 429);

    const remainingStreams = await Promise.all(Array.from({ length: 10 }, (_, index) => (
      fetch(`${baseUrl}/api/events`, { headers: { 'X-Forwarded-For': `203.0.113.${index + 1}` } })
    )));
    assert.equal(remainingStreams.every((response) => response.status === 200), true);
    streams.push(...remainingStreams);

    const globallyLimited = await fetch(`${baseUrl}/api/events`, { headers: { 'X-Forwarded-For': '203.0.113.200' } });
    assert.equal(globallyLimited.status, 503);
  } finally {
    await Promise.all(streams.map((response) => response.body.cancel()));
    app.set('trust proxy', false);
  }
});

test('accepts only complete, calendar-valid RFC3339 competition dates', async () => {
  const admin = new Client();
  const login = await admin.login('rootadmin', 'Test-Admin-Password-937!');
  assert.equal(login.response.status, 200);

  const settingsBody = (startTime) => ({
    competitionName: 'API 测试赛',
    competitionSubtitle: 'RFC3339 TEST',
    competitionStatus: 'running',
    registrationOpen: false,
    bonusFirst: 30,
    bonusSecond: 20,
    bonusThird: 10,
    startTime,
    endTime: '',
  });

  for (const invalid of [
    '2026-09-17T09:00+08:00',
    '2026-09-17T09:00:00',
    '2026-02-30T09:00:00Z',
    '2026-09-17T09:00:00+24:00',
  ]) {
    const result = await admin.request('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(settingsBody(invalid)),
    });
    assert.equal(result.response.status, 400, invalid);
  }

  const valid = await admin.request('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(settingsBody('2026-09-17T09:00:00+08:00')),
  });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.body.settings.start_time, '2026-09-17T01:00:00.000Z');
});

test('returns 400 for malformed package structures and excessive referenced ZIP bytes', async () => {
  const admin = new Client();
  const login = await admin.login('rootadmin', 'Test-Admin-Password-937!');
  assert.equal(login.response.status, 200);

  for (const [filename, content] of [
    ['null.json', 'null'],
    ['null-challenge.json', JSON.stringify({ version: 1, challenges: [null] })],
    ['null-file.json', JSON.stringify({
      version: 1,
      challenges: [{
        slug: 'null-file',
        title: 'Null File',
        category: 'MISC',
        description: '无效附件引用。',
        baseScore: 100,
        flag: 'flag{null_file}',
        files: [null],
      }],
    })],
    ['invalid-target.json', JSON.stringify({
      version: 1,
      challenges: [{
        slug: 'invalid-target',
        title: 'Invalid Target',
        category: 'web',
        description: '无效靶场地址。',
        baseScore: 100,
        flag: 'flag{invalid_target}',
        target: 'javascript:alert(1)',
      }],
    })],
    ['invalid-category.json', JSON.stringify({
      version: 1,
      challenges: [{
        slug: 'invalid-category',
        title: 'Invalid Category',
        category: 'OSINT',
        description: '无效分类。',
        baseScore: 100,
        flag: 'flag{invalid_category}',
      }],
    })],
  ]) {
    const form = new FormData();
    form.set('package', new Blob([content], { type: 'application/json' }), filename);
    const result = await admin.request('/api/admin/challenges/import/preview', { method: 'POST', body: form });
    assert.equal(result.response.status, 400, filename);
  }

  const invalidApplyForm = new FormData();
  invalidApplyForm.set('package', new Blob(['null'], { type: 'application/json' }), 'null.json');
  const invalidApply = await admin.request('/api/admin/challenges/import/apply', { method: 'POST', body: invalidApplyForm });
  assert.equal(invalidApply.response.status, 400);

  const manifest = {
    version: 1,
    challenges: Array.from({ length: 51 }, (_, index) => ({
      slug: `zip-limit-${index}`,
      title: `ZIP Limit ${index}`,
      category: 'MISC',
      description: '重复引用同一附件以验证实际写盘字节上限。',
      baseScore: 100,
      flag: `flag{zip_limit_${index}}`,
      files: [{ path: 'attachments/shared.bin' }],
    })),
  };
  const zip = new AdmZip();
  zip.addFile('challenges.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('attachments/shared.bin', Buffer.alloc(1024 * 1024, 0x61));
  const form = new FormData();
  form.set('package', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'repeated-file.zip');
  const result = await admin.request('/api/admin/challenges/import/preview', { method: 'POST', body: form });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /实际写入总量/);
});

test('uploads a validated avatar and exposes it on profile and leaderboard rows', async () => {
  const contestant = new Client();
  const login = await contestant.login('cyber_one', 'Contestant-Password-937!');
  assert.equal(login.response.status, 200);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.set('avatar', new Blob([png], { type: 'image/png' }), 'avatar.png');
  const uploaded = await contestant.request('/api/auth/avatar', { method: 'POST', body: form });
  assert.equal(uploaded.response.status, 200);
  assert.match(uploaded.body.avatarUrl, /^\/uploads\/avatars\/[A-Za-z0-9_-]+\.png$/);

  const me = await contestant.request('/api/auth/me');
  assert.equal(me.body.user.avatarUrl, uploaded.body.avatarUrl);

  const board = await new Client().request('/api/leaderboard');
  const row = board.body.rows.find((entry) => entry.username === 'cyber_one');
  assert.equal(row.avatarUrl, uploaded.body.avatarUrl);
  const image = await fetch(`${baseUrl}${uploaded.body.avatarUrl}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

async function accountFixture(username) {
  const { hashPassword, usernameKey } = require('../src/security');
  const password = `Original-${username}-937!`;
  const profile = { username, realName: '测试选手', className: '网络安全测试班', email: `${username}@example.test` };
  const result = db.prepare(`INSERT INTO users(username, username_key, class_name, real_name, email, email_key, password_hash, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'participant', ?)`).run(username, usernameKey(username), profile.className, profile.realName,
    profile.email, profile.email, hashPassword(password), new Date().toISOString());
  const client = new Client();
  assert.equal((await client.login(username, password)).response.status, 200);
  return { client, id: Number(result.lastInsertRowid), password, profile };
}

test('requires authentication, CSRF, valid profile fields and the current password for account changes', async () => {
  const { client, id, password, profile } = await accountFixture('profile_validation');
  for (const [url, method] of [['/api/auth/profile', 'PATCH'], ['/api/auth/password', 'POST']]) {
    assert.equal((await new Client().request(url, { method, body: '{}' })).response.status, 401);
    const missingCsrf = await fetch(`${baseUrl}${url}`, {
      method, headers: { Cookie: client.cookie, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(missingCsrf.status, 403);
  }
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  for (const patch of [
    { username: undefined }, { username: '' }, { username: ' \t\n ' }, { username: { name: 'not-a-string' } },
    { realName: '单' }, { className: null }, { email: 'invalid' },
    { currentPassword: 'short' }, { currentPassword: 'x'.repeat(129) }, { currentPassword: {} },
    { currentPassword: 'Incorrect-Password-937!' },
  ]) {
    const result = await client.request('/api/auth/profile', {
      method: 'PATCH', body: JSON.stringify({ ...profile, currentPassword: password, ...patch }),
    });
    assert.equal(result.response.status, 400, JSON.stringify(patch));
  }
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(id), before);
  const me = await client.request('/api/auth/me');
  assert.equal(me.body.user.email, profile.email);
});

test('normalizes profile conflicts and preserves identity, scores, avatar and role when renaming', async () => {
  const owner = await accountFixture('profile_owner');
  const target = await accountFixture('profile_target');
  const targetBefore = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  const payload = { ...owner.profile, currentPassword: owner.password };
  const fullwidth = (value) => value.replace(/[!-~]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0xfee0));
  for (const patch of [
    { username: target.profile.username.toUpperCase() }, { username: fullwidth(target.profile.username) },
    { email: target.profile.email.toUpperCase() }, { email: fullwidth(target.profile.email) },
  ]) {
    const conflict = await owner.client.request('/api/auth/profile', { method: 'PATCH', body: JSON.stringify({ ...payload, ...patch }) });
    assert.equal(conflict.response.status, 409);
  }
  const now = new Date().toISOString();
  const challenge = db.prepare(`INSERT INTO challenges(slug, title, category, description, base_score, flag_digest, created_at, updated_at)
    VALUES ('profile-score', 'Profile Score', 'misc', 'Preserve account scores', 111, 'test-digest', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO solves(user_id, challenge_id, solve_rank, base_awarded, bonus_awarded, solved_at)
    VALUES (?, ?, 1, 111, 30, ?)`).run(owner.id, challenge.lastInsertRowid, now);
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run('/uploads/avatars/keep.png', owner.id);
  const solveBefore = db.prepare('SELECT * FROM solves WHERE user_id = ?').all(owner.id);
  const eventStream = createSseReader(await fetch(`${baseUrl}/api/events`));
  let updated;
  try {
    updated = await owner.client.request('/api/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ ...payload, username: '  Renamed_Owner  ', realName: '修改姓名', className: '修改班级',
        email: '  RENAMED_OWNER@EXAMPLE.TEST  ', id: target.id, role: 'admin', disabled: true, avatarUrl: '/replaced.png' }),
    });
    assert.equal(updated.response.status, 200);
    const event = await nextSseUpdate(eventStream);
    assert.deepEqual(Object.keys(event).sort(), ['at', 'type']);
    assert.equal(event.type, 'profile');
  } finally {
    await eventStream.reader.cancel();
  }
  assert.deepEqual(updated.body.user, {
    id: owner.id, username: 'Renamed_Owner', realName: '修改姓名', className: '修改班级',
    email: 'renamed_owner@example.test', role: 'participant', avatarUrl: '/uploads/avatars/keep.png',
  });
  assert.equal((await owner.client.request('/api/auth/me')).body.user.id, owner.id);
  assert.deepEqual(db.prepare('SELECT * FROM solves WHERE user_id = ?').all(owner.id), solveBefore);
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id), targetBefore);
  assert.equal(db.prepare('SELECT disabled FROM users WHERE id = ?').get(owner.id).disabled, 0);
  const leaderboard = await new Client().request('/api/leaderboard');
  const renamed = leaderboard.body.rows.find((row) => row.username === 'Renamed_Owner');
  assert.equal(renamed.score, 141);
  assert.equal(renamed.solveCount, 1);
  assert.equal(leaderboard.body.rows.some((row) => row.username === owner.profile.username), false);
  assert.equal((await new Client().login(owner.profile.username, owner.password)).response.status, 401);
  assert.equal((await new Client().login('renamed_owner', owner.password)).response.status, 200);
  assert.equal((await new Client().login('renamed_owner@example.test', owner.password)).response.status, 200);
  const audit = db.prepare("SELECT detail FROM audit_log WHERE actor_id = ? AND action = 'profile.update'").get(owner.id);
  assert.deepEqual(JSON.parse(audit.detail).changedFields.sort(), ['className', 'email', 'realName', 'username']);
  assert.equal(audit.detail.includes(owner.password), false);
});

test('validates a password change, revokes every old session and keeps the new current session authenticated', async () => {
  const { digest, randomToken, verifyPassword } = require('../src/security');
  const owner = await accountFixture('password_owner');
  const newPassword = 'Updated-Password-937!';
  const originalHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(owner.id).password_hash;
  const validPayload = { currentPassword: owner.password, newPassword, confirmPassword: newPassword };
  for (const patch of [
    { currentPassword: 'Wrong-Password-937!' }, { currentPassword: [] }, { currentPassword: 'x'.repeat(129) },
    { newPassword: 'short', confirmPassword: 'short' }, { newPassword: 'x'.repeat(129), confirmPassword: 'x'.repeat(129) },
    { newPassword: {}, confirmPassword: {} }, { confirmPassword: 'Not-Matching-937!' }, { confirmPassword: undefined },
  ]) {
    const result = await owner.client.request('/api/auth/password', { method: 'POST', body: JSON.stringify({ ...validPayload, ...patch }) });
    assert.equal(result.response.status, 400);
  }
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(owner.id).password_hash, originalHash);
  const previousClient = new Client();
  previousClient.cookie = owner.client.cookie;
  previousClient.csrf = owner.client.csrf;
  const otherClient = new Client();
  const otherToken = randomToken();
  otherClient.cookie = `arena_session=${otherToken}`;
  otherClient.csrf = randomToken();
  db.prepare('INSERT INTO sessions(token_hash, csrf_token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(digest(otherToken), otherClient.csrf, owner.id, new Date().toISOString(), new Date(Date.now() + 60000).toISOString());
  assert.equal((await otherClient.request('/api/auth/me')).body.user.id, owner.id);
  const updated = await owner.client.request('/api/auth/password', { method: 'POST', body: JSON.stringify(validPayload) });
  assert.equal(updated.response.status, 200);
  assert.notEqual(owner.client.cookie, previousClient.cookie);
  assert.notEqual(owner.client.csrf, previousClient.csrf);
  assert.equal((await owner.client.request('/api/auth/me')).body.user.id, owner.id);
  assert.equal((await previousClient.request('/api/auth/me')).body.user, null);
  assert.equal((await otherClient.request('/api/auth/me')).body.user, null);
  assert.equal((await previousClient.request('/api/auth/password', { method: 'POST', body: JSON.stringify(validPayload) })).response.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(owner.id).count, 1);
  const passwordHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(owner.id).password_hash;
  assert.match(passwordHash, /^scrypt\$/);
  assert.equal(verifyPassword(owner.password, passwordHash), false);
  assert.equal(verifyPassword(newPassword, passwordHash), true);
  assert.equal((await owner.client.request('/api/auth/logout', { method: 'POST' })).response.status, 200);
  assert.equal((await new Client().login(owner.profile.username, owner.password)).response.status, 401);
  assert.equal((await new Client().login(owner.profile.username, newPassword)).response.status, 200);
  const audits = db.prepare('SELECT action, detail FROM audit_log WHERE actor_id = ?').all(owner.id);
  assert.equal(audits.some((entry) => entry.action === 'profile.password.update'), true);
  assert.equal(JSON.stringify(audits).includes(owner.password), false);
  assert.equal(JSON.stringify(audits).includes(newPassword), false);
});

test('shares the account change verification limit across profile and password requests per account', async () => {
  const owner = await accountFixture('account_limited');
  const validPayload = { currentPassword: 'Incorrect-Password-937!', newPassword: 'Replacement-937!', confirmPassword: 'Replacement-937!' };
  for (let index = 0; index < 20; index += 1) {
    const profileRequest = index % 2 === 0;
    const result = await owner.client.request(profileRequest ? '/api/auth/profile' : '/api/auth/password', {
      method: profileRequest ? 'PATCH' : 'POST',
      body: JSON.stringify(profileRequest ? { ...owner.profile, currentPassword: validPayload.currentPassword } : validPayload),
    });
    assert.equal(result.response.status, 400);
  }
  assert.equal((await owner.client.request('/api/auth/password', { method: 'POST', body: JSON.stringify(validPayload) })).response.status, 429);
  const other = await accountFixture('account_unlimited');
  const otherUpdate = await other.client.request('/api/auth/profile', {
    method: 'PATCH', body: JSON.stringify({ ...other.profile, currentPassword: other.password }),
  });
  assert.equal(otherUpdate.response.status, 200);
});

test('registers and authenticates nonblank usernames without character or length restrictions', async () => {
  const previousSettings = db.prepare("SELECT key, value FROM settings WHERE key IN ('competition_status', 'registration_open')").all();
  db.prepare("UPDATE settings SET value = 'registration' WHERE key = 'competition_status'").run();
  db.prepare("UPDATE settings SET value = 'true' WHERE key = 'registration_open'").run();
  const baseProfile = { realName: '自由选手', className: '网络安全测试班', password: 'Flexible-Password-937!' };
  const register = (username, email) => new Client().request('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ ...baseProfile, username, email }),
  });
  try {
    const usernames = ['N', 'Nu!L', '选手 One + 二', '<img src=x onerror=alert(1)>', '旗手 🛡️', `${'长'.repeat(600)} Nu!L`];
    for (const [index, username] of usernames.entries()) {
      const email = `flexible-registration-${index}@example.test`;
      assert.equal((await register(`  ${username}  `, email)).response.status, 201);
      const client = new Client();
      assert.equal((await client.login(username, baseProfile.password)).response.status, 200);
      const me = await client.request('/api/auth/me');
      assert.equal(me.body.user.username, username);
      assert.equal(me.body.user.email, email);
      assert.equal((await client.login(email, baseProfile.password)).response.status, 200);
      assert.equal((await client.request('/api/auth/me')).body.user.id, me.body.user.id);
    }
    for (const username of [undefined, null, 1, {}, [], '', ' \t\r\n ', '\u3000']) {
      assert.equal((await register(username, 'flexible-invalid@example.test')).response.status, 400);
    }
    assert.equal((await register('Ｎｕ！Ｌ', 'flexible-duplicate@example.test')).response.status, 409);
    assert.equal((await register('nu!l', 'flexible-duplicate@example.test')).response.status, 409);

    const ownAddress = 'flexible-own-address@example.test';
    assert.equal((await register(ownAddress, ownAddress)).response.status, 201);
    assert.equal((await new Client().login(ownAddress, baseProfile.password)).response.status, 200);
    assert.equal((await register('FLEXIBLE-REGISTRATION-0@EXAMPLE.TEST', 'flexible-cross-name@example.test')).response.status, 409);
    assert.equal((await register('flexible-cross-email@example.test', 'flexible-owner@example.test')).response.status, 201);
    assert.equal((await register('different account', 'FLEXIBLE-CROSS-EMAIL@EXAMPLE.TEST')).response.status, 409);
  } finally {
    for (const { key, value } of previousSettings) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key);
  }
});

test('edits unrestricted usernames while preserving account identity and valid bounded audit JSON', async () => {
  const owner = await accountFixture('flexible_profile');
  const usernames = ['单', 'Nu!L + 选手 🛡️', `${'"'.repeat(600)} 长用户名`, `${'\u0001'.repeat(600)} Audit`];
  for (const username of usernames) {
    const updated = await owner.client.request('/api/auth/profile', {
      method: 'PATCH', body: JSON.stringify({ ...owner.profile, username, currentPassword: owner.password }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.user.id, owner.id);
    assert.equal(updated.body.user.username, username);
    assert.equal((await owner.client.login(username, owner.password)).response.status, 200);
    assert.equal((await owner.client.request('/api/auth/me')).body.user.username, username);
  }
  const audits = db.prepare("SELECT detail FROM audit_log WHERE actor_id = ? AND action = 'profile.update' ORDER BY id").all(owner.id);
  assert.equal(audits.length, usernames.length);
  for (const { detail } of audits) {
    const parsed = JSON.parse(detail);
    assert.deepEqual(parsed.changedFields, ['username']);
    assert.equal(detail.length <= 1000, true);
    assert.equal(parsed.username.length <= 64, true);
    assert.equal(parsed.previousUsername.length <= 64, true);
  }
  assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(owner.id).username, usernames.at(-1));
});

test('prevents username and email cross-account collisions during profile changes', async () => {
  const owner = await accountFixture('identifier_owner');
  const target = await accountFixture('identifier_target');
  const payload = { ...owner.profile, currentPassword: owner.password };
  const update = (patch) => owner.client.request('/api/auth/profile', {
    method: 'PATCH', body: JSON.stringify({ ...payload, ...patch }),
  });
  assert.equal((await update({ username: target.profile.email.toUpperCase() })).response.status, 409);
  assert.equal((await update({ username: owner.profile.email })).response.status, 200);
  assert.equal((await owner.client.login(owner.profile.email, owner.password)).response.status, 200);
  assert.equal((await owner.client.request('/api/auth/me')).body.user.id, owner.id);

  const addressUsername = 'identifier-username@example.test';
  const targetUpdated = await target.client.request('/api/auth/profile', {
    method: 'PATCH', body: JSON.stringify({ ...target.profile, username: addressUsername, currentPassword: target.password }),
  });
  assert.equal(targetUpdated.response.status, 200);
  assert.equal((await update({ email: addressUsername.toUpperCase() })).response.status, 409);
  assert.equal((await owner.client.request('/api/auth/me')).body.user.username, owner.profile.email);
  assert.equal((await target.client.login(addressUsername, target.password)).response.status, 200);
  assert.equal((await target.client.request('/api/auth/me')).body.user.id, target.id);
});
