import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import os from 'node:os';

const PORT = Number(process.env.CAMERA_PORT || 8787);
const HOST = process.env.CAMERA_HOST || '0.0.0.0';
const PASSWORD = process.env.CAMERA_PASSWORD || '';
const PUBLIC = join(process.cwd(), 'public');
const SESSION_TTL = 8 * 60 * 60 * 1000;
const ROOM_TTL = 12 * 60 * 60 * 1000;
const sessions = new Map();
const rooms = new Map();

if (!PASSWORD || PASSWORD.length < 8) {
  console.error('请先设置至少 8 位的 CAMERA_PASSWORD 环境变量。');
  console.error("PowerShell 示例：$env:CAMERA_PASSWORD='请换成强密码'; node server.mjs");
  process.exit(1);
}

const json = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
};

const parseBody = async (req) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error('请求过大');
  }
  return raw ? JSON.parse(raw) : {};
};

const constantEqual = (a, b) => {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};

const authenticate = (req) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) return false;
  sessions.set(token, Date.now() + SESSION_TTL);
  return true;
};

const roomFor = (id, pin) => {
  const room = rooms.get(id);
  if (!room || room.expires < Date.now() || !constantEqual(room.pin, pin)) return null;
  room.expires = Date.now() + ROOM_TTL;
  return room;
};

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(pathname, res) {
  const route = pathname === '/' ? '/index.html' : pathname;
  const safe = route.replace(/[^a-zA-Z0-9._\/-]/g, '');
  if (safe.includes('..')) return false;
  try {
    const data = await readFile(join(PUBLIC, safe));
    res.writeHead(200, {
      'Content-Type': mime[extname(safe)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'camera=(self), microphone=()',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { password } = await parseBody(req);
      if (!constantEqual(password, PASSWORD)) return json(res, 401, { error: '密码错误' });
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + SESSION_TTL);
      return json(res, 200, { token });
    }

    if (url.pathname.startsWith('/api/') && !authenticate(req)) {
      return json(res, 401, { error: '登录已过期，请重新登录' });
    }

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      let id;
      do id = randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(id));
      const pin = String(randomInt(100000, 1000000));
      rooms.set(id, { pin, expires: Date.now() + ROOM_TTL, seq: 0, events: [] });
      return json(res, 201, { id, pin });
    }

    const match = url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})(?:\/(events|messages))?$/);
    if (match) {
      const id = match[1];
      const pin = req.headers['x-room-pin'] || url.searchParams.get('pin') || '';
      const room = roomFor(id, pin);
      if (!room) return json(res, 404, { error: '房间号或 PIN 不正确' });

      if (req.method === 'POST' && match[2] === 'messages') {
        const body = await parseBody(req);
        if (!['camera', 'viewer'].includes(body.from) || !['camera', 'viewer'].includes(body.to)) {
          return json(res, 400, { error: '无效角色' });
        }
        const allowed = ['viewer-ready', 'offer', 'answer', 'ice', 'hangup'];
        if (!allowed.includes(body.type)) return json(res, 400, { error: '无效消息' });
        room.events.push({ seq: ++room.seq, from: body.from, to: body.to, type: body.type, data: body.data ?? null });
        if (room.events.length > 500) room.events.splice(0, room.events.length - 500);
        return json(res, 202, { ok: true, seq: room.seq });
      }

      if (req.method === 'GET' && match[2] === 'events') {
        const role = url.searchParams.get('role');
        const since = Number(url.searchParams.get('since') || 0);
        if (!['camera', 'viewer'].includes(role) || !Number.isSafeInteger(since) || since < 0) {
          return json(res, 400, { error: '参数错误' });
        }
        return json(res, 200, { events: room.events.filter(e => e.to === role && e.seq > since), latest: room.seq });
      }
    }

    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    json(res, 404, { error: '未找到' });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: '服务器错误' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [token, expires] of sessions) if (expires < now) sessions.delete(token);
  for (const [id, room] of rooms) if (room.expires < now) rooms.delete(id);
}, 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`\n远端摄像头页面：http://localhost:${PORT}/camera.html`);
  console.log('本机查看页面：');
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) console.log(`  http://${item.address}:${PORT}/viewer.html`);
    }
  }
  console.log('\n只应在可信局域网中使用；按 Ctrl+C 停止。');
});
