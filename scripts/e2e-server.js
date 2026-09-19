const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'data', 'e2e-runtime');
if (!target.startsWith(path.join(root, 'data') + path.sep)) throw new Error('E2E 路径校验失败');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.PORT = '3197';
process.env.APP_ORIGIN = 'http://127.0.0.1:3197';
process.env.DB_PATH = path.join(target, 'arena.sqlite');
process.env.UPLOAD_ROOT = path.join(target, 'uploads');
process.env.FLAG_SECRET = 'e2e-only-secret-with-more-than-thirty-two-characters';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'E2E-Admin-Password-937!';
process.env.ADMIN_EMAIL = 'admin@example.test';

const { app, db } = require('../server');
db.prepare("UPDATE settings SET value = 'registration' WHERE key = 'competition_status'").run();
db.prepare("UPDATE settings SET value = 'true' WHERE key = 'registration_open'").run();

app.listen(3197, '127.0.0.1', () => {
  console.log('[E2E] http://127.0.0.1:3197');
});
