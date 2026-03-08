const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { MessageStore } = require('./storage');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const FORWARD_WEBHOOK_URL = process.env.FORWARD_WEBHOOK_URL || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const SSE_HEARTBEAT_MS = 15000;
const WS_OPEN = 1;

const store = new MessageStore(DATA_DIR);
const sseClients = new Set();
const wsClients = new Set();

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function unauthorized(res) {
  sendJson(res, 401, { error: 'Unauthorized' });
}

function isAuthorized(req, requestUrl) {
  if (!WEBHOOK_TOKEN) return true;

  const authHeader = req.headers.authorization || '';
  if (authHeader === `Bearer ${WEBHOOK_TOKEN}`) return true;

  const token = requestUrl?.searchParams.get('token') || '';
  return token === WEBHOOK_TOKEN;
}

async function serveStaticFile(res, fileName, contentType) {
  const fs = require('fs/promises');
  try {
    const content = await fs.readFile(path.join(PUBLIC_DIR, fileName));
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Static file not found' });
  }
}

function normalizeMessage(direction, payload) {
  const now = new Date().toISOString();
  const text = String(payload.text || payload.body || '').trim();

  return {
    id: payload.id || crypto.randomUUID(),
    direction,
    channel: payload.channel || 'desktop',
    sender: payload.sender || payload.from || 'unknown',
    recipient: payload.recipient || payload.to || 'unknown',
    text,
    metadata: payload.metadata || {},
    status: payload.status || (direction === 'incoming' ? 'received' : 'sent'),
    providerTimestamp: payload.timestamp || null,
    receivedAt: now,
    processedAt: now,
    tags: deriveTags(text),
    readAt: null,
    readBy: null
  };
}

function deriveTags(text) {
  const tags = [];
  const normalized = text.toLowerCase();

  if (!normalized) tags.push('empty');
  if (normalized.includes('urgent')) tags.push('urgent');
  if (normalized.includes('error') || normalized.includes('failed')) tags.push('problem');
  if (normalized.includes('hello') || normalized.includes('hi')) tags.push('greeting');

  return tags;
}

function broadcastEvent(event, payload) {
  const sse = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    client.write(sse);
  }

  const ws = JSON.stringify({ event, data: payload });
  for (const client of wsClients) {
    if (client.readyState === WS_OPEN) {
      client.send(ws);
    }
  }
}

function forwardToWebhook(message) {
  if (!FORWARD_WEBHOOK_URL) {
    return Promise.resolve({ skipped: true });
  }

  return new Promise((resolve, reject) => {
    const url = new URL(FORWARD_WEBHOOK_URL);
    const body = JSON.stringify(message);

    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(options, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        resolve({
          skipped: false,
          statusCode: response.statusCode,
          body: responseBody.slice(0, 500)
        });
      });
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function handleWebhook(req, res, direction) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (!isAuthorized(req, requestUrl)) {
    unauthorized(res);
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: `Invalid JSON payload: ${error.message}` });
    return;
  }

  const message = normalizeMessage(direction, payload);

  try {
    store.addMessage(message);
    broadcastEvent('message', message);
    const forwardResult = await forwardToWebhook(message);

    sendJson(res, 202, {
      status: 'accepted',
      messageId: message.id,
      forwardResult
    });
  } catch (error) {
    sendJson(res, 500, { error: `Processing failed: ${error.message}` });
  }
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no'
  });

  res.write('retry: 3000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
    res.end();
  });
}

function startHeartbeat() {
  setInterval(() => {
    broadcastEvent('ping', { ts: new Date().toISOString() });
  }, SSE_HEARTBEAT_MS);
}

function listMessages(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const direction = url.searchParams.get('direction');
  const limit = url.searchParams.get('limit') || 50;

  const messages = store.listMessages({ direction, limit });
  sendJson(res, 200, { count: messages.length, messages });
}

async function markRead(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (!isAuthorized(req, requestUrl)) {
    unauthorized(res);
    return;
  }

  const match = requestUrl.pathname.match(/^\/messages\/([^/]+)\/read$/);
  if (!match) {
    sendJson(res, 404, { error: 'Route not found' });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: `Invalid JSON payload: ${error.message}` });
    return;
  }

  const messageId = decodeURIComponent(match[1]);
  const reader = String(payload.reader || 'unknown');
  const updated = store.markAsRead(messageId, reader);

  if (!updated) {
    sendJson(res, 404, { error: 'Message not found' });
    return;
  }

  broadcastEvent('message_status', {
    id: updated.id,
    status: updated.status,
    readAt: updated.readAt,
    readBy: updated.readBy
  });

  sendJson(res, 200, { status: 'ok', message: updated });
}

function health(res) {
  sendJson(res, 200, {
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    sseClients: sseClients.size,
    wsClients: wsClients.size,
    messageCount: store.count(),
    storage: {
      type: 'sqlite',
      path: store.dbPath
    }
  });
}

async function start() {
  await store.init();
  startHeartbeat();

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (socket) => {
    wsClients.add(socket);
    socket.send(JSON.stringify({ event: 'ready', data: { connectedAt: new Date().toISOString() } }));

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'ping') {
          socket.send(JSON.stringify({ event: 'pong', data: { ts: new Date().toISOString() } }));
        }
      } catch {
        // Ignore invalid ws payloads in POC mode.
      }
    });

    socket.on('close', () => {
      wsClients.delete(socket);
    });
  });

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = requestUrl.pathname;

    if (req.method === 'GET' && pathname === '/') {
      await serveStaticFile(res, 'index.html', 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && pathname === '/app.js') {
      await serveStaticFile(res, 'app.js', 'application/javascript; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && pathname === '/styles.css') {
      await serveStaticFile(res, 'styles.css', 'text/css; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      health(res);
      return;
    }

    if (req.method === 'POST' && pathname === '/webhook/incoming') {
      await handleWebhook(req, res, 'incoming');
      return;
    }

    if (req.method === 'POST' && pathname === '/webhook/outgoing') {
      await handleWebhook(req, res, 'outgoing');
      return;
    }

    if (req.method === 'GET' && pathname === '/messages') {
      if (!isAuthorized(req, requestUrl)) {
        unauthorized(res);
        return;
      }
      listMessages(req, res);
      return;
    }

    if (req.method === 'POST' && pathname.match(/^\/messages\/[^/]+\/read$/)) {
      await markRead(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/stream') {
      if (!isAuthorized(req, requestUrl)) {
        unauthorized(res);
        return;
      }
      handleSse(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Route not found' });
  });

  server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    if (requestUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    if (!isAuthorized(req, requestUrl)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`Realtime message POC listening on http://${HOST}:${PORT}`);
  });

  process.on('SIGINT', () => {
    store.close();
    process.exit(0);
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', error);
  process.exitCode = 1;
});
