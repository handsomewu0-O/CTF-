require('dotenv').config();

const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { openDatabase } = require('../src/database');
const { hashPassword, normalizeUsername, usernameKey } = require('../src/security');

async function main() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'arena.sqlite');
  const db = openDatabase(dbPath);
  const cli = readline.createInterface({ input: stdin, output: stdout });
  try {
    const username = normalizeUsername(await cli.question('管理员用户名 [admin]: ') || 'admin');
    const existing = db.prepare("SELECT id, username FROM users WHERE username_key = ? AND role = 'admin'").get(usernameKey(username));
    if (!existing) throw new Error(`未找到管理员账号：${username}`);
    const password = process.env.NEW_ADMIN_PASSWORD || await cli.question('输入新密码（至少 12 位）: ');
    if (password.length < 12 || password.length > 128) throw new Error('管理员密码长度需为 12-128 位');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    stdout.write(`管理员 ${existing.username} 的密码已更新，旧会话已失效。\n`);
  } finally {
    cli.close();
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
