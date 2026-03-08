const els = {
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  direction: document.getElementById('direction'),
  input: document.getElementById('message-input'),
  myId: document.getElementById('my-id'),
  peerId: document.getElementById('peer-id'),
  token: document.getElementById('token'),
  status: document.getElementById('connection-status'),
  statusText: document.getElementById('connection-status-text'),
  statusDot: document.getElementById('status-dot'),
  title: document.getElementById('chat-title'),
  connectBtn: document.getElementById('connect-btn')
};

let stream;
let reconnectTimer;
let watchdogTimer;
let liveSyncTimer;
let tokenDebounceTimer;
let retryAttempt = 0;
let lastEventAt = 0;
let isManualReconnect = false;

const seen = new Set();
const STORAGE_KEY = 'realtime-chat-poc:v1';
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;
const WATCHDOG_EVERY_MS = 10000;
const STALE_AFTER_MS = 45000;
const LIVE_SYNC_MS = 1200;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
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

function formatTime(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addMessage(message) {
  if (seen.has(message.id)) return;
  seen.add(message.id);

  const mine = normalizeId(message.sender) === normalizeId(els.myId.value);
  const row = document.createElement('article');
  row.className = `message ${mine ? 'outgoing' : 'incoming'}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const body = document.createElement('div');
  body.textContent = message.text || '[empty message]';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent =
    `${message.sender} -> ${message.recipient} • ${formatTime(message.receivedAt)} • ${message.direction}`;

  bubble.append(body, meta);
  row.appendChild(bubble);
  els.messages.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function loadHistory() {
  const queryToken = els.token.value.trim();
  const query = queryToken ? `?limit=200&token=${encodeURIComponent(queryToken)}` : '?limit=200';
  const response = await fetch(`/messages${query}`, { headers: authHeaders() });

  if (!response.ok) {
    throw new Error(`Failed to load messages (${response.status})`);
  }

  const payload = await response.json();
  els.messages.innerHTML = '';
  seen.clear();

  for (const msg of payload.messages.slice().reverse()) {
    addMessage(msg);
  }
}

async function fetchRecentIncremental() {
  const queryToken = els.token.value.trim();
  const query = queryToken ? `?limit=50&token=${encodeURIComponent(queryToken)}` : '?limit=50';
  const response = await fetch(`/messages${query}`, { headers: authHeaders() });
  if (!response.ok) return;
  const payload = await response.json();
  for (const msg of payload.messages.slice().reverse()) {
    addMessage(msg);
  }
}

function startLiveSync() {
  if (liveSyncTimer) return;
  liveSyncTimer = setInterval(() => {
    fetchRecentIncremental().catch(() => {
      // Keep sync loop resilient across transient tunnel/network drops.
    });
  }, LIVE_SYNC_MS);
}

function closeStream() {
  if (stream) {
    stream.close();
    stream = undefined;
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
      await loadHistory();
      connectStream();
    } catch (error) {
      setConnection('reconnecting', error.message);
      scheduleReconnect('Reconnecting...');
    }
  }, waitMs);
}

async function reconnectNow() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  retryAttempt = 0;
  closeStream();
  await loadHistory();
  connectStream();
}

function markActivity() {
  lastEventAt = Date.now();
}

function startWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
  }

  watchdogTimer = setInterval(() => {
    if (!stream) return;
    if (!lastEventAt) return;

    const staleFor = Date.now() - lastEventAt;
    if (staleFor > STALE_AFTER_MS) {
      closeStream();
      scheduleReconnect('Stream stale');
    }
  }, WATCHDOG_EVERY_MS);
}

function connectStream() {
  closeStream();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  const queryToken = els.token.value.trim();
  const url = queryToken ? `/stream?token=${encodeURIComponent(queryToken)}` : '/stream';

  setConnection('connecting', 'Connecting...');
  stream = new EventSource(url);

  stream.addEventListener('open', () => {
    retryAttempt = 0;
    markActivity();
    setConnection('connected', 'Connected');
    fetchRecentIncremental().catch(() => {
      // Ignore one-off catch-up failures.
    });
  });

  const handleMessageEvent = (event) => {
    try {
      markActivity();
      addMessage(JSON.parse(event.data));
    } catch (error) {
      console.error(error);
    }
  };

  stream.onmessage = handleMessageEvent;
  stream.addEventListener('message', handleMessageEvent);
  stream.addEventListener('ping', () => {
    markActivity();
  });

  stream.addEventListener('error', () => {
    setConnection('disconnected', 'Disconnected');
    closeStream();

    if (isManualReconnect) {
      isManualReconnect = false;
      scheduleReconnect('Reconnect failed');
      return;
    }

    scheduleReconnect('Disconnected');
  });

  startWatchdog();
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
  fetchRecentIncremental().catch(() => {
    // Ignore one-off sync issues after send.
  });
}

function syncTitle() {
  els.title.textContent = els.peerId.value.trim() || 'Contact';
}

function init() {
  applyPrefs();

  els.composer.addEventListener('submit', (event) => {
    sendMessage(event).catch((error) => {
      console.error(error);
      alert(error.message);
    });
  });

  els.connectBtn.addEventListener('click', async () => {
    try {
      isManualReconnect = true;
      await reconnectNow();
    } catch (error) {
      setConnection('reconnecting', error.message);
      scheduleReconnect('Reconnect failed');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !stream) {
      scheduleReconnect('Resuming...');
    }
  });

  window.addEventListener('online', () => {
    scheduleReconnect('Network restored');
  });

  window.addEventListener('focus', () => {
    fetchRecentIncremental().catch(() => {
      // Keep trying on next ticks.
    });
    if (!stream) {
      scheduleReconnect('Resuming...');
    }
  });

  els.peerId.addEventListener('input', syncTitle);
  els.myId.addEventListener('input', savePrefs);
  els.peerId.addEventListener('input', () => {
    syncTitle();
    savePrefs();
  });
  els.token.addEventListener('input', () => {
    savePrefs();
    if (tokenDebounceTimer) {
      clearTimeout(tokenDebounceTimer);
    }
    tokenDebounceTimer = setTimeout(() => {
      reconnectNow().catch((error) => {
        setConnection('reconnecting', error.message);
        scheduleReconnect('Auth update');
      });
    }, 500);
  });
  els.direction.addEventListener('change', savePrefs);

  syncTitle();
  savePrefs();
  startLiveSync();

  reconnectNow()
    .catch((error) => {
      setConnection('reconnecting', error.message);
      scheduleReconnect('Initial connect failed');
    });
}

init();
