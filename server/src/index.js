// Softdrop server: static page + WebSocket signaling on one port.
// In production it sits behind a TLS reverse proxy (nginx) on loopback.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Hub } from './hub.js';
import { groupKey } from './util.js';
import { log, logLevel } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const config = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 8480),
  webRoot: path.resolve(env.WEB_ROOT || path.join(here, '../../web')),
  // Only trust X-Real-IP / X-Forwarded-For when the socket comes from these addresses (the proxy).
  trustedProxies: (env.TRUSTED_PROXIES || '127.0.0.1,::1,::ffff:127.0.0.1').split(',').map((s) => s.trim()).filter(Boolean),
  // Empty means "any origin" (handy for local development only).
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  turnSecret: env.TURN_SECRET || '',
  turnHost: env.TURN_HOST || '',
  turnTtl: Number(env.TURN_TTL || 6 * 3600),
};


const stunUrls = config.turnHost ? [`stun:${config.turnHost}:3478`] : [];
const turnUrls = config.turnHost && config.turnSecret
  ? [
      `turn:${config.turnHost}:3478?transport=udp`,
      `turn:${config.turnHost}:3478?transport=tcp`,
      `turns:${config.turnHost}:5349?transport=tcp`,
    ]
  : [];
if (!turnUrls.length) log('warn', 'turn.disabled', { why: 'set TURN_HOST and TURN_SECRET; only direct paths will work' });

const hub = new Hub({ turnSecret: config.turnSecret, stunUrls, turnUrls, turnTtl: config.turnTtl, log });

// ---- static files ----

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' wss: ws:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(config.webRoot, path.normalize(pathname));
  if (!file.startsWith(config.webRoot + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const ext = path.extname(file);
    const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
    securityHeaders(res);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('ETag', etag);
    // Revalidate everything: the service worker handles offline caching.
    res.setHeader('Cache-Control', 'no-cache');
    if (path.basename(file) === 'sw.js') res.setHeader('Service-Worker-Allowed', '/');
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  log('debug', 'http', { ip: clientIp(req), method: req.method, url: req.url.slice(0, 200) });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, ...hub.stats() }));
    return;
  }
  serveStatic(req, res);
});

// ---- WebSocket ----

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (config.trustedProxies.includes(remote)) {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real) return real.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',').pop().trim(); // the hop the proxy saw
  }
  return remote;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  const origin = req.headers.origin || '';
  if (pathname !== '/ws' || (config.allowedOrigins.length && !config.allowedOrigins.includes(origin))) {
    log('warn', 'ws.reject', { ip: clientIp(req), path: pathname, origin: origin || 'none' });
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const ip = clientIp(req);
    const handlers = hub.connect(
      { send: (s) => ws.readyState === ws.OPEN && ws.send(s), close: (code, reason) => ws.close(code, reason) },
      ip,
      groupKey(ip),
    );
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'text only');
      handlers.message(data.toString());
    });
    ws.on('close', (code, reason) => handlers.close(code, reason.toString()));
    ws.on('error', (e) => {
      log('warn', 'ws.error', { ip, err: e.message });
      ws.terminate();
    });
  });
});

// Drop sockets that stop answering (phones going to sleep, dead NAT mappings).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      log('info', 'ws.timeout', { why: 'no pong in 25s' });
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

server.listen(config.port, config.host, () => {
  log('info', 'start', {
    listen: `http://${config.host}:${config.port}`, webRoot: config.webRoot, logLevel,
    origins: config.allowedOrigins.join(',') || 'any', turn: turnUrls.length ? config.turnHost : 'off',
  });
});

function shutdown() {
  clearInterval(heartbeat);
  hub.close();
  for (const ws of wss.clients) ws.close(1012, 'restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
// `systemctl kill -s USR2 softdrop` prints who is online and who sees whom.
process.on('SIGUSR2', () => {
  const rows = hub.dump();
  log('info', 'dump', { devices: rows.length, ...hub.stats() });
  for (const r of rows) log('info', 'dump.device', r);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
