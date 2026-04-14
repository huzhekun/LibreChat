import cors from 'cors';
import express from 'express';
import fs from 'fs/promises';
import fssync from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3085);
const API_KEY = process.env.CODE_API_KEY || process.env.LIBRECHAT_CODE_API_KEY || '';
const DATA_ROOT = process.env.DATA_ROOT || path.resolve(__dirname, '../data');
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 150 * 1024 * 1024);
const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS || 20_000);
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES || 1 * 1024 * 1024);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  if (req.url === '/v1') {
    req.url = '/';
  } else if (req.url.startsWith('/v1/')) {
    req.url = req.url.slice(3);
  }
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES } });

const entityRegex = /^[A-Za-z0-9_-]{1,40}$/;
const idRegex = /^[A-Za-z0-9_-]+$/;

const safeName = (value) => value.replace(/[^A-Za-z0-9_.-]/g, '_');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);

const actorId = (req, bodyUserId) => {
  const headerUser = req.header('User-Id') || req.header('x-user-id');
  const selected = headerUser || bodyUserId || '';
  return selected ? safeName(selected) : '';
};

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const readJson = async (filePath, fallback = null) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
};

const writeJson = async (filePath, data) => {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
};

const sessionPath = (sessionId) => path.join(DATA_ROOT, 'sessions', safeName(sessionId));
const metaPath = (sessionId) => path.join(sessionPath(sessionId), 'meta.json');
const filesPath = (sessionId) => path.join(sessionPath(sessionId), 'files');
const workspacePath = (sessionId) => path.join(sessionPath(sessionId), 'workspace');

const languageMap = {
  py: { version: ['python3', ['--version']], source: 'main.py', run: (args) => `python3 main.py ${args}`.trim() },
  js: { version: ['node', ['--version']], source: 'main.js', run: (args) => `node main.js ${args}`.trim() },
  ts: {
    version: ['node', ['--version']],
    source: 'main.ts',
    run: (args) => `npx --yes tsx main.ts ${args}`.trim(),
  },
  bash: { version: ['bash', ['--version']], source: 'main.sh', run: (args) => `bash main.sh ${args}`.trim() },
  sh: { version: ['bash', ['--version']], source: 'main.sh', run: (args) => `bash main.sh ${args}`.trim() },
  c: { version: ['gcc', ['--version']], source: 'main.c', run: (args) => `gcc main.c -O2 -o main && ./main ${args}`.trim() },
  cpp: { version: ['g++', ['--version']], source: 'main.cpp', run: (args) => `g++ main.cpp -O2 -o main && ./main ${args}`.trim() },
  go: { version: ['go', ['version']], source: 'main.go', run: (args) => `go run main.go ${args}`.trim() },
  rs: { version: ['rustc', ['--version']], source: 'main.rs', run: (args) => `rustc main.rs -O -o main && ./main ${args}`.trim() },
  java: { version: ['javac', ['-version']], source: 'Main.java', run: (args) => `javac Main.java && java Main ${args}`.trim() },
  php: { version: ['php', ['--version']], source: 'main.php', run: (args) => `php main.php ${args}`.trim() },
  r: { version: ['Rscript', ['--version']], source: 'main.R', run: (args) => `Rscript main.R ${args}`.trim() },
  d: { version: ['dmd', ['--version']], source: 'main.d', run: (args) => `dmd -of=main main.d && ./main ${args}`.trim() },
  f90: { version: ['gfortran', ['--version']], source: 'main.f90', run: (args) => `gfortran main.f90 -o main && ./main ${args}`.trim() },
};

const hasBinary = async (bin, args) =>
  new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', () => resolve(true));
  });

const auth = (req, res, next) => {
  if (!API_KEY) {
    return res.status(503).json({ error: 'Service unavailable', details: 'CODE_API_KEY is not configured' });
  }

  const headerKey = req.header('x-api-key') || req.header('X-API-Key');
  if (headerKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
};

app.use(auth);

const listFiles = async (sessionId) => {
  const meta = (await readJson(metaPath(sessionId), {})) || {};
  const entries = Object.values(meta.files || {});
  return entries.map((file) => ({ id: file.id, name: file.name, path: `${sessionId}/${file.id}` }));
};

const ensureSession = async ({ requestedSessionId, entityId, userId }) => {
  const finalId = requestedSessionId || (entityId ? `ent_${entityId}` : `sess_${nanoid(18)}`);
  const createdAt = new Date().toISOString();
  const meta = (await readJson(metaPath(finalId), null)) || {
    session_id: finalId,
    owner_user_id: userId,
    owner_user_hash: hash(userId),
    entity_id: entityId || null,
    createdAt,
    files: {},
  };

  if (!meta.owner_user_id) {
    meta.owner_user_id = userId;
    meta.owner_user_hash = hash(userId);
  }

  await ensureDir(filesPath(finalId));
  await ensureDir(workspacePath(finalId));
  await writeJson(metaPath(finalId), meta);
  return { sessionId: finalId, meta };
};

const canAccess = (meta, userId, entityId) => {
  if (!userId && !entityId) {
    return true;
  }

  if (entityId && meta.entity_id && entityId === meta.entity_id) {
    return true;
  }
  return meta.owner_user_hash === hash(userId);
};

const storeUpload = async ({ sessionId, uploadedFile }) => {
  const fileId = nanoid(18);
  const name = safeName(uploadedFile.originalname || uploadedFile.fieldname || `file-${fileId}`);
  const targetPath = path.join(filesPath(sessionId), `${fileId}__${name}`);
  await fs.writeFile(targetPath, uploadedFile.buffer);

  const stat = await fs.stat(targetPath);
  const etag = crypto.createHash('sha256').update(uploadedFile.buffer).digest('hex');
  const fileObj = {
    id: fileId,
    fileId,
    name,
    filename: name,
    session_id: sessionId,
    path: targetPath,
    size: stat.size,
    contentType: uploadedFile.mimetype || 'application/octet-stream',
    lastModified: stat.mtime.toISOString(),
    etag,
    metadata: {
      'content-type': uploadedFile.mimetype || 'application/octet-stream',
      'original-filename': uploadedFile.originalname || name,
    },
  };

  const meta = (await readJson(metaPath(sessionId), {})) || {};
  meta.files = meta.files || {};
  meta.files[fileId] = fileObj;
  meta.updatedAt = new Date().toISOString();
  await writeJson(metaPath(sessionId), meta);
  return fileObj;
};

const collectWorkspaceFiles = async (sessionId) => {
  const dir = workspacePath(sessionId);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (entry.name.startsWith('main.')) {
      continue;
    }

    const id = nanoid(18);
    const src = path.join(dir, entry.name);
    const dest = path.join(filesPath(sessionId), `${id}__${safeName(entry.name)}`);
    await fs.copyFile(src, dest);
    const buf = await fs.readFile(dest);
    const stat = await fs.stat(dest);
    const fileObj = {
      id,
      fileId: id,
      name: safeName(entry.name),
      filename: safeName(entry.name),
      session_id: sessionId,
      path: dest,
      size: stat.size,
      contentType: 'application/octet-stream',
      lastModified: stat.mtime.toISOString(),
      etag: crypto.createHash('sha256').update(buf).digest('hex'),
      metadata: {
        'content-type': 'application/octet-stream',
        'original-filename': entry.name,
      },
    };

    const meta = (await readJson(metaPath(sessionId), {})) || {};
    meta.files = meta.files || {};
    meta.files[id] = fileObj;
    await writeJson(metaPath(sessionId), meta);
    files.push({ id: fileObj.id, name: fileObj.name, path: `${sessionId}/${fileObj.id}` });
  }

  return files;
};

const spawnSandbox = ({ cmd, cwd }) =>
  new Promise((resolve) => {
    const shellCmd = `ulimit -t 20 -v 1048576 -f 20480; ${cmd}`;
    const child = spawn('bash', ['-c', shellCmd], {
      cwd,
      detached: true,
      env: { ...process.env, HOME: cwd, TMPDIR: cwd },
    });

    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;

    const start = process.hrtime.bigint();

    const appendWithLimit = (chunk, current, byteCounter) => {
      const text = chunk.toString('utf8');
      const incoming = Buffer.byteLength(text);
      if (byteCounter >= MAX_OUTPUT_BYTES) {
        return { text: current, bytes: byteCounter };
      }

      const remaining = MAX_OUTPUT_BYTES - byteCounter;
      const clipped = incoming > remaining ? text.slice(0, remaining) : text;
      return { text: current + clipped, bytes: byteCounter + Buffer.byteLength(clipped) };
    };

    child.stdout.on('data', (chunk) => {
      const next = appendWithLimit(chunk, stdout, outBytes);
      stdout = next.text;
      outBytes = next.bytes;
    });

    child.stderr.on('data', (chunk) => {
      const next = appendWithLimit(chunk, stderr, errBytes);
      stderr = next.text;
      errBytes = next.bytes;
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, EXEC_TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const end = process.hrtime.bigint();
      const wallTime = Number(end - start) / 1_000_000_000;
      resolve({
        stdout,
        stderr,
        code,
        signal: killed ? 'SIGKILL' : signal,
        wallTime,
        status: killed ? 'timeout' : code === 0 ? 'completed' : 'error',
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `${stderr}\n${error.message}`,
        code: null,
        signal: null,
        wallTime: 0,
        status: 'error',
      });
    });
  });

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/upload', upload.any(), async (req, res) => {
  const entityId = req.body.entity_id;
  if (entityId && !entityRegex.test(entityId)) {
    return res.status(400).json({ error: 'Invalid entity_id' });
  }

  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const userId = actorId(req);
  const { sessionId } = await ensureSession({ entityId, userId });
  const stored = await Promise.all(files.map((file) => storeUpload({ sessionId, uploadedFile: file })));

  return res.json({
    message: 'success',
    session_id: sessionId,
    files: stored.map((file) => ({
      ...file,
      fileId: file.id,
      filename: file.name,
    })),
  });
});

app.get('/download/:session_id/:fileId', async (req, res) => {
  const { session_id: sessionId, fileId } = req.params;
  const userId = actorId(req);
  const entityId = req.query.entity_id?.toString();
  const meta = await readJson(metaPath(sessionId), null);

  if (!meta || !meta.files || !meta.files[fileId]) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (!canAccess(meta, userId, entityId)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const file = meta.files[fileId];
  res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
  return fssync.createReadStream(file.path).pipe(res);
});

app.get('/files/:session_id', async (req, res) => {
  const { session_id: sessionId } = req.params;
  const detail = (req.query.detail || 'simple').toString().toLowerCase();
  const userId = actorId(req);
  const entityId = req.query.entity_id?.toString();
  const meta = await readJson(metaPath(sessionId), null);

  if (!meta || !canAccess(meta, userId, entityId)) {
    return res.json([]);
  }

  const values = Object.values(meta.files || {});
  if (detail === 'normalized') {
    return res.json(
      values.map((file) => ({
        id: file.id,
        session_id: file.session_id,
        name: file.metadata?.['original-filename'] || file.name,
      })),
    );
  }

  if (detail === 'full' || detail === 'detailed') {
    return res.json(
      values.map((file) => ({
        ...file,
        name: `${sessionId}/${file.id}`,
      })),
    );
  }

  return res.json(values.map((file) => ({ id: file.id, name: file.name, session_id: file.session_id })));
});

app.delete('/files/:session_id/:fileId', async (req, res) => {
  const { session_id: sessionId, fileId } = req.params;
  const userId = actorId(req);
  const entityId = req.query.entity_id?.toString();
  const meta = await readJson(metaPath(sessionId), null);

  if (!meta || !canAccess(meta, userId, entityId)) {
    return res.status(500).json({ error: 'Error deleting file', details: 'Unauthorized or unknown session' });
  }

  const file = meta.files?.[fileId];
  if (!file) {
    return res.status(500).json({ error: 'Error deleting file', details: 'Unknown file' });
  }

  await fs.rm(file.path, { force: true });
  delete meta.files[fileId];
  await writeJson(metaPath(sessionId), meta);
  return res.json({ message: 'File deleted successfully' });
});

app.post('/exec', async (req, res) => {
  const {
    code,
    lang,
    args: rawArgs = '',
    user_id: userIdInBody,
    entity_id: entityId,
    files = [],
    session_id: reqSession,
  } = req.body || {};
  const args = Array.isArray(rawArgs)
    ? rawArgs.map((arg) => String(arg)).join(' ')
    : typeof rawArgs === 'string'
      ? rawArgs
      : '';

  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'Invalid code' });
  }

  if (!languageMap[lang]) {
    return res.status(400).json({ error: `Unsupported language: ${lang}` });
  }

  if (entityId && (!entityRegex.test(entityId) || entityId.length > 40)) {
    return res.status(400).json({ error: 'Invalid entity_id' });
  }

  const userId = actorId(req, userIdInBody);
  const { sessionId, meta } = await ensureSession({ requestedSessionId: reqSession, entityId, userId });

  if (!canAccess(meta, userId, entityId)) {
    return res.status(401).json({ error: 'Unauthorized', details: 'Session ownership mismatch' });
  }

  for (const ref of files) {
    if (!ref || !idRegex.test(ref.id) || !idRegex.test(ref.session_id) || !ref.name) {
      return res.status(400).json({ error: 'Invalid files reference' });
    }

    const refMeta = await readJson(metaPath(ref.session_id), null);
    if (!refMeta || !canAccess(refMeta, userId, entityId)) {
      return res.status(401).json({ error: 'Unauthorized file reference' });
    }

    const file = refMeta.files?.[ref.id];
    if (!file) {
      return res.status(404).json({ error: 'Referenced file not found' });
    }

    const target = path.join(workspacePath(sessionId), safeName(ref.name));
    await fs.copyFile(file.path, target);
  }

  const languageConfig = languageMap[lang];
  const isAvailable = await hasBinary(languageConfig.version[0], languageConfig.version[1]);
  if (!isAvailable) {
    return res.status(503).json({
      error: 'Service unavailable',
      details: `Runtime/compiler not installed for ${lang}`,
    });
  }

  const src = path.join(workspacePath(sessionId), languageConfig.source);
  await fs.writeFile(src, code, 'utf8');

  const result = await spawnSandbox({ cmd: languageConfig.run(args), cwd: workspacePath(sessionId) });
  const emittedFiles = await collectWorkspaceFiles(sessionId);
  const allFiles = await listFiles(sessionId);
  const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();

  return res.json({
    run: {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      signal: result.signal,
      output,
      memory: null,
      message: result.status === 'timeout' ? 'Execution timed out' : null,
      status: result.status,
      cpu_time: null,
      wall_time: result.wallTime,
    },
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    output,
    status: result.status,
    language: lang,
    version: '1.0.0',
    session_id: sessionId,
    files: emittedFiles.length > 0 ? emittedFiles : allFiles,
  });
});

app.listen(PORT, async () => {
  await ensureDir(DATA_ROOT);
  console.log(`[code-api] listening on :${PORT}`);
});
