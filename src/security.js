const crypto = require('node:crypto');

function normalizeUsername(value) {
  return String(value || '').normalize('NFKC').trim();
}

function usernameKey(value) {
  return normalizeUsername(value).toLocaleLowerCase('zh-CN');
}

function normalizeEmail(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, encoded) {
  try {
    const [algorithm, saltHex, hashHex] = String(encoded).split('$');
    if (algorithm !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function flagDigest(flag, secret) {
  const normalized = String(flag).replace(/\r?\n$/, '');
  return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
}

function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function validateProfile(input) {
  if (!input || typeof input.username !== 'string' || ['realName', 'className', 'email'].some((field) => (
    typeof input[field] !== 'string' || input[field].length > 512
  ))) return { error: '请填写有效的用户名、姓名、班级和邮箱' };
  const username = normalizeUsername(input.username);
  const realName = String(input.realName || '').normalize('NFKC').trim();
  const className = String(input.className || '').normalize('NFKC').trim();
  const email = normalizeEmail(input.email);

  if (!username) return { error: '请输入用户名' };
  if (realName.length < 2 || realName.length > 32) return { error: '姓名长度需为 2-32 个字符' };
  if (className.length < 2 || className.length > 64) return { error: '班级长度需为 2-64 个字符' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 128) return { error: '请输入有效邮箱地址' };
  return { username, realName, className, email };
}

function validPasswordLength(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

function validateRegistration(input) {
  const profile = validateProfile(input);
  if (profile.error) return profile;
  if (!validPasswordLength(input.password)) return { error: '密码长度需为 8-128 位' };
  return { ...profile, password: input.password };
}

module.exports = {
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
};
