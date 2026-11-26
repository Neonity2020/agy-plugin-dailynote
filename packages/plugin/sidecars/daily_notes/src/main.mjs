import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NotesError,
  createNotesService,
  getLocalDateString,
  openDatabase,
} from '@daily-notes/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST_DIR = path.join(__dirname, 'dist');
const MAX_JSON_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB (covers 10 MB image + base64/multipart overhead)

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};
const TEXT_STATIC_EXTS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json']);

export class StandaloneResponse {
  constructor(body, { status = 200, contentType = 'text/plain; charset=utf-8', headers = {} } = {}) {
    this.body = body;
    this.status = status;
    this.contentType = contentType;
    this.headers = headers;
  }
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return STATIC_MIME[ext] || 'application/octet-stream';
}

function walkDistFiles(distDir) {
  const files = [];
  if (!distDir || !fs.existsSync(distDir)) return files;

  function visit(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        const rel = path.relative(distDir, fullPath).split(path.sep).join('/');
        files.push({ rel, fullPath });
      }
    }
  }

  visit(distDir);
  return files;
}

function decodeBase64Payload(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new NotesError('INVALID_INPUT', '缺少图片 base64 数据', 400);
  }
  const commaIdx = raw.indexOf(',');
  const base64Body = raw.startsWith('data:') && commaIdx >= 0 ? raw.slice(commaIdx + 1) : raw;
  const buf = Buffer.from(base64Body.trim(), 'base64');
  if (buf.length === 0) {
    throw new NotesError('INVALID_ATTACHMENT', '图片解码后为空', 400);
  }
  return buf;
}

function errorToResponse(ResponseClass, err) {
  if (err instanceof NotesError || (err && typeof err.code === 'string' && typeof err.status === 'number')) {
    const payload = {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
    return new ResponseClass(JSON.stringify(payload), {
      status: err.status || 400,
      contentType: 'application/json; charset=utf-8',
    });
  }

  console.error('[daily-notes sidecar] unexpected error:', err);
  return new ResponseClass(
    JSON.stringify({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: err?.message || '服务内部错误',
      },
    }),
    {
      status: 500,
      contentType: 'application/json; charset=utf-8',
    },
  );
}

/**
 * Create the shared Daily Notes sidecar service & exact-path route map
 * compatible with both Antigravity SidecarApp and Standalone HTTP.
 */
export function createSidecarCore({
  dataDir,
  distDir = DEFAULT_DIST_DIR,
  mode = 'standalone',
  ResponseClass = StandaloneResponse,
} = {}) {
  const dbCtx = openDatabase({ dataDir });
  const service = createNotesService(dbCtx);

  try {
    service.cleanupOrphanedAttachments();
  } catch (err) {
    console.error('[daily-notes sidecar] startup orphan GC warning:', err?.message || err);
  }

  function wrapJson(fn, status = 200) {
    return (data = {}) => {
      try {
        const result = fn(data || {});
        if (status === 200) {
          return { ok: true, data: result };
        }
        return new ResponseClass(JSON.stringify({ ok: true, data: result }), {
          status,
          contentType: 'application/json; charset=utf-8',
        });
      } catch (err) {
        return errorToResponse(ResponseClass, err);
      }
    };
  }

  const exactRoutes = {
    'GET /api/health': wrapJson(() => service.getHealth({ mode })),
    'GET /api/note': wrapJson((q) => service.getNote(q.date || getLocalDateString())),
    'GET /api/note/meta': wrapJson((q) => service.getNoteMeta(q.date || getLocalDateString())),
    'POST /api/note/save': wrapJson((body) =>
      service.saveNote(body.date || getLocalDateString(), {
        content_md: body.content_md,
        expected_revision: body.expected_revision,
        force: Boolean(body.force),
        editor: 'user',
      }),
    ),
    'POST /api/note/carry-over': wrapJson((body) =>
      service.carryOverTodos(body.date || getLocalDateString(), {
        action: body.action || 'apply',
        source_date: body.source_date,
      }),
    ),
    'POST /api/note/projects/add': wrapJson((body) =>
      service.linkProject(body.date || getLocalDateString(), {
        workspace_uri: body.workspace_uri,
        workspace_name: body.workspace_name,
        linked_by: 'user',
      }),
    ),
    'POST /api/note/projects/remove': wrapJson((body) =>
      service.unlinkProject(body.date || getLocalDateString(), body.workspace_uri),
    ),
    'GET /api/calendar': wrapJson((q) =>
      service.getCalendar({
        month: q.month || getLocalDateString().slice(0, 7),
        tag: q.tag || '',
        workspace_uri: q.workspace_uri || '',
      }),
    ),
    'GET /api/search': wrapJson((q) =>
      service.searchNotes({
        q: q.q || '',
        tag: q.tag || '',
        workspace_uri: q.workspace_uri || '',
        from: q.from || '',
        to: q.to || '',
        limit: q.limit,
        offset: q.offset,
      }),
    ),
    'GET /api/tags': wrapJson((q) => service.listTags({ q: q.q || '' })),
    'GET /api/projects': wrapJson(() => service.listAllProjects()),
    'GET /api/note/revisions': wrapJson((q) =>
      service.listRevisions(q.date || getLocalDateString(), { limit: q.limit }),
    ),
    'POST /api/note/revisions/restore': wrapJson((body) =>
      service.restoreRevision(body.date || getLocalDateString(), body.id, {
        expected_revision: body.expected_revision,
      }),
    ),
    'POST /api/attachment/upload': wrapJson((body) => {
      const buffer = decodeBase64Payload(body.data_base64);
      return service.saveAttachment({
        buffer,
        origName: body.orig_name || 'image.png',
        noteDate: body.note_date || null,
      });
    }, 201),
    'GET /api/attachment': (q = {}) => {
      try {
        const item = service.getAttachment(q.id);
        return new ResponseClass(item.buffer, {
          status: 200,
          contentType: item.mime_type,
          headers: {
            'Cache-Control': 'private, max-age=86400',
          },
        });
      } catch (err) {
        return errorToResponse(ResponseClass, err);
      }
    },
    'GET /api/note/export': (q = {}) => {
      try {
        const date = q.date || getLocalDateString();
        const frontmatter = q.frontmatter === '1' || q.frontmatter === 'true' || q.frontmatter === true;
        const exported = service.exportNote(date, { frontmatter });
        return new ResponseClass(exported.markdown, {
          status: 200,
          contentType: 'text/markdown; charset=utf-8',
          headers: {
            'Content-Disposition': `attachment; filename="${exported.filename}"`,
          },
        });
      } catch (err) {
        return errorToResponse(ResponseClass, err);
      }
    },
  };

  return {
    dbCtx,
    service,
    distDir,
    exactRoutes,
    close() {
      dbCtx.close();
    },
  };
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new NotesError('PAYLOAD_TOO_LARGE', `请求体超过大小限制 (${maxBytes} bytes)`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

async function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  const buf = await readRawBody(req, maxBytes);
  const text = buf.toString('utf-8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new NotesError('INVALID_JSON', 'JSON 请求体必须为对象', 400);
    }
    return parsed;
  } catch (err) {
    if (err instanceof NotesError) throw err;
    throw new NotesError('INVALID_JSON', 'JSON 请求体解析失败', 400);
  }
}

/**
 * Minimal RFC 7578 multipart/form-data parser using zero external libraries.
 */
function parseMultipartForm(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  if (!match) {
    throw new NotesError('INVALID_MULTIPART', '缺少 multipart boundary', 400);
  }
  const boundary = match[1] || match[2];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const headerSep = Buffer.from('\r\n\r\n');

  const fields = {};
  const files = {};

  let pos = buffer.indexOf(boundaryBuf);
  while (pos !== -1) {
    let partStart = pos + boundaryBuf.length;
    // Closing boundary "--boundary--"
    if (buffer.subarray(partStart, partStart + 2).equals(Buffer.from('--'))) {
      break;
    }
    if (buffer.subarray(partStart, partStart + 2).equals(Buffer.from('\r\n'))) {
      partStart += 2;
    }

    const nextBoundary = buffer.indexOf(boundaryBuf, partStart);
    if (nextBoundary === -1) break;

    // Trim trailing \r\n before next boundary
    let partEnd = nextBoundary;
    if (partEnd >= 2 && buffer[partEnd - 2] === 0x0d && buffer[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    }

    const headerEnd = buffer.indexOf(headerSep, partStart);
    if (headerEnd !== -1 && headerEnd < partEnd) {
      const headerText = buffer.subarray(partStart, headerEnd).toString('utf-8');
      const bodyBuf = buffer.subarray(headerEnd + 4, partEnd);
      const dispLine = headerText
        .split('\r\n')
        .find((line) => line.toLowerCase().startsWith('content-disposition:'));
      if (dispLine) {
        const nameMatch = /\bname="([^"]+)"/i.exec(dispLine);
        const fileMatch = /\bfilename="([^"]*)"/i.exec(dispLine);
        const typeLine = headerText
          .split('\r\n')
          .find((line) => line.toLowerCase().startsWith('content-type:'));
        const partContentType = typeLine ? typeLine.slice(typeLine.indexOf(':') + 1).trim() : '';

        if (nameMatch) {
          const fieldName = nameMatch[1];
          if (fileMatch) {
            files[fieldName] = {
              filename: fileMatch[1] || 'upload.bin',
              contentType: partContentType,
              buffer: Buffer.from(bodyBuf),
            };
          } else {
            fields[fieldName] = bodyBuf.toString('utf-8');
          }
        }
      }
    }

    pos = nextBoundary;
  }

  return { fields, files };
}

function sendResult(res, result) {
  if (result instanceof StandaloneResponse) {
    const headers = {
      'Content-Type': result.contentType,
      ...result.headers,
    };
    res.writeHead(result.status, headers);
    res.end(result.body);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(result));
}

function parseQueryObject(urlObj) {
  const out = {};
  for (const [k, v] of urlObj.searchParams.entries()) {
    out[k] = v;
  }
  return out;
}

/**
 * Start a standalone Node HTTP server supporting both SidecarApp exact-path routes
 * and full RESTful routes from docs/ARCHITECTURE.md §4 (plus dist/ static files).
 */
export async function startStandaloneServer({
  port = Number(process.env.DAILY_NOTES_PORT || process.env.PORT || 4175),
  host = '127.0.0.1',
  dataDir,
  distDir = DEFAULT_DIST_DIR,
} = {}) {
  const core = createSidecarCore({
    dataDir,
    distDir,
    mode: 'standalone',
    ResponseClass: StandaloneResponse,
  });

  const staticFiles = new Map();
  for (const file of walkDistFiles(distDir)) {
    staticFiles.set(`/${file.rel}`, file.fullPath);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const method = (req.method || 'GET').toUpperCase();
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = urlObj.pathname;
      const query = parseQueryObject(urlObj);

      // 1. Exact-path routes shared with SidecarApp
      const exactKey = `${method} ${pathname}`;
      const exactHandler = core.exactRoutes[exactKey];
      if (exactHandler) {
        if (method === 'GET') {
          sendResult(res, exactHandler(query));
          return;
        }
        const maxBytes = pathname === '/api/attachment/upload' ? MAX_UPLOAD_BYTES : MAX_JSON_BYTES;
        const body = await readJsonBody(req, maxBytes);
        sendResult(res, exactHandler({ ...query, ...body }));
        return;
      }

      // 2. Standalone /preload.js stub
      if (method === 'GET' && pathname === '/preload.js') {
        sendResult(
          res,
          new StandaloneResponse('/* Daily Notes standalone preload stub */\n', {
            status: 200,
            contentType: 'application/javascript; charset=utf-8',
          }),
        );
        return;
      }

      // 3. RESTful routes (docs/ARCHITECTURE.md §4)
      let match;

      if ((match = /^\/api\/notes\/([^/]+)$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        if (method === 'GET') {
          sendResult(res, { ok: true, data: core.service.getNote(date) });
          return;
        }
        if (method === 'PUT') {
          const body = await readJsonBody(req, MAX_JSON_BYTES);
          const data = core.service.saveNote(date, {
            content_md: body.content_md,
            expected_revision: body.expected_revision,
            force: Boolean(body.force),
            editor: 'user',
          });
          sendResult(res, { ok: true, data });
          return;
        }
      }

      if (method === 'GET' && (match = /^\/api\/notes\/([^/]+)\/meta$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        sendResult(res, { ok: true, data: core.service.getNoteMeta(date) });
        return;
      }

      if (method === 'POST' && (match = /^\/api\/notes\/([^/]+)\/carry-over$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, MAX_JSON_BYTES);
        const data = core.service.carryOverTodos(date, {
          action: body.action || 'apply',
          source_date: body.source_date,
        });
        sendResult(res, { ok: true, data });
        return;
      }

      if ((match = /^\/api\/notes\/([^/]+)\/projects$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        if (method === 'POST') {
          const body = await readJsonBody(req, MAX_JSON_BYTES);
          const data = core.service.linkProject(date, {
            workspace_uri: body.workspace_uri,
            workspace_name: body.workspace_name,
            linked_by: 'user',
          });
          sendResult(res, { ok: true, data });
          return;
        }
        if (method === 'DELETE') {
          const wsUri = query.workspace_uri || '';
          const data = core.service.unlinkProject(date, wsUri);
          sendResult(res, { ok: true, data });
          return;
        }
      }

      if (method === 'GET' && (match = /^\/api\/notes\/([^/]+)\/revisions$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        const data = core.service.listRevisions(date, { limit: query.limit });
        sendResult(res, { ok: true, data });
        return;
      }

      if (method === 'POST' && (match = /^\/api\/notes\/([^/]+)\/revisions\/([^/]+)\/restore$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        const revId = decodeURIComponent(match[2]);
        const body = await readJsonBody(req, MAX_JSON_BYTES);
        const data = core.service.restoreRevision(date, revId, {
          expected_revision: body.expected_revision,
        });
        sendResult(res, { ok: true, data });
        return;
      }

      if (method === 'POST' && pathname === '/api/attachments') {
        const contentType = String(req.headers['content-type'] || '');
        if (contentType.toLowerCase().includes('multipart/form-data')) {
          const rawBuf = await readRawBody(req, MAX_UPLOAD_BYTES);
          const { fields, files } = parseMultipartForm(rawBuf, contentType);
          const filePart = files.file;
          if (!filePart) {
            throw new NotesError('INVALID_INPUT', 'multipart 请求缺少 file 字段', 400);
          }
          const data = core.service.saveAttachment({
            buffer: filePart.buffer,
            origName: filePart.filename,
            noteDate: fields.note_date || null,
          });
          sendResult(
            res,
            new StandaloneResponse(JSON.stringify({ ok: true, data }), {
              status: 201,
              contentType: 'application/json; charset=utf-8',
            }),
          );
          return;
        }
        const body = await readJsonBody(req, MAX_UPLOAD_BYTES);
        const buffer = decodeBase64Payload(body.data_base64);
        const data = core.service.saveAttachment({
          buffer,
          origName: body.orig_name || 'image.png',
          noteDate: body.note_date || null,
        });
        sendResult(
          res,
          new StandaloneResponse(JSON.stringify({ ok: true, data }), {
            status: 201,
            contentType: 'application/json; charset=utf-8',
          }),
        );
        return;
      }

      if (method === 'GET' && (match = /^\/api\/attachments\/([^/]+)$/.exec(pathname))) {
        const id = decodeURIComponent(match[1]);
        const item = core.service.getAttachment(id);
        sendResult(
          res,
          new StandaloneResponse(item.buffer, {
            status: 200,
            contentType: item.mime_type,
            headers: { 'Cache-Control': 'private, max-age=86400' },
          }),
        );
        return;
      }

      if (method === 'GET' && (match = /^\/api\/notes\/([^/]+)\/export$/.exec(pathname))) {
        const date = decodeURIComponent(match[1]);
        const frontmatter = query.frontmatter === '1' || query.frontmatter === 'true';
        const exported = core.service.exportNote(date, { frontmatter });
        sendResult(
          res,
          new StandaloneResponse(exported.markdown, {
            status: 200,
            contentType: 'text/markdown; charset=utf-8',
            headers: {
              'Content-Disposition': `attachment; filename="${exported.filename}"`,
            },
          }),
        );
        return;
      }

      // 4. Static files from dist/
      if (method === 'GET') {
        const lookupPath = pathname === '/' ? '/index.html' : pathname;
        const targetFile = staticFiles.get(lookupPath);
        if (targetFile && fs.existsSync(targetFile)) {
          sendResult(
            res,
            new StandaloneResponse(fs.readFileSync(targetFile), {
              status: 200,
              contentType: getMimeType(targetFile),
            }),
          );
          return;
        }
      }

      sendResult(
        res,
        new StandaloneResponse(
          JSON.stringify({
            ok: false,
            error: { code: 'NOT_FOUND', message: `Route not found: ${method} ${pathname}` },
          }),
          { status: 404, contentType: 'application/json; charset=utf-8' },
        ),
      );
    } catch (err) {
      sendResult(res, errorToResponse(StandaloneResponse, err));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    core,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}`,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      core.close();
    },
  };
}

async function runMain() {
  let sdk = null;
  try {
    sdk = await import('sidecar_sdk');
  } catch (err) {
    if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
      console.error('[daily-notes sidecar] sidecar_sdk import failed:', err?.message || err);
    }
    sdk = null;
  }

  if (sdk?.SidecarApp && sdk?.Response) {
    const { SidecarApp, Response } = sdk;
    const core = createSidecarCore({
      distDir: DEFAULT_DIST_DIR,
      mode: 'sidecar_sdk',
      ResponseClass: Response,
    });

    const app = new SidecarApp();

    // Register built frontend assets explicitly for SidecarApp
    const indexPath = path.join(DEFAULT_DIST_DIR, 'index.html');
    app.page('/', () => {
      if (!fs.existsSync(indexPath)) {
        return '<!doctype html><html><body><p>Daily Notes frontend has not been built yet.</p></body></html>';
      }
      return fs.readFileSync(indexPath, 'utf-8');
    });

    for (const file of walkDistFiles(DEFAULT_DIST_DIR)) {
      if (file.rel === 'index.html') continue;
      const ext = path.extname(file.fullPath).toLowerCase();
      const mime = getMimeType(file.fullPath);
      const isText = TEXT_STATIC_EXTS.has(ext);
      app.api(
        `/${file.rel}`,
        () =>
          new Response(
            isText ? fs.readFileSync(file.fullPath, 'utf-8') : fs.readFileSync(file.fullPath),
            { contentType: mime },
          ),
        'GET',
      );
    }

    for (const [key, handler] of Object.entries(core.exactRoutes)) {
      const spaceIdx = key.indexOf(' ');
      const method = key.slice(0, spaceIdx);
      const routePath = key.slice(spaceIdx + 1);
      app.api(routePath, handler, method);
    }

    const shutdown = () => {
      try {
        core.close();
      } catch {
        // ignore close errors during exit
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await app.run();
    return;
  }

  // Fallback standalone HTTP server for local browser/dev/test runs
  const instance = await startStandaloneServer();
  console.error(`[daily-notes sidecar] standalone server listening at ${instance.baseUrl} (data: ${instance.core.dbCtx.dataDir})`);

  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function isExecutedDirectly() {
  if (!process.argv[1]) return false;
  const selfPath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(selfPath);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(selfPath);
  }
}

if (isExecutedDirectly()) {
  runMain().catch((err) => {
    console.error('[daily-notes sidecar] fatal startup error:', err);
    process.exit(1);
  });
}
