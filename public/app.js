const els = {
  authView: document.getElementById('auth-view'),
  chatView: document.getElementById('chat-view'),
  authModeHint: document.getElementById('auth-mode-hint'),
  authModeLogin: document.getElementById('auth-mode-login'),
  authModeRegister: document.getElementById('auth-mode-register'),
  authForm: document.getElementById('auth-form'),
  authDisplayGroup: document.getElementById('auth-display-group'),
  authSubmitBtn: document.getElementById('auth-submit-btn'),
  authUser: document.getElementById('auth-user'),
  authDisplay: document.getElementById('auth-display'),
  authPass: document.getElementById('auth-pass'),
  authPassToggle: document.getElementById('auth-pass-toggle'),
  authStatus: document.getElementById('auth-status'),
  currentUser: document.getElementById('current-user'),
  logoutBtn: document.getElementById('logout-btn'),
  newChatForm: document.getElementById('new-chat-form'),
  newChatPeer: document.getElementById('new-chat-peer'),
  chatList: document.getElementById('chat-list'),
  chatTitle: document.getElementById('chat-title'),
  reconnectBtn: document.getElementById('reconnect-btn'),
  statusText: document.getElementById('connection-status-text'),
  statusDot: document.getElementById('status-dot'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  input: document.getElementById('message-input')
};

const SESSION_STORAGE_KEY = 'realtime-chat-session:v1';
const LIVE_SYNC_MS = 1200;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;
const READ_SWEEP_MS = 1200;

const state = {
  token: '',
  user: null,
  activeConversationId: '',
  activePeerId: '',
  conversations: [],
  messagesById: new Map(),
  nextCursor: null,
  loadingOlder: false,
  inflightReadIds: new Set(),
  socket: null,
  liveSyncTimer: null,
  reconnectTimer: null,
  readSweepTimer: null,
  retryAttempt: 0,
  authMode: 'login'
};

function saveSession() {
  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({ token: state.token, activeConversationId: state.activeConversationId, activePeerId: state.activePeerId })
  );
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function directConversationId(userA, userB) {
  const members = [normalizeId(userA), normalizeId(userB)].sort();
  return `direct:${members[0]}:${members[1]}`;
}

function setConnection(stateName, text) {
  els.statusText.textContent = text;
  els.statusDot.className = `status-dot ${stateName}`;
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusTicks(message) {
  const mine = normalizeId(message.sender) === normalizeId(state.user?.userId);
  if (!mine) return null;
  if (message.status === 'read') return { icon: '✓✓', className: 'ticks ticks-read' };
  if (message.status === 'delivered' || message.status === 'received') {
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

function renderChatList() {
  els.chatList.innerHTML = '';

  for (const conv of state.conversations) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `chat-item ${conv.conversationId === state.activeConversationId ? 'active' : ''}`;
    row.dataset.conversationId = conv.conversationId;

    const title = document.createElement('div');
    title.className = 'chat-item-title';
    title.textContent = conv.peerId || conv.conversationId;

    const preview = document.createElement('div');
    preview.className = 'chat-item-preview';
    preview.textContent = conv.lastMessage?.text || 'No messages yet';

    const meta = document.createElement('div');
    meta.className = 'chat-item-meta';
    meta.textContent = conv.lastMessage?.at ? formatTime(conv.lastMessage.at) : '';

    if (conv.unreadCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'chat-badge';
      badge.textContent = String(conv.unreadCount);
      meta.appendChild(badge);
    }

    row.append(title, preview, meta);
    row.addEventListener('click', () => {
      openConversation(conv.conversationId, conv.peerId).catch((error) => {
        console.error(error);
      });
    });

    els.chatList.appendChild(row);
  }
}

function renderMessages() {
  const shouldStickBottom = isNearBottom();
  const sorted = [...state.messagesById.values()].sort(
    (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime()
  );

  els.messages.innerHTML = '';
  const me = normalizeId(state.user?.userId);

  for (const message of sorted) {
    const mine = normalizeId(message.sender) === me;

    const row = document.createElement('article');
    row.className = `message ${mine ? 'outgoing' : 'incoming'}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    const body = document.createElement('div');
    body.textContent = message.text || '[empty message]';

    const meta = document.createElement('div');
    meta.className = 'meta';

    const left = document.createElement('span');
    left.textContent = formatTime(message.receivedAt);
    meta.appendChild(left);

    const tick = statusTicks(message);
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

function wsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(state.token)}`;
}

function closeSocket() {
  if (!state.socket) return;
  state.socket.onclose = null;
  state.socket.onerror = null;
  state.socket.close();
  state.socket = null;
}

function scheduleReconnect(reason = 'Reconnecting...') {
  if (state.reconnectTimer) return;

  const delay = Math.min(RETRY_BASE_MS * 2 ** state.retryAttempt, RETRY_MAX_MS);
  const jitter = Math.floor(Math.random() * 400);
  const waitMs = delay + jitter;
  state.retryAttempt += 1;

  setConnection('reconnecting', `${reason} retry in ${Math.round(waitMs / 1000)}s`);

  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    try {
      await connectRealtime();
    } catch (error) {
      setConnection('reconnecting', error.message);
      scheduleReconnect('Reconnect failed');
    }
  }, waitMs);
}

function upsertIncomingMessage(message) {
  if (message.conversationId !== state.activeConversationId) return;
  const existing = state.messagesById.get(message.id) || {};
  state.messagesById.set(message.id, { ...existing, ...message });
  renderMessages();
  autoReadVisibleMessages().catch(() => {});
}

function applyStatusUpdate(update) {
  if (update.conversationId !== state.activeConversationId) return;
  const existing = state.messagesById.get(update.id);
  if (!existing) return;
  state.messagesById.set(update.id, { ...existing, ...update });
  renderMessages();
}

async function connectRealtime() {
  closeSocket();

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  setConnection('connecting', 'Connecting...');
  state.socket = new WebSocket(wsUrl());

  state.socket.onopen = () => {
    state.retryAttempt = 0;
    setConnection('connected', 'Connected');
  };

  state.socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.event === 'message') {
        upsertIncomingMessage(payload.data);
        refreshConversations().catch(() => {});
      } else if (payload.event === 'message_status') {
        applyStatusUpdate(payload.data);
        refreshConversations().catch(() => {});
      }
    } catch (error) {
      console.error(error);
    }
  };

  state.socket.onerror = () => {
    setConnection('disconnected', 'Disconnected');
  };

  state.socket.onclose = () => {
    setConnection('disconnected', 'Disconnected');
    scheduleReconnect('Disconnected');
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...authHeaders()
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

async function refreshConversations() {
  const payload = await api('/conversations');
  state.conversations = payload.conversations || [];
  renderChatList();

  if (!state.activeConversationId && state.conversations.length) {
    const first = state.conversations[0];
    await openConversation(first.conversationId, first.peerId);
  }
}

async function loadMessages({ before = '', append = false } = {}) {
  if (!state.activeConversationId) return;

  const params = new URLSearchParams();
  params.set('conversationId', state.activeConversationId);
  params.set('limit', append ? '60' : '120');
  if (before) params.set('before', before);

  const payload = await api(`/messages?${params.toString()}`);

  if (!append) {
    state.messagesById.clear();
  }

  payload.messages.forEach((message) => {
    const existing = state.messagesById.get(message.id) || {};
    state.messagesById.set(message.id, { ...existing, ...message });
  });

  state.nextCursor = payload.nextCursor || null;
  renderMessages();
  autoReadVisibleMessages().catch(() => {});
}

async function loadOlderOnScroll() {
  if (!state.nextCursor || state.loadingOlder || !state.activeConversationId) return;
  state.loadingOlder = true;

  const prevHeight = els.messages.scrollHeight;
  const prevTop = els.messages.scrollTop;
  try {
    await loadMessages({ before: state.nextCursor, append: true });
    const delta = els.messages.scrollHeight - prevHeight;
    els.messages.scrollTop = prevTop + delta;
  } finally {
    state.loadingOlder = false;
  }
}

async function markAsRead(messageId) {
  if (state.inflightReadIds.has(messageId)) return;
  state.inflightReadIds.add(messageId);
  try {
    const payload = await api(`/messages/${encodeURIComponent(messageId)}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (payload.message) {
      upsertIncomingMessage(payload.message);
    }
  } finally {
    state.inflightReadIds.delete(messageId);
  }
}

async function autoReadVisibleMessages() {
  if (!isForegroundActive() || !state.user) return;
  const me = normalizeId(state.user.userId);

  const unread = [];
  for (const message of state.messagesById.values()) {
    if (normalizeId(message.recipient) === me && message.status !== 'read' && !state.inflightReadIds.has(message.id)) {
      unread.push(message.id);
    }
  }

  for (const id of unread) {
    try {
      await markAsRead(id);
    } catch (error) {
      console.error(error);
    }
  }
}

function startTimers() {
  if (!state.liveSyncTimer) {
    state.liveSyncTimer = setInterval(() => {
      refreshConversations().catch(() => {});
      if (state.activeConversationId) {
        loadMessages().catch(() => {});
      }
    }, LIVE_SYNC_MS);
  }

  if (!state.readSweepTimer) {
    state.readSweepTimer = setInterval(() => {
      autoReadVisibleMessages().catch(() => {});
    }, READ_SWEEP_MS);
  }
}

async function openConversation(conversationId, peerId) {
  state.activeConversationId = conversationId;
  state.activePeerId = peerId || '';
  saveSession();

  els.chatTitle.textContent = peerId || conversationId;
  renderChatList();
  await loadMessages();
}

async function sendMessage(event) {
  event.preventDefault();

  const text = els.input.value.trim();
  if (!text || !state.activeConversationId) return;

  const recipient = state.activePeerId || normalizeId(els.newChatPeer.value);
  if (!recipient) return;

  await api('/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: state.activeConversationId,
      recipient,
      text
    })
  });

  els.input.value = '';
  els.input.focus();
}

async function createOrOpenDirect(peerInput) {
  const peerId = normalizeId(peerInput);
  if (!peerId) return;
  if (!state.user) return;

  const payload = await api(`/conversations/direct?peerId=${encodeURIComponent(peerId)}`, {
    method: 'POST'
  });
  const conversationId = payload.conversationId || directConversationId(state.user.userId, peerId);
  await refreshConversations();
  await openConversation(conversationId, peerId);
}

function showAuth(status = '', mode = 'login') {
  els.authView.classList.remove('hidden');
  els.chatView.classList.add('hidden');
  els.authStatus.textContent = status;
  setAuthMode(mode);
}

function showChat() {
  els.authView.classList.add('hidden');
  els.chatView.classList.remove('hidden');
  els.currentUser.textContent = `@${state.user.userId}`;
}

function setAuthMode(mode) {
  state.authMode = mode === 'register' ? 'register' : 'login';
  const isRegister = state.authMode === 'register';

  els.authModeLogin.classList.toggle('active', !isRegister);
  els.authModeRegister.classList.toggle('active', isRegister);
  els.authDisplayGroup.classList.toggle('hidden', !isRegister);
  els.authSubmitBtn.textContent = isRegister ? 'Create account' : 'Login';
  els.authModeHint.textContent = isRegister
    ? 'Create your account. After registering, sign in from Login.'
    : 'Sign in to continue.';
}

async function bootstrapFromSession() {
  const session = loadSession();
  if (!session.token) {
    try {
      const status = await api('/auth/status');
      if (!status.hasUsers) {
        showAuth('No users found. Please register first.', 'register');
      } else {
        showAuth('', 'login');
      }
    } catch {
      showAuth('', 'login');
    }
    return;
  }

  state.token = session.token;

  try {
    const me = await api('/auth/me');
    state.user = me.user;
    showChat();
    await refreshConversations();

    if (session.activeConversationId) {
      const match = state.conversations.find((c) => c.conversationId === session.activeConversationId);
      if (match) {
        await openConversation(match.conversationId, match.peerId);
      }
    }

    await connectRealtime();
    startTimers();
  } catch {
    state.token = '';
    state.user = null;
    clearSession();
    showAuth('Session expired. Please login again.', 'login');
  }
}

function wireEvents() {
  els.authPassToggle.addEventListener('click', () => {
    const showing = els.authPass.type === 'text';
    els.authPass.type = showing ? 'password' : 'text';
    els.authPassToggle.textContent = showing ? '👁' : '🙈';
    els.authPassToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    els.authPassToggle.setAttribute('title', showing ? 'Show password' : 'Hide password');
  });

  els.authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const userId = normalizeId(els.authUser.value);
    const password = els.authPass.value;

    if (state.authMode === 'register') {
      const displayName = els.authDisplay.value.trim();
      try {
        await api('/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, password, displayName })
        });
        els.authPass.value = '';
        setAuthMode('login');
        showAuth('Registration successful. Please login.', 'login');
      } catch (error) {
        showAuth(error.message, 'register');
      }
      return;
    }

    try {
      const payload = await api('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, password })
      });

      state.token = payload.session.token;
      state.user = payload.user;
      saveSession();
      showChat();
      await refreshConversations();
      await connectRealtime();
      startTimers();
    } catch (error) {
      showAuth(error.message, 'login');
    }
  });

  els.authModeLogin.addEventListener('click', () => {
    setAuthMode('login');
    els.authStatus.textContent = '';
  });

  els.authModeRegister.addEventListener('click', () => {
    setAuthMode('register');
    els.authStatus.textContent = '';
  });

  els.logoutBtn.addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // ignore logout network errors
    }

    closeSocket();
    state.token = '';
    state.user = null;
    state.activeConversationId = '';
    state.activePeerId = '';
    state.conversations = [];
    state.messagesById.clear();
    clearSession();
    showAuth('Logged out.');
  });

  els.newChatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    createOrOpenDirect(els.newChatPeer.value).catch((error) => {
      console.error(error);
    });
    els.newChatPeer.value = '';
  });

  els.reconnectBtn.addEventListener('click', () => {
    connectRealtime().catch((error) => {
      setConnection('reconnecting', error.message);
      scheduleReconnect('Manual reconnect failed');
    });
  });

  els.messages.addEventListener('scroll', () => {
    if (els.messages.scrollTop > 40) return;
    loadOlderOnScroll().catch((error) => {
      console.error(error);
    });
  });

  els.composer.addEventListener('submit', (event) => {
    sendMessage(event).catch((error) => {
      console.error(error);
    });
  });

  window.addEventListener('focus', () => {
    autoReadVisibleMessages().catch(() => {});
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      connectRealtime().catch(() => {
        scheduleReconnect('Resuming...');
      });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      autoReadVisibleMessages().catch(() => {});
    }
  });
}

wireEvents();
bootstrapFromSession().catch((error) => {
  console.error(error);
  showAuth('Failed to initialize app.');
});
