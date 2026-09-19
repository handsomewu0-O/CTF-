const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { parse: parseCsv } = require('csv-parse/sync');
const { flagDigest } = require('./security');
const { CHALLENGE_CATEGORIES, normalizeChallengeCategory } = require('./challenge-categories');

const MAX_CHALLENGES = 200;
const MAX_FILES = 100;
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;

class ImportPackageError extends Error {}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeArchivePath(value) {
  const candidate = String(value || '').replaceAll('\\', '/');
  if (!candidate || candidate.startsWith('/') || /^[a-zA-Z]:/.test(candidate)) return null;
  const parts = candidate.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function asBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', '是'].includes(String(value).trim().toLowerCase());
}

function normalizeTargetUrl(value, row) {
  const targetUrl = String(value || '').trim();
  if (!targetUrl) return '';
  if (targetUrl.length > 2048) throw new ImportPackageError(`第 ${row} 题靶场地址不能超过 2048 个字符`);
  if (/[\\\u0000-\u001f\u007f]/.test(targetUrl)) throw new ImportPackageError(`第 ${row} 题靶场地址无效`);

  if (targetUrl.startsWith('/')) {
    if (targetUrl.startsWith('//')) throw new ImportPackageError(`第 ${row} 题靶场地址不支持协议相对 URL`);
    try {
      const parsed = new URL(targetUrl, 'https://arena.local');
      if (parsed.origin !== 'https://arena.local') throw new Error('external origin');
    } catch {
      throw new ImportPackageError(`第 ${row} 题靶场地址无效`);
    }
    return targetUrl;
  }

  try {
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('unsupported target URL');
    }
    return parsed.href;
  } catch {
    throw new ImportPackageError(`第 ${row} 题靶场地址仅支持 HTTP、HTTPS 或站内绝对路径`);
  }
}

function parseManifestBuffer(buffer, extension) {
  if (extension === '.json') {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (Array.isArray(parsed)) return { version: 1, challenges: parsed };
    return parsed;
  }
  if (extension === '.csv') {
    return {
      version: 1,
      challenges: parseCsv(buffer, {
        bom: true,
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }),
    };
  }
  throw new ImportPackageError('仅支持 JSON、CSV 或包含清单的 ZIP 文件');
}

function readPackage(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension !== '.zip') {
    return { ...parseManifestBuffer(file.buffer, extension), archiveEntries: new Map() };
  }

  const zip = new AdmZip(file.buffer);
  const entries = zip.getEntries();
  if (entries.length > MAX_FILES + 5) throw new ImportPackageError(`压缩包文件数量不能超过 ${MAX_FILES + 5}`);

  let totalSize = 0;
  const archiveEntries = new Map();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const safeName = safeArchivePath(entry.entryName);
    if (!safeName) throw new ImportPackageError('压缩包包含不安全路径');
    const declaredSize = Number(entry.header.size || 0);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_UNCOMPRESSED) {
      throw new ImportPackageError('压缩包解压后不能超过 50 MB');
    }
    const data = entry.getData();
    if (data.length > MAX_UNCOMPRESSED || totalSize > MAX_UNCOMPRESSED - data.length) {
      throw new ImportPackageError('压缩包解压后不能超过 50 MB');
    }
    totalSize += data.length;
    archiveEntries.set(safeName, data);
  }

  const manifestName = ['challenges.json', 'challenges.csv'].find((name) => archiveEntries.has(name));
  if (!manifestName) throw new ImportPackageError('ZIP 根目录必须包含 challenges.json 或 challenges.csv');
  const manifest = parseManifestBuffer(archiveEntries.get(manifestName), path.extname(manifestName));
  return { ...manifest, archiveEntries };
}

function validatePackage(file) {
  let payload;
  try {
    payload = readPackage(file);
  } catch (error) {
    if (error instanceof ImportPackageError) throw error;
    throw new ImportPackageError('题目包无法解析，请检查文件格式');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ImportPackageError('题目包清单结构无效');
  if (Number(payload.version) !== 1) throw new ImportPackageError('不支持的题目包版本，请使用 version: 1');
  if (!Array.isArray(payload.challenges) || payload.challenges.length === 0) throw new ImportPackageError('题目清单不能为空');
  if (payload.challenges.length > MAX_CHALLENGES) throw new ImportPackageError(`单次最多导入 ${MAX_CHALLENGES} 道题`);

  const seenSlugs = new Set();
  const archiveHashes = new Map();
  const challenges = payload.challenges.map((raw, index) => {
    const row = index + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ImportPackageError(`第 ${row} 题结构无效`);
    const slug = String(raw.slug || raw.externalId || '').trim().toLowerCase();
    const title = String(raw.title || '').trim();
    const category = normalizeChallengeCategory(raw.category);
    const description = String(raw.description || '').trim();
    const baseScore = Number(raw.baseScore ?? raw.base_score ?? raw.score);
    const flag = String(raw.flag ?? '');
    const sortOrder = Number(raw.sortOrder ?? raw.sort_order ?? index);
    const targetUrl = normalizeTargetUrl(raw.targetUrl ?? raw.target_url ?? raw.target, row);

    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) throw new ImportPackageError(`第 ${row} 题 slug 需为 2-64 位小写字母、数字或连字符`);
    if (seenSlugs.has(slug)) throw new ImportPackageError(`题目包中存在重复 slug：${slug}`);
    seenSlugs.add(slug);
    if (title.length < 2 || title.length > 100) throw new ImportPackageError(`第 ${row} 题标题长度需为 2-100 个字符`);
    if (!category) throw new ImportPackageError(`第 ${row} 题分类仅支持：${CHALLENGE_CATEGORIES.join('、')}`);
    if (!description || description.length > 10000) throw new ImportPackageError(`第 ${row} 题描述不能为空且不能超过 10000 字符`);
    if (!Number.isInteger(baseScore) || baseScore < 1 || baseScore > 10000) throw new ImportPackageError(`第 ${row} 题分值需为 1-10000 的整数`);
    if (flag.length < 4 || flag.length > 256) throw new ImportPackageError(`第 ${row} 题 Flag 长度需为 4-256 位`);
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) throw new ImportPackageError(`第 ${row} 题排序值无效`);

    let fileRefs = raw.files || raw.attachments || [];
    if (typeof fileRefs === 'string') fileRefs = fileRefs.split(';').filter(Boolean).map((filePath) => ({ path: filePath.trim() }));
    if (raw.attachment && !fileRefs.length) fileRefs = [{ path: String(raw.attachment).trim() }];
    if (!Array.isArray(fileRefs)) throw new ImportPackageError(`第 ${row} 题附件字段必须是数组`);

    const files = fileRefs.map((item) => {
      if (typeof item !== 'string' && (!item || typeof item !== 'object' || Array.isArray(item))) {
        throw new ImportPackageError(`第 ${row} 题附件字段包含无效项目`);
      }
      const source = safeArchivePath(typeof item === 'string' ? item : item.path);
      if (!source || !payload.archiveEntries.has(source)) throw new ImportPackageError(`第 ${row} 题附件不存在或路径不安全`);
      const data = payload.archiveEntries.get(source);
      let hash = archiveHashes.get(source);
      if (!hash) {
        hash = sha256(data);
        archiveHashes.set(source, hash);
      }
      return {
        source,
        displayName: path.basename(String((typeof item === 'string' ? '' : item.name) || source)).slice(0, 160),
        data,
        hash,
      };
    });

    return {
      slug,
      title,
      category,
      description,
      baseScore,
      flag,
      active: asBoolean(raw.active, true),
      sortOrder,
      targetUrl,
      files,
    };
  });

  const totalFiles = challenges.reduce((count, challenge) => count + challenge.files.length, 0);
  if (totalFiles > MAX_FILES) throw new ImportPackageError(`附件总数不能超过 ${MAX_FILES}`);
  const totalReferencedSize = challenges.reduce((total, challenge) => (
    total + challenge.files.reduce((size, file) => size + file.data.length, 0)
  ), 0);
  if (totalReferencedSize > MAX_UNCOMPRESSED) throw new ImportPackageError('附件实际写入总量不能超过 50 MB');
  return challenges;
}

function previewPackage(file) {
  return validatePackage(file).map((challenge) => ({
    slug: challenge.slug,
    title: challenge.title,
    category: challenge.category,
    baseScore: challenge.baseScore,
    active: challenge.active,
    targetUrl: challenge.targetUrl,
    fileCount: challenge.files.length,
    hasFlag: true,
  }));
}

function applyPackage({ db, file, actorId, flagSecret, uploadRoot }) {
  const challenges = validatePackage(file);
  const existing = db.prepare(`SELECT slug FROM challenges WHERE slug IN (${challenges.map(() => '?').join(',')})`).all(...challenges.map((item) => item.slug));
  if (existing.length) throw new ImportPackageError(`以下题目已存在，导入已取消：${existing.map((item) => item.slug).join(', ')}`);

  const batchId = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const stageRoot = path.join(uploadRoot, `.staging-${batchId}`);
  const finalRoot = path.join(uploadRoot, batchId);
  fs.mkdirSync(stageRoot, { recursive: true });

  const now = new Date().toISOString();
  const sourceHash = sha256(file.buffer);
  const insertJob = db.prepare(`
    INSERT INTO import_jobs(actor_id, source_name, source_sha256, status, result_json, created_at)
    VALUES (?, ?, ?, 'applying', '{}', ?)
  `);
  const jobId = Number(insertJob.run(actorId, file.originalname, sourceHash, now).lastInsertRowid);

  const insertChallenge = db.prepare(`
    INSERT INTO challenges(slug, title, category, description, base_score, flag_digest, target_url, active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFile = db.prepare(`
    INSERT INTO challenge_files(challenge_id, display_name, storage_key, sha256, size, mime_type, created_at)
    VALUES (?, ?, ?, ?, ?, 'application/octet-stream', ?)
  `);

  const insertedIds = [];
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const challenge of challenges) {
      const result = insertChallenge.run(
        challenge.slug,
        challenge.title,
        challenge.category,
        challenge.description,
        challenge.baseScore,
        flagDigest(challenge.flag, flagSecret),
        challenge.targetUrl,
        challenge.active ? 1 : 0,
        challenge.sortOrder,
        now,
        now,
      );
      const challengeId = Number(result.lastInsertRowid);
      insertedIds.push(challengeId);
      const challengeDir = path.join(stageRoot, String(challengeId));
      fs.mkdirSync(challengeDir, { recursive: true });
      challenge.files.forEach((attachment, fileIndex) => {
        const storageName = `${fileIndex}-${crypto.randomBytes(8).toString('hex')}.bin`;
        fs.writeFileSync(path.join(challengeDir, storageName), attachment.data, { flag: 'wx' });
        const storageKey = `${batchId}/${challengeId}/${storageName}`;
        insertFile.run(challengeId, attachment.displayName, storageKey, attachment.hash, attachment.data.length, now);
      });
    }
    fs.renameSync(stageRoot, finalRoot);
    db.prepare('UPDATE import_jobs SET status = ?, result_json = ?, completed_at = ? WHERE id = ?')
      .run('complete', JSON.stringify({ imported: challenges.length }), now, jobId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.rmSync(finalRoot, { recursive: true, force: true });
    if (insertedIds.length) {
      const placeholders = insertedIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM challenges WHERE id IN (${placeholders})`).run(...insertedIds);
    }
    db.prepare('UPDATE import_jobs SET status = ?, result_json = ?, completed_at = ? WHERE id = ?')
      .run('failed', JSON.stringify({ error: '导入失败' }), new Date().toISOString(), jobId);
    throw error;
  }

  return { jobId, imported: challenges.length, titles: challenges.map((item) => item.title) };
}

module.exports = { applyPackage, ImportPackageError, previewPackage, validatePackage };
