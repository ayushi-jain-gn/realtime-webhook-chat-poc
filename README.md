# Realtime Messaging Webhook POC

Proof-of-concept service that captures incoming/outgoing messages via webhook, processes them, stores them, and forwards them to desktop consumers.

## What this POC includes

- `POST /webhook/incoming`: capture incoming message events
- `POST /webhook/outgoing`: capture outgoing message events
- lightweight processing: normalize schema + derive tags (`urgent`, `problem`, etc.)
- persistence: SQLite (`data/messages.db`)
- forwarding:
  - live push to clients via `GET /ws` (WebSocket) and `GET /stream` (SSE fallback)
  - optional forward to another webhook (`FORWARD_WEBHOOK_URL`)
- query API: `GET /messages?direction=incoming|outgoing&limit=50`
- read-receipts API: `POST /messages/:id/read`
- health API: `GET /health`

## Run

```bash
npm install
```

```bash
npm start
```

Server starts at `http://localhost:8080` by default.

## Web UI (WhatsApp-like POC)

Open `http://localhost:8080` in your browser.

- Use **Send as me** to post to `/webhook/outgoing`
- Use **Simulate incoming** to post to `/webhook/incoming`
- Messages update in real-time via WebSocket (`/ws`)
- Incoming messages can be marked as read, and read status syncs instantly across users
- If `WEBHOOK_TOKEN` is set, enter it in the UI token field (manual reconnect is optional)

## Optional configuration

- `HOST`: bind host (default: `0.0.0.0`)
- `PORT`: server port (default: `8080`)
- `WEBHOOK_TOKEN`: if set, requires `Authorization: Bearer <token>` for webhook, stream, and message listing endpoints
- `FORWARD_WEBHOOK_URL`: if set, each processed message is POSTed there

Example:

```bash
WEBHOOK_TOKEN=secret FORWARD_WEBHOOK_URL=http://localhost:9000/ingest npm start
```

## Use with another person (same networks)

1. Start server on your machine:
```bash
HOST=0.0.0.0 PORT=8080 WEBHOOK_TOKEN=shared-secret npm start
```
2. Find your machine IP on the same Wi-Fi/LAN:
   - macOS:
   ```bash
   ipconfig getifaddr en0 || ipconfig getifaddr en1
   ```
   - Linux:
   ```bash
   hostname -I | awk '{print $1}'
   ```
   - Windows (PowerShell):
   ```powershell
   (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.InterfaceAlias -notmatch "Loopback"} | Select-Object -First 1).IPAddress
   ```
   Example result: `192.168.1.25`
3. Both people open:
`http://192.168.1.25:8080`
4. In the UI, both enter `shared-secret` as Token and click **Reconnect stream**.
5. Set `Me` and `Contact` IDs accordingly (for example user A: `alice` -> `bob`, user B: `bob` -> `alice`).

## Use from anywhere (different networks)

Use a tunnel so people outside your local network can open your app.

### One-command sharing (recommended)

```bash
WEBHOOK_TOKEN="$(openssl rand -hex 24)" npm run share
```

- Auto-picks `ngrok` if installed, otherwise `cloudflared`.
- Starts app + tunnel together and stops both on `Ctrl+C`.

Use explicit provider:

```bash
WEBHOOK_TOKEN=shared-secret npm run share:ngrok
WEBHOOK_TOKEN=shared-secret npm run share:cloudflared
```

### Fixed URL (pre-created named tunnel)

Use Cloudflare named tunnel so the URL stays the same every run.

One-time setup:

```bash
cloudflared tunnel login
cloudflared tunnel create realtime-chat
cloudflared tunnel route dns realtime-chat chat.yourdomain.com
```

Then create `~/.cloudflared/config.yml`:

```yaml
tunnel: realtime-chat
credentials-file: /Users/<you>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: chat.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
```

Daily run with same URL:

```bash
CF_TUNNEL_NAME=realtime-chat WEBHOOK_TOKEN=shared-secret npm run share:cloudflared:named
```

Share `https://chat.yourdomain.com` with users.

### Option A: ngrok

1. Start your app:
```bash
HOST=0.0.0.0 PORT=8080 WEBHOOK_TOKEN=shared-secret npm start
```
2. In a second terminal, start tunnel:
```bash
ngrok http 8080
```
3. Copy the public HTTPS URL from ngrok (example: `https://abc123.ngrok-free.app`).
4. Share that URL with other people.
5. Everyone opens the same URL and enters `shared-secret` in the UI token field.

### Option B: Cloudflare Tunnel

1. Start your app:
```bash
HOST=0.0.0.0 PORT=8080 WEBHOOK_TOKEN=shared-secret npm start
```
2. In a second terminal:
```bash
cloudflared tunnel --url http://localhost:8080
```
3. Copy the public `https://...trycloudflare.com` URL and share it.

## Security notes for public sharing

- Always set `WEBHOOK_TOKEN` before exposing the app publicly.
- Use a strong token (example):
```bash
openssl rand -hex 24
```
- Do not commit real tokens to GitHub.


## Send test events

Incoming:

```bash
curl -X POST http://localhost:8080/webhook/incoming \
  -H 'Content-Type: application/json' \
  -d '{
    "channel": "whatsapp",
    "from": "customer-123",
    "to": "agent-7",
    "text": "Hi, urgent issue: payment failed",
    "metadata": {"threadId": "t-1"}
  }'
```

Outgoing:

```bash
curl -X POST http://localhost:8080/webhook/outgoing \
  -H 'Content-Type: application/json' \
  -d '{
    "channel": "whatsapp",
    "from": "agent-7",
    "to": "customer-123",
    "text": "Hello, we are looking into this now",
    "metadata": {"threadId": "t-1"}
  }'
```

## Inspect messages

```bash
curl 'http://localhost:8080/messages?limit=20'
```

## Mark message as read

```bash
curl -X POST http://localhost:8080/messages/<message-id>/read \
  -H 'Content-Type: application/json' \
  -d '{"reader":"agent-7"}'
```

## Desktop app consumption example

Run the sample consumer:

```bash
node docs/desktop-consumer-example.js
```

This connects to `/stream` and prints each processed message in real time.
