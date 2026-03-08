const els = {
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  direction: document.getElementById('direction'),
  input: document.getElementById('message-input'),
  myId: document.getElementById('my-id'),
  peerId: document.getElementById('peer-id'),
  token: document.getElementById('token'),
  status: document.getElementById('connection-status'),
  title: document.getElementById('chat-title'),
  connectBtn: document.getElementById('connect-btn')
};

let stream;
const seen = new Set();

function authHeaders() {
  const token = els.token.value.trim();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function connectionText(text) {
  els.status.textContent = text;
}

function formatTime(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addMessage(message) {
  if (seen.has(message.id)) return;
  seen.add(message.id);

  const row = document.createElement('article');
  row.className = `message ${message.direction}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const body = document.createElement('div');
  body.textContent = message.text || '[empty message]';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${message.sender} -> ${message.recipient} • ${formatTime(message.receivedAt)}`;

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

function connectStream() {
  if (stream) {
    stream.close();
  }

  const queryToken = els.token.value.trim();
  const url = queryToken ? `/stream?token=${encodeURIComponent(queryToken)}` : '/stream';

  stream = new EventSource(url);

  stream.addEventListener('open', () => {
    connectionText('Connected');
  });

  stream.addEventListener('message', (event) => {
    try {
      addMessage(JSON.parse(event.data));
    } catch (error) {
      console.error(error);
    }
  });

  stream.addEventListener('error', () => {
    connectionText('Disconnected, retrying...');
  });
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

function syncTitle() {
  els.title.textContent = els.peerId.value.trim() || 'Contact';
}

function init() {
  els.composer.addEventListener('submit', (event) => {
    sendMessage(event).catch((error) => {
      console.error(error);
      alert(error.message);
    });
  });

  els.connectBtn.addEventListener('click', () => {
    loadHistory()
      .then(connectStream)
      .catch((error) => {
        console.error(error);
        connectionText(error.message);
      });
  });

  els.peerId.addEventListener('input', syncTitle);
  syncTitle();

  loadHistory()
    .then(connectStream)
    .catch((error) => {
      console.error(error);
      connectionText(error.message);
    });
}

init();
