# Realtime Messaging Webhook POC

Proof-of-concept service that captures incoming/outgoing messages via webhook, processes them, stores them, and forwards them to desktop consumers.

## What this POC includes

- `POST /webhook/incoming`: capture incoming message events
- `POST /webhook/outgoing`: capture outgoing message events
- lightweight processing: normalize schema + derive tags (`urgent`, `problem`, etc.)
- persistence: append-only `data/messages.ndjson`
- forwarding:
  - live push to desktop consumers via `GET /stream` (Server-Sent Events)
  - optional forward to another webhook (`FORWARD_WEBHOOK_URL`)
- query API: `GET /messages?direction=incoming|outgoing&limit=50`
- health API: `GET /health`

## Run

```bash
npm start
```

Server starts at `http://localhost:8080` by default.

## Web UI (WhatsApp-like POC)

Open `http://localhost:8080` in your browser.

- Use **Send as me** to post to `/webhook/outgoing`
- Use **Simulate incoming** to post to `/webhook/incoming`
- Messages update in real-time through `/stream`
- If `WEBHOOK_TOKEN` is set, enter it in the UI token field and click **Reconnect stream**

## Optional configuration

- `HOST`: bind host (default: `0.0.0.0`)
- `PORT`: server port (default: `8080`)
- `WEBHOOK_TOKEN`: if set, requires `Authorization: Bearer <token>` for webhook, stream, and message listing endpoints
- `FORWARD_WEBHOOK_URL`: if set, each processed message is POSTed there

Example:

```bash
WEBHOOK_TOKEN=secret FORWARD_WEBHOOK_URL=http://localhost:9000/ingest npm start
```

## Use with another person

1. Start server on your machine:
```bash
HOST=0.0.0.0 PORT=8080 WEBHOOK_TOKEN=shared-secret npm start
```
2. Find your machine IP (example: `192.168.1.25`).
3. Both people open:
`http://192.168.1.25:8080`
4. In the UI, both enter `shared-secret` as Token and click **Reconnect stream**.
5. Set `Me` and `Contact` IDs accordingly (for example user A: `alice` -> `bob`, user B: `bob` -> `alice`).

## Publish to GitHub

```bash
git add .
git commit -m "Build realtime messaging webhook POC with chat UI"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

If `origin` already exists, run:

```bash
git remote set-url origin <your-github-repo-url>
git push -u origin main
```

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

## Desktop app consumption example

Run the sample consumer:

```bash
node docs/desktop-consumer-example.js
```

This connects to `/stream` and prints each processed message in real time.
