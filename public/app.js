const els = {
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  direction: document.getElementById('direction'),
  input: document.getElementById('message-input'),
  myId: document.getElementById('my-id'),
  peerId: document.getElementById('peer-id'),
  token: document.getElementById('token'),
  statusText: document.getElementById('connection-status-text'),
  statusDot: document.getElementById('status-dot'),
  title: document.getElementById('chat-title'),
  connectBtn: document.getElementById('connect-btn')
};

const STORAGE_KEY = 'realtime-chat-poc:v1';
const LIVE_SYNC_MS = 1200;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;
const READ_SWEEP_MS = 1200;

const messagesById = new Map();
const inflightReadIds = new Set();
let socket;
let liveSyncTimer;
let reconnectTimer;
let tokenDebounceTimer;
let readSweepTimer;
let retryAttempt = 0;

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function loadPrefsFromHash() {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
  if (!hash) return {};

  const params = new URLSearchParams(hash);
  const direction = params.get('direction');
  return {
    myId: params.get('me') || '',
    peerId: params.get('peer') || '',
    token: params.get('token') || '',
    direction: direction === 'incoming' || direction === 'outgoing' ? direction : ''
  };
}

function writePrefsToHash(payload) {
  const params = new URLSearchParams();
  if (payload.myId) params.set('me', payload.myId);
  if (payload.peerId) params.set('peer', payload.peerId);
  if (payload.token) params.set('token', payload.token);
  if (payload.direction) params.set('direction', payload.direction);

  const nextHash = params.toString();
  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`;
  window.history.replaceState(null, '', nextUrl);
}

function savePrefs() {
  const payload = {
    myId: els.myId.value,
    peerId: els.peerId.value,
    token: els.token.value,
    direction: els.direction.value
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  writePrefsToHash(payload);
}

function applyPrefs() {
  const prefs = { ...loadPrefs(), ...loadPrefsFromHash() };
  if (prefs.myId) els.myId.value = prefs.myId;
  if (prefs.peerId) els.peerId.value = prefs.peerId;
  if (prefs.token) els.token.value = prefs.token;
  if (prefs.direction === 'incoming' || prefs.direction === 'outgoing') {
    els.direction.value = prefs.direction;
  }
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function authHeaders() {
  const token = els.token.value.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function setConnection(state, text) {
  if (els.statusText) {
    els.statusText.textContent = text;
  }
  if (els.statusDot) {
    els.statusDot.className = `status-dot ${state}`;
  }
}

function syncTitle() {
  els.title.textContent = els.peerId.value.trim() || 'Contact';
}

function formatTime(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusLabel(message, mine) {
  if (message.status === 'read') {
    return message.readBy ? `read by ${message.readBy}` : 'read';
  }
  if (mine) {
    return message.status || 'sent';
  }
  return message.status || 'received';
}

function statusTicks(message, mine) {
  if (!mine) return null;
  if (message.status === 'read') {
    return { icon: '✓✓', className: 'ticks ticks-read' };
  }
  if (message.status === 'received') {
    return { icon: '✓✓', className: 'ticks ticks-delivered' };
  }
  return { icon: '✓', className: 'ticks ticks-sent' };
}

function isForegroundActive() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function isNearBottom() {
  const threshold = 80;
  const distance = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
  return distance <= threshold;
}

function renderAllMessages() {
  const shouldStickBottom = isNearBottom();

  const sorted = [...messagesById.values()].sort((a, b) => {
    return new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime();
  });

  els.messages.innerHTML = '';
  const myId = normalizeId(els.myId.value);

  for (const message of sorted) {
    const mine = normalizeId(message.sender) === myId;

    const row = document.createElement('article');
    row.className = `message ${mine ? 'outgoing' : 'incoming'}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const body = document.createElement('div');
    body.textContent = message.text || '[empty message]';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const left = document.createElement('span');
    left.textContent = `${formatTime(message.receivedAt)}${mine ? '' : ` • ${statusLabel(message, mine)}`}`;
    meta.appendChild(left);

    const tick = statusTicks(message, mine);
    if (tick) {
      const right = document.createElement('span');
      right.className = tick.className;
      right.textContent = tick.icon;
      meta.appendChild(right);
    }

    bubble.append(body, meta);

    row.appendChild(bubble);
    els.messages.appendChild(row);
  }

  if (shouldStickBottom) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

function upsertMessage(message) {
  const existing = messagesById.get(message.id) || {};
  messagesById.set(message.id, { ...existing, ...message });
  renderAllMessages();
  autoReadVisibleMessages().catch(() => {});
}

function applyMessageStatusUpdate(update) {
  const existing = messagesById.get(update.id);
  if (!existing) return;
  messagesById.set(update.id, { ...existing, ...update });
  renderAllMessages();
}

async function loadHistory() {
  const token = els.token.value.trim();
  const query = token ? `?limit=250&token=${encodeURIComponent(token)}` : '?limit=250';
  const response = await fetch(`/messages${query}`, { headers: authHeaders() });

  if (!response.ok) {
    throw new Error(`Failed to load messages (${response.status})`);
  }

  const payload = await response.json();
  messagesById.clear();
  payload.messages.forEach((message) => {
    messagesById.set(message.id, message);
  });
  renderAllMessages();
  autoReadVisibleMessages().catch(() => {});
}

async function fetchRecentIncremental() {
  const token = els.token.value.trim();
  const query = token ? `?limit=80&token=${encodeURIComponent(token)}` : '?limit=80';
  const response = await fetch(`/messages${query}`, { headers: authHeaders() });
  if (!response.ok) return;

  const payload = await response.json();
  let changed = false;
  payload.messages.forEach((message) => {
    const existing = messagesById.get(message.id) || {};
    const merged = { ...existing, ...message };
    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      messagesById.set(message.id, merged);
      changed = true;
    }
  });
  if (changed) renderAllMessages();
  if (changed) {
    autoReadVisibleMessages().catch(() => {});
  }
}

function wsUrl() {
  const token = els.token.value.trim();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${protocol}//${window.location.host}/ws`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function closeSocket() {
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
    socket = undefined;
  }
}

function scheduleReconnect(reason = 'Reconnecting...') {
  if (reconnectTimer) return;

  const delay = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_MAX_MS);
  const jitter = Math.floor(Math.random() * 400);
  const waitMs = delay + jitter;
  retryAttempt += 1;

  setConnection('reconnecting', `${reason} retry in ${Math.round(waitMs / 1000)}s`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = undefined;
    try {
      await reconnectNow();
    } catch (error) {
      setConnection('reconnecting', error.message);
      scheduleReconnect('Reconnect failed');
    }
  }, waitMs);
}

function connectRealtime() {
  closeSocket();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  setConnection('connecting', 'Connecting...');
  socket = new WebSocket(wsUrl());

  socket.onopen = () => {
    retryAttempt = 0;
    setConnection('connected', 'Connected');
    fetchRecentIncremental().catch(() => {});
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.event === 'message') {
        upsertMessage(payload.data);
      } else if (payload.event === 'message_status') {
        applyMessageStatusUpdate(payload.data);
      }
    } catch (error) {
      console.error(error);
    }
  };

  socket.onerror = () => {
    setConnection('disconnected', 'Disconnected');
  };

  socket.onclose = () => {
    setConnection('disconnected', 'Disconnected');
    scheduleReconnect('Disconnected');
  };
}

async function reconnectNow() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  retryAttempt = 0;
  await loadHistory();
  connectRealtime();
}

function startLiveSync() {
  if (liveSyncTimer) return;
  liveSyncTimer = setInterval(() => {
    fetchRecentIncremental().catch(() => {
      // Keep polling as fallback when websocket path is unstable.
    });
  }, LIVE_SYNC_MS);
}

async function sendMessage(event) {
  event.preventDefault();

  const text = els.input.value.trim();
  if (!text) return;

  const direction = els.direction.value;
  const sender = direction === 'outgoing' ? els.myId.value.trim() : els.peerId.value.trim();
  const recipient = direction === 'outgoing' ? els.peerId.value.trim() : els.myId.value.trim();

  const response = await fetch(`/webhook/${direction}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders()
    },
    body: JSON.stringify({
      from: sender || 'unknown',
      to: recipient || 'unknown',
      channel: 'desktop-ui',
      text
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    alert(payload.error || `Failed to send (${response.status})`);
    return;
  }

  els.input.value = '';
  els.input.focus();
}

async function markAsRead(messageId) {
  if (inflightReadIds.has(messageId)) return;
  inflightReadIds.add(messageId);
  try {
    const response = await fetch(`/messages/${encodeURIComponent(messageId)}/read`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders()
      },
      body: JSON.stringify({
        reader: els.myId.value.trim() || 'unknown'
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Failed to mark read (${response.status})`);
    }

    const payload = await response.json();
    if (payload.message) {
      upsertMessage(payload.message);
    }
  } finally {
    inflightReadIds.delete(messageId);
  }
}

async function autoReadVisibleMessages() {
  if (!isForegroundActive()) return;

  const myId = normalizeId(els.myId.value);
  const unreadForMe = [];
  for (const message of messagesById.values()) {
    if (
      normalizeId(message.recipient) === myId &&
      message.status !== 'read' &&
      !inflightReadIds.has(message.id)
    ) {
      unreadForMe.push(message.id);
    }
  }

  for (const id of unreadForMe) {
    try {
      await markAsRead(id);
    } catch (error) {
      console.error(error);
    }
  }
}

function startReadSweep() {
  if (readSweepTimer) return;
  readSweepTimer = setInterval(() => {
    autoReadVisibleMessages().catch(() => {});
  }, READ_SWEEP_MS);
}

function init() {
  applyPrefs();
  syncTitle();
  savePrefs();
  startLiveSync();
  startReadSweep();

  els.composer.addEventListener('submit', (event) => {
    sendMessage(event).catch((error) => {
      console.error(error);
      alert(error.message);
    });
  });

  els.connectBtn.addEventListener('click', () => {
    reconnectNow().catch((error) => {
      setConnection('reconnecting', error.message);
      scheduleReconnect('Manual reconnect failed');
    });
  });

  els.myId.addEventListener('input', () => {
    savePrefs();
    renderAllMessages();
  });

  els.peerId.addEventListener('input', () => {
    syncTitle();
    savePrefs();
    renderAllMessages();
  });

  els.direction.addEventListener('change', savePrefs);

  els.token.addEventListener('input', () => {
    savePrefs();
    if (tokenDebounceTimer) {
      clearTimeout(tokenDebounceTimer);
    }
    tokenDebounceTimer = setTimeout(() => {
      reconnectNow().catch((error) => {
        setConnection('reconnecting', error.message);
        scheduleReconnect('Auth update failed');
      });
    }, 500);
  });

  window.addEventListener('online', () => {
    reconnectNow().catch(() => {
      scheduleReconnect('Network restored');
    });
  });

  window.addEventListener('focus', () => {
    fetchRecentIncremental().catch(() => {});
    autoReadVisibleMessages().catch(() => {});
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reconnectNow().catch(() => {
        scheduleReconnect('Resuming...');
      });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      autoReadVisibleMessages().catch(() => {});
    }
  });

  reconnectNow().catch((error) => {
    setConnection('reconnecting', error.message);
    scheduleReconnect('Initial connect failed');
  });
}

init();
