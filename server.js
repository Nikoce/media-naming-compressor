const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 4317);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const RUNTIME_DIR = path.resolve(process.env.RUNTIME_DIR || path.join(os.tmpdir(), 'media-naming-compressor'));
const UPLOAD_DIR = path.join(RUNTIME_DIR, 'uploads');
const OUTPUT_DIR = path.join(RUNTIME_DIR, 'outputs');
const DATA_DIR = path.join(RUNTIME_DIR, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const INPUT_TTL_MS = Number(process.env.INPUT_TTL_MS || 2 * 60 * 60 * 1000);
const OUTPUT_TTL_MS = Number(process.env.OUTPUT_TTL_MS || 60 * 60 * 1000);
const BATCH_LINK_TTL_MS = Number(process.env.BATCH_LINK_TTL_MS || 10 * 60 * 1000);
const MAX_UPLOAD_GB = Number(process.env.MAX_UPLOAD_GB || 5);
const MAX_UPLOAD_BYTES = Math.max(1, MAX_UPLOAD_GB) * 1024 * 1024 * 1024;

const outputDownloads = new Map();
const batchDownloads = new Map();

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

if (isPathInside(ROOT, RUNTIME_DIR)) {
  throw new Error('RUNTIME_DIR must be outside the application source directory.');
}

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, DATA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveBinary(pkgName, fallback) {
  try {
    const resolved = require(pkgName);
    if (typeof resolved === 'string') return resolved;
    if (resolved && typeof resolved.path === 'string') return resolved.path;
  } catch (_) {}
  return fallback;
}

const ffmpegPath = process.env.FFMPEG_PATH || resolveBinary('ffmpeg-static', 'ffmpeg');
const ffprobePath = process.env.FFPROBE_PATH || resolveBinary('ffprobe-static', 'ffprobe');

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = /^video\//i.test(file.mimetype) || /\.(mp4|mov|m4v|avi|mkv|webm|mpeg|mpg)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only video files are supported.'), ok);
  },
});

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

function safeText(value, fallback = '') {
  return String(value ?? fallback)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function formatYYMMDD(value) {
  const d = value ? new Date(Number(value)) : new Date();
  const valid = !Number.isNaN(d.getTime()) ? d : new Date();
  const yy = String(valid.getFullYear()).slice(-2);
  const mm = String(valid.getMonth() + 1).padStart(2, '0');
  const dd = String(valid.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function ratioCode(width, height) {
  if (!width || !height) return '';
  const g = gcd(width, height);
  let rw = Math.round(width / g);
  let rh = Math.round(height / g);
  const common = [
    [9, 16], [16, 9], [1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2], [9, 19], [19, 9], [9, 20], [20, 9]
  ];
  const actual = width / height;
  let best = [rw, rh];
  let bestDiff = Infinity;
  for (const pair of common) {
    const diff = Math.abs(actual - pair[0] / pair[1]);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = pair;
    }
  }
  if (bestDiff <= 0.025) [rw, rh] = best;
  return `${rw}${rh}`;
}

const iso639 = {
  eng: 'en', en: 'en',
  jpn: 'ja', ja: 'ja',
  zho: 'zh', chi: 'zh', cmn: 'zh', zh: 'zh',
  deu: 'de', ger: 'de', de: 'de',
  fra: 'fr', fre: 'fr', fr: 'fr',
  spa: 'es', es: 'es',
  kor: 'ko', ko: 'ko',
  por: 'pt', pt: 'pt',
  ita: 'it', it: 'it',
  rus: 'ru', ru: 'ru',
  ara: 'ar', ar: 'ar',
  hin: 'hi', hi: 'hi',
  tha: 'th', th: 'th',
  vie: 'vi', vi: 'vi',
  ind: 'id', id: 'id',
};

function normalizeLanguage(raw) {
  if (!raw) return '';
  const key = String(raw).toLowerCase().split(/[-_]/)[0];
  return iso639[key] || key.slice(0, 2);
}

function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
    const child = spawn(ffprobePath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `ffprobe exited with ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function readHistory() {
  try {
    return JSON.parse(await fsp.readFile(HISTORY_FILE, 'utf8'));
  } catch (_) {
    return { product: [], theme: [], maker: ['Niko'], productionTime: [], language: ['en', 'ja', 'zh'] };
  }
}

async function writeHistory(history) {
  await fsp.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

async function rememberValues(fields) {
  const history = await readHistory();
  const keys = ['product', 'theme', 'maker', 'productionTime', 'language'];
  for (const key of keys) {
    const value = safeText(fields[key]);
    if (!value) continue;
    const list = Array.isArray(history[key]) ? history[key] : [];
    history[key] = [value, ...list.filter((x) => x !== value)].slice(0, 30);
  }
  await writeHistory(history);
  return history;
}

function buildName({ date, product, theme, duration, ratio, language, maker, productionTime }) {
  const required = {
    date: safeText(date),
    product: safeText(product),
    theme: safeText(theme),
    duration: safeText(duration),
    ratio: safeText(ratio),
    language: safeText(language),
    maker: safeText(maker),
    productionTime: safeText(productionTime),
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing naming fields: ${missing.join(', ')}`);
  return `${required.date}_P-${required.product}_H-${required.theme}_VL-S-${required.duration}_S-${required.ratio}_L-${required.language}_D-${required.maker}_M-${required.productionTime}`;
}

function runFfmpeg(input, output, preset) {
  const profiles = {
    standard: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
    quality: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
    small: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '26', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
  };
  const profile = profiles[preset] || profiles.standard;
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', input, ...profile, output];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-5000) || `ffmpeg exited with ${code}`));
    });
  });
}

function encodedAttachmentName(name) {
  const ascii = safeText(name.replace(/\.mp4$/i, ''))
    .replace(/[^\x20-\x7E]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'video';
  const encoded = encodeURIComponent(name).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${ascii}.mp4"; filename*=UTF-8''${encoded}`;
}

async function deleteIfExists(filePath) {
  await fsp.unlink(filePath).catch(() => {});
}

async function cleanupDirectoryByAge(dir, maxAgeMs, now, protectedPaths = new Set()) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    if (protectedPaths.has(filePath)) continue;
    const stat = await fsp.stat(filePath).catch(() => null);
    if (stat && now - stat.mtimeMs > maxAgeMs) await deleteIfExists(filePath);
  }
}

async function cleanupExpired() {
  const now = Date.now();
  const activeOutputPaths = new Set();
  for (const [token, output] of outputDownloads.entries()) {
    if (output.expiresAt <= now) {
      outputDownloads.delete(token);
      await deleteIfExists(output.path);
    } else {
      activeOutputPaths.add(output.path);
    }
  }
  for (const [token, batch] of batchDownloads.entries()) {
    if (batch.expiresAt <= now) batchDownloads.delete(token);
  }

  const activeUploadPaths = new Set();
  const metaFiles = await fsp.readdir(UPLOAD_DIR).catch(() => []);
  for (const file of metaFiles.filter((name) => name.endsWith('.json'))) {
    const metaPath = path.join(UPLOAD_DIR, file);
    try {
      const record = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      if (now - Number(record.createdAt || 0) > INPUT_TTL_MS) {
        await deleteIfExists(record.path);
        await deleteIfExists(metaPath);
      } else {
        activeUploadPaths.add(record.path);
        activeUploadPaths.add(metaPath);
      }
    } catch (_) {
      await deleteIfExists(metaPath);
    }
  }

  await cleanupDirectoryByAge(UPLOAD_DIR, INPUT_TTL_MS, now, activeUploadPaths);
  await cleanupDirectoryByAge(OUTPUT_DIR, OUTPUT_TTL_MS, now, activeOutputPaths);
}

cleanupExpired().catch((err) => console.error('initial cleanup failed', err));
setInterval(() => {
  cleanupExpired().catch((err) => console.error('cleanup failed', err));
}, 15 * 60 * 1000).unref();

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: '0.5.0',
    platform: process.platform,
    maxUploadGb: MAX_UPLOAD_GB,
    storage: 'temporary',
  });
});

app.get('/api/history', async (_req, res, next) => {
  try {
    res.json(await readHistory());
  } catch (err) {
    next(err);
  }
});

app.delete('/api/history/:key', async (req, res, next) => {
  try {
    const allowed = new Set(['product', 'theme', 'maker', 'productionTime', 'language']);
    if (!allowed.has(req.params.key)) return res.status(400).json({ error: 'Unsupported history key.' });
    const history = await readHistory();
    history[req.params.key] = [];
    await writeHistory(history);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

app.post('/api/analyze', upload.single('video'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded.' });
  try {
    const probe = await probeVideo(req.file.path);
    const video = (probe.streams || []).find((s) => s.codec_type === 'video') || {};
    const audio = (probe.streams || []).find((s) => s.codec_type === 'audio') || {};
    const durationRaw = Number(probe.format?.duration || video.duration || 0);
    const duration = durationRaw > 0 ? Math.max(1, Math.round(durationRaw)) : '';
    const width = Number(video.width || 0);
    const height = Number(video.height || 0);
    const nameLangMatch = req.file.originalname.match(/(?:^|_)L-([a-z]{2,3})(?:_|\.|$)/i);
    const taggedLanguage = audio.tags?.language || probe.format?.tags?.language || '';
    const language = normalizeLanguage(nameLangMatch?.[1] || taggedLanguage);

    const token = crypto.randomUUID();
    const ext = path.extname(req.file.originalname) || '.mp4';
    const savedPath = path.join(UPLOAD_DIR, `${token}${ext.toLowerCase()}`);
    await fsp.rename(req.file.path, savedPath);

    const record = {
      token,
      path: savedPath,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      createdAt: Date.now(),
    };
    await fsp.writeFile(path.join(UPLOAD_DIR, `${token}.json`), JSON.stringify(record, null, 2), 'utf8');

    res.json({
      token,
      originalName: req.file.originalname,
      detected: {
        date: formatYYMMDD(),
        duration,
        width,
        height,
        resolution: width && height ? `${width}×${height}` : '',
        ratio: ratioCode(width, height),
        language,
        languageSource: language ? (nameLangMatch ? 'filename' : 'metadata') : 'unknown',
      },
    });
  } catch (err) {
    await deleteIfExists(req.file.path);
    next(err);
  }
});

app.post('/api/process', async (req, res, next) => {
  try {
    const { token, preset = 'standard', ...fields } = req.body || {};
    if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      return res.status(400).json({ error: 'Invalid upload token.' });
    }
    const metaPath = path.join(UPLOAD_DIR, `${token}.json`);
    const record = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    const inputPath = path.resolve(record.path);
    if (!isPathInside(UPLOAD_DIR, inputPath) || !fs.existsSync(inputPath)) {
      return res.status(404).json({ error: 'Uploaded file no longer exists.' });
    }

    const base = buildName(fields);
    const outputName = `${base}.mp4`;
    const outputToken = crypto.randomUUID();
    const outputPath = path.join(OUTPUT_DIR, `${outputToken}.mp4`);
    await runFfmpeg(inputPath, outputPath, preset);
    const history = await rememberValues(fields);

    outputDownloads.set(outputToken, {
      path: outputPath,
      outputName,
      createdAt: Date.now(),
      expiresAt: Date.now() + OUTPUT_TTL_MS,
    });

    res.json({
      ok: true,
      outputToken,
      outputName,
      downloadUrl: `/api/download/${outputToken}`,
      history,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/download/:token', async (req, res, next) => {
  try {
    const output = outputDownloads.get(req.params.token);
    if (!output || output.expiresAt <= Date.now() || !fs.existsSync(output.path)) {
      outputDownloads.delete(req.params.token);
      return res.status(404).send('下载文件已失效，请重新压制。');
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', encodedAttachmentName(output.outputName));
    fs.createReadStream(output.path).on('error', next).pipe(res);
  } catch (err) {
    next(err);
  }
});

app.post('/api/batch-download', async (req, res, next) => {
  try {
    const requested = Array.isArray(req.body?.outputTokens) ? req.body.outputTokens : [];
    const unique = [...new Set(requested.map((token) => String(token || '').trim()).filter(Boolean))];
    if (!unique.length) return res.status(400).json({ error: '没有可打包下载的文件。' });

    const files = [];
    for (const token of unique) {
      if (!/^[0-9a-f-]{36}$/i.test(token)) return res.status(400).json({ error: '非法下载令牌。' });
      const output = outputDownloads.get(token);
      if (!output || output.expiresAt <= Date.now() || !fs.existsSync(output.path)) {
        return res.status(404).json({ error: '部分输出已失效，请重新压制后再打包。' });
      }
      files.push({ name: output.outputName, path: output.path });
    }

    const token = crypto.randomUUID();
    const archiveName = `${formatYYMMDD()}_batch_${files.length}files.zip`;
    batchDownloads.set(token, { files, archiveName, expiresAt: Date.now() + BATCH_LINK_TTL_MS });
    res.json({ ok: true, archiveName, downloadUrl: `/api/batch-download/${token}` });
  } catch (err) {
    next(err);
  }
});

app.get('/api/batch-download/:token', (req, res, next) => {
  const batch = batchDownloads.get(req.params.token);
  if (!batch || batch.expiresAt < Date.now()) {
    batchDownloads.delete(req.params.token);
    return res.status(404).send('打包下载链接已失效，请重新点击打包下载。');
  }

  batchDownloads.delete(req.params.token);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${batch.archiveName}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') next(err);
  });
  archive.on('error', next);
  archive.pipe(res);
  for (const file of batch.files) archive.file(file.path, { name: file.name });
  archive.finalize().catch(next);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `单个文件超过 ${MAX_UPLOAD_GB}GB 上传限制。` });
  }
  const message = err?.message || 'Unexpected error.';
  res.status(500).json({ error: message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Media Naming & Compressor v0.5 listening on 0.0.0.0:${PORT}`);
  console.log(`Runtime dir: ${RUNTIME_DIR}`);
  console.log(`FFmpeg: ${ffmpegPath}`);
  console.log(`FFprobe: ${ffprobePath}`);
});
