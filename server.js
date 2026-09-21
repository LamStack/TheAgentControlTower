import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rooms } from './src/rooms.js';
import { HttpError } from './src/util.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const MAX_BODY = 8 * 1024;
const MAX_STREAMS_PER_ROOM = 25;
const ROOM_RE = /^[a-z0-9-]{4,40}$/;
const ID_RE = /^[a-z0-9-]{2,40}$/;

const sanitizeOperator = (h) => {
  const s = String(h ?? '').replace(/[^\w .@-]/g, '').trim().slice(0, 40);
  return `operator:${s || 'operator'}`;
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object');
  }
}

function openStream(req, res, tower) {
  if (tower.subs.size >= MAX_STREAMS_PER_ROOM) throw new HttpError(503, 'Too many viewers in this room');
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const write = (chunk) => { if (!res.writableEnded && !res.destroyed) res.write(chunk); };
  const send = (event, data, id) => write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write('retry: 2000\n\n');
  const last = Number(req.headers['last-event-id']);
  send('state', tower.snapshot());
  for (const ev of tower.eventsSince(Number.isFinite(last) ? last : tower.seq - 80)) send('event', ev, ev.seq);

  let timer = null;
  const unsubscribe = tower.subscribe((ev) => {
    send('event', ev, ev.seq);
    if (!timer) timer = setTimeout(() => { timer = null; send('state', tower.snapshot()); }, 120);
  });
  const tick = setInterval(() => { tower.touch(); send('state', tower.snapshot()); }, 2000);
  const keepalive = setInterval(() => write(': keepalive\n\n'), 15000);
  req.on('close', () => {
    unsubscribe();
    clearInterval(tick);
    clearInterval(keepalive);
    clearTimeout(timer);
  });
}

async function api(req, res, url, rooms) {
  const m = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(.+)$/);
  if (!m || !ROOM_RE.test(m[1])) throw new HttpError(404, 'Not found');
  const [, roomId, rest] = m;
  const tower = rooms.get(roomId);
  const operator = sanitizeOperator(req.headers['x-operator']);
  const parts = rest.split('/');

  if (req.method === 'GET') {
    if (rest === 'stream') return openStream(req, res, tower);
    if (rest === 'state') return send(res, 200, tower.snapshot());
    if (rest === 'audit') {
      const format = url.searchParams.get('format') ?? 'json';
      if (format === 'csv') return send(res, 200, tower.auditLog.toCSV(), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="audit-${roomId}.csv"` });
      if (format === 'json' && url.searchParams.get('download') === '1') return send(res, 200, tower.auditLog.toJSON(roomId), { 'Content-Disposition': `attachment; filename="audit-${roomId}.json"` });
      const agentId = url.searchParams.get('agent');
      const actorType = url.searchParams.get('actor');
      return send(res, 200, { entries: tower.auditLog.query({ agentId: agentId && ID_RE.test(agentId) ? agentId : undefined, actorType: ['agent', 'operator', 'tower'].includes(actorType) ? actorType : undefined, limit: 300 }).map((e) => ({ ...e, timestamp: new Date(e.ts).toISOString() })), total: tower.auditLog.entries.length });
    }
    if (rest === 'audit/verify') return send(res, 200, tower.auditLog.verify());
    if (parts[0] === 'agents' && parts[2] === 'steps' && ID_RE.test(parts[1] ?? '')) return send(res, 200, tower.steps(parts[1], url.searchParams.get('n')));
    throw new HttpError(404, 'Not found');
  }

  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const body = await readJson(req);

  if (parts[0] === 'agents' && parts.length === 3 && ID_RE.test(parts[1])) {
    const [, id, op] = parts;
    if (op === 'pause') tower.pause(id, { by: operator, reason: `Paused by ${operator.slice(9)}` });
    else if (op === 'resume') tower.resume(id, { by: operator });
    else if (op === 'kill') tower.kill(id, { by: operator, reason: `Killed by ${operator.slice(9)}` });
    else if (op === 'restart') tower.restart(id, { by: operator });
    else if (op === 'budget') tower.raiseBudget(id, body.addUsd, { by: operator, resume: body.resume === true });
    else throw new HttpError(404, 'Unknown agent operation');
    return send(res, 200, { ok: true });
  }
  if (parts[0] === 'fleet' && parts.length === 2) return send(res, 200, { ok: true, ...tower.fleet(parts[1], { by: operator }) });
  if (parts[0] === 'approvals' && parts.length === 3 && ID_RE.test(parts[1])) {
    const ap = tower.decide(parts[1], parts[2], { by: operator, note: typeof body.note === 'string' ? body.note : '' });
    return send(res, 200, { ok: true, approval: ap });
  }
  if (rest === 'settings') {
    tower.setAutoContain(body.autoContain, { by: operator });
    return send(res, 200, { ok: true });
  }
  if (rest === 'sim/inject') {
    if (typeof body.agentId !== 'string' || !ID_RE.test(body.agentId)) throw new HttpError(400, 'agentId is required');
    tower.injectFault(body.agentId, body.fault, { by: operator });
    return send(res, 200, { ok: true });
  }
  if (rest === 'sim/reset') {
    tower.reset({ by: operator });
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found');
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');
  let data;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

export function createServer(rooms = new Rooms()) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return send(res, 200, { ok: true, rooms: rooms.rooms.size });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url, rooms);
      return await serveStatic(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Internal error' });
    }
  });
  server.rooms = rooms;
  server.on('close', () => rooms.close());
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const rooms = new Rooms({ speed: Number(process.env.AGENT_SPEED) || 1, maxRooms: Number(process.env.MAX_ROOMS) || 40 });
  const server = createServer(rooms);
  server.listen(port, '0.0.0.0', () => console.log(`Agent Control Tower listening on http://localhost:${port}`));
  const shutdown = () => {
    console.log('Shutting down…');
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
