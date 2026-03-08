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
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 168);
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

function sanitizeUserId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
}

function getSessionToken(req, requestUrl) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return requestUrl.searchParams.get('token') || '';
}

function requireWebhookAuth(req, requestUrl) {
  if (!WEBHOOK_TOKEN) return true;

  const authHeader = req.headers.authorization || '';
  if (authHeader === `Bearer ${WEBHOOK_TOKEN}`) return true;

  return requestUrl.searchParams.get('token') === WEBHOOK_TOKEN;
}

function getSessionUser(req, requestUrl) {
  const token = getSessionToken(req, requestUrl);
  if (!token) return null;

  const now = new Date().toISOString();
  store.cleanupExpiredSessions(now);
  const session = store.getSession(token);
  if (!session) return null;

  if (session.expires_at < now) {
    store.deleteSession(token);
    return null;
  }

  return {
    token,
    userId: session.user_id,
    displayName: session.display_name
  };
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, saltHex, expectedHash) {
  const digest = hashPassword(password, saltHex);
  const digestBuffer = Buffer.from(digest, 'hex');
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  if (digestBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(digestBuffer, expectedBuffer);
}

function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  store.createSession({ token, userId, expiresAt });
  return { token, expiresAt };
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

function deriveConversationId(payload, sender, recipient) {
  if (payload.conversationId) return String(payload.conversationId);
  return store.ensureConversationForPair(sender, recipient);
}

function normalizeMessage(direction, payload, senderOverride) {
  const now = new Date().toISOString();
  const sender = senderOverride || payload.sender || payload.from || 'unknown';
  const recipient = payload.recipient || payload.to || 'unknown';
  const text = String(payload.text || payload.body || '').trim();

  return {
    id: payload.id || crypto.randomUUID(),
    conversationId: deriveConversationId(payload, sender, recipient),
    direction,
    channel: payload.channel || 'desktop',
    sender,
    recipient,
    text,
    metadata: payload.metadata || {},
    providerTimestamp: payload.timestamp || null,
    receivedAt: now,
    processedAt: now,
    tags: deriveTags(text)
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

function canUserSeeConversation(userId, conversationId) {
  return store.isConversationMember(conversationId, userId);
}

function broadcastEvent(event, payload) {
  const convId = payload?.conversationId || null;

  const sseEvent = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    if (convId && !canUserSeeConversation(client.userId, convId)) {
      continue;
    }
    client.res.write(sseEvent);
  }

  const wsEvent = JSON.stringify({ event, data: payload });
  for (const client of wsClients) {
    if (client.socket.readyState !== WS_OPEN) continue;
    if (convId && !canUserSeeConversation(client.userId, convId)) {
      continue;
    }
    client.socket.send(wsEvent);
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

async function handleRegister(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: `Invalid JSON payload: ${error.message}` });
    return;
  }

  const userId = sanitizeUserId(payload.userId);
  const password = String(payload.password || '');
  const displayName = String(payload.displayName || userId || '').trim();

  if (!userId || password.length < 4) {
    sendJson(res, 400, { error: 'Provide a valid userId and password (min 4 chars).' });
    return;
  }

  if (store.getUserById(userId)) {
    sendJson(res, 409, { error: 'User already exists' });
    return;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  store.createUser({ userId, displayName: displayName || userId, passwordSalt: salt, passwordHash: hash });

  const session = issueSession(userId);
  sendJson(res, 201, {
    user: { userId, displayName: displayName || userId },
    session
  });
}

async function handleLogin(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: `Invalid JSON payload: ${error.message}` });
    return;
  }

  const userId = sanitizeUserId(payload.userId);
  const password = String(payload.password || '');
  const user = store.getUserById(userId);

  if (!user || !user.password_hash || !verifyPassword(password, user.password_salt, user.password_hash)) {
    sendJson(res, 401, { error: 'Invalid credentials' });
    return;
  }

  const session = issueSession(user.user_id);
  sendJson(res, 200, {
    user: { userId: user.user_id, displayName: user.display_name },
    session
  });
}

function handleMe(req, res, sessionUser) {
  sendJson(res, 200, {
    user: { userId: sessionUser.userId, displayName: sessionUser.displayName }
  });
}

function handleLogout(req, res, sessionUser) {
  store.deleteSession(sessionUser.token);
  sendJson(res, 200, { status: 'ok' });
}

function listConversations(req, res, sessionUser) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = Number(url.searchParams.get('limit') || 50);
  const conversations = store.listConversationsForUser(sessionUser.userId, limit);
  sendJson(res, 200, { count: conversations.length, conversations });
}

async function postMessage(req, res, sessionUser) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: `Invalid JSON payload: ${error.message}` });
    return;
  }

  const recipient = sanitizeUserId(payload.recipient || payload.to);
  const text = String(payload.text || '').trim();
  if (!recipient || !text) {
    sendJson(res, 400, { error: 'recipient and text are required' });
    return;
  }
  if (!store.getUserById(recipient)) {
    sendJson(res, 404, { error: `User not found: ${recipient}` });
    return;
  }

  const conversationId = store.ensureConversationForPair(sessionUser.userId, recipient);
  const message = normalizeMessage(
    'outgoing',
    {
      ...payload,
      recipient,
      channel: payload.channel || 'desktop-ui',
      conversationId
    },
    sessionUser.userId
  );

  try {
    store.addMessage(message);
    broadcastEvent('message', message);
    const forwardResult = await forwardToWebhook(message);

    sendJson(res, 202, {
      status: 'accepted',
      messageId: message.id,
      conversationId: message.conversationId,
      forwardResult
    });
  } catch (error) {
    sendJson(res, 500, { error: `Processing failed: ${error.message}` });
  }
}

function createDirectConversation(req, res, sessionUser) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const peerIdRaw = url.searchParams.get('peerId') || '';
  const peerId = sanitizeUserId(peerIdRaw);
  if (!peerId) {
    sendJson(res, 400, { error: 'peerId is required' });
    return;
  }
  if (!store.getUserById(peerId)) {
    sendJson(res, 404, { error: `User not found: ${peerId}` });
    return;
  }

  try {
    const conversationId = store.ensureConversationForPair(sessionUser.userId, peerId);
    sendJson(res, 201, { conversationId, peerId });
  } catch (error) {
    sendJson(res, 500, { error: `Could not create conversation: ${error.message}` });
  }
}

async function handleWebhook(req, res, direction) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (!requireWebhookAuth(req, requestUrl)) {
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

  const sender = sanitizeUserId(payload.sender || payload.from || 'unknown') || 'unknown';
  const recipient = sanitizeUserId(payload.recipient || payload.to || 'unknown') || 'unknown';

  const message = normalizeMessage(direction, {
    ...payload,
    sender,
    recipient,
    conversationId: payload.conversationId || store.ensureConversationForPair(sender, recipient)
  });

  try {
    store.addMessage(message);
    broadcastEvent('message', message);
    const forwardResult = await forwardToWebhook(message);

    sendJson(res, 202, {
      status: 'accepted',
      messageId: message.id,
      conversationId: message.conversationId,
      forwardResult
    });
  } catch (error) {
    sendJson(res, 500, { error: `Processing failed: ${error.message}` });
  }
}

function listMessages(req, res, sessionUser) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const conversationId = String(url.searchParams.get('conversationId') || '');
  const limit = url.searchParams.get('limit') || 50;
  const before = url.searchParams.get('before') || '';

  if (!conversationId) {
    sendJson(res, 400, { error: 'conversationId is required' });
    return;
  }

  const result = store.listMessagesForUser({
    userId: sessionUser.userId,
    conversationId,
    limit,
    beforeCursor: before
  });

  if (result.unauthorized) {
    sendJson(res, 403, { error: 'Conversation access denied' });
    return;
  }

  sendJson(res, 200, {
    count: result.messages.length,
    nextCursor: result.nextCursor,
    messages: result.messages
  });
}

async function markRead(req, res, sessionUser) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const match = requestUrl.pathname.match(/^\/messages\/([^/]+)\/read$/);
  if (!match) {
    sendJson(res, 404, { error: 'Route not found' });
    return;
  }

  const messageId = decodeURIComponent(match[1]);
  const updated = store.markAsRead(messageId, sessionUser.userId);

  if (!updated) {
    sendJson(res, 404, { error: 'Message not found or access denied' });
    return;
  }

  broadcastEvent('message_status', {
    id: updated.id,
    status: updated.status,
    readAt: updated.readAt,
    readBy: updated.readBy,
    conversationId: updated.conversationId
  });

  sendJson(res, 200, { status: 'ok', message: updated });
}

function handleSse(req, res, sessionUser) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no'
  });

  res.write('retry: 3000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);

  const client = { res, userId: sessionUser.userId };
  sseClients.add(client);

  req.on('close', () => {
    sseClients.delete(client);
    res.end();
  });
}

function startHeartbeat() {
  setInterval(() => {
    const payload = { ts: new Date().toISOString() };
    const sseEvent = `event: ping\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      client.res.write(sseEvent);
    }

    const wsEvent = JSON.stringify({ event: 'ping', data: payload });
    for (const client of wsClients) {
      if (client.socket.readyState === WS_OPEN) {
        client.socket.send(wsEvent);
      }
    }
  }, SSE_HEARTBEAT_MS);
}

function health(res) {
  sendJson(res, 200, {
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    sseClients: sseClients.size,
    wsClients: wsClients.size,
    messageCount: store.countMessages(),
    conversationCount: store.countConversations(),
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

  wss.on('connection', (socket, request, sessionUser) => {
    const client = { socket, userId: sessionUser.userId };
    wsClients.add(client);

    socket.send(
      JSON.stringify({
        event: 'ready',
        data: {
          connectedAt: new Date().toISOString(),
          userId: sessionUser.userId
        }
      })
    );

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
      wsClients.delete(client);
    });
  });

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = requestUrl.pathname;
    const sessionUser = getSessionUser(req, requestUrl);

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

    if (req.method === 'POST' && pathname === '/auth/register') {
      await handleRegister(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/login') {
      await handleLogin(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/logout') {
      if (!sessionUser) return unauthorized(res);
      handleLogout(req, res, sessionUser);
      return;
    }

    if (req.method === 'GET' && pathname === '/auth/me') {
      if (!sessionUser) return unauthorized(res);
      handleMe(req, res, sessionUser);
      return;
    }

    if (req.method === 'GET' && pathname === '/conversations') {
      if (!sessionUser) return unauthorized(res);
      listConversations(req, res, sessionUser);
      return;
    }

    if (req.method === 'POST' && pathname === '/conversations/direct') {
      if (!sessionUser) return unauthorized(res);
      createDirectConversation(req, res, sessionUser);
      return;
    }

    if (req.method === 'POST' && pathname === '/messages') {
      if (!sessionUser) return unauthorized(res);
      await postMessage(req, res, sessionUser);
      return;
    }

    if (req.method === 'GET' && pathname === '/messages') {
      if (!sessionUser) return unauthorized(res);
      listMessages(req, res, sessionUser);
      return;
    }

    if (req.method === 'POST' && pathname.match(/^\/messages\/[^/]+\/read$/)) {
      if (!sessionUser) return unauthorized(res);
      await markRead(req, res, sessionUser);
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

    if (req.method === 'GET' && pathname === '/stream') {
      if (!sessionUser) return unauthorized(res);
      handleSse(req, res, sessionUser);
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

    const sessionUser = getSessionUser(req, requestUrl);
    if (!sessionUser) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, sessionUser);
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
