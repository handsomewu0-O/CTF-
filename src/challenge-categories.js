const CHALLENGE_CATEGORIES = Object.freeze([
  'web',
  'PWN',
  'misc',
  'Crypto',
  'Reverse',
  '数据安全',
  'AI安全',
]);

const CATEGORY_ALIASES = new Map([
  ['web', 'web'],
  ['pwn', 'PWN'],
  ['misc', 'misc'],
  ['crypto', 'Crypto'],
  ['cryptography', 'Crypto'],
  ['reverse', 'Reverse'],
  ['re', 'Reverse'],
  ['数据安全', '数据安全'],
  ['数据取证', '数据安全'],
  ['forensics', '数据安全'],
  ['forensic', '数据安全'],
  ['datasecurity', '数据安全'],
  ['ai安全', 'AI安全'],
  ['ai', 'AI安全'],
  ['aisecurity', 'AI安全'],
]);

function normalizeChallengeCategory(value) {
  const key = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
  return CATEGORY_ALIASES.get(key) || null;
}

module.exports = { CHALLENGE_CATEGORIES, normalizeChallengeCategory };
