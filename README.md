# Realtime Messaging Webhook POC

Multi-user chat POC with account login, realtime updates, conversation list, read receipts, webhook ingestion, and SQLite persistence.

## Features

- User accounts:
  - `POST /auth/register`
  - `POST /auth/login`
  - `POST /auth/logout`
  - `GET /auth/me`
- Session-based auth token (Bearer token)
- Conversation list for logged-in user:
  - `GET /conversations`
  - `POST /conversations/direct?peerId=<user>`
- Per-user authorization on conversation access:
  - `GET /messages?conversationId=<id>&limit=<n>&before=<cursor>`
  - `POST /messages`
  - `POST /messages/:id/read`
- Realtime transport:
  - `GET /ws` (WebSocket)
  - `GET /stream` (SSE fallback)
- Webhook ingestion (integration path):
  - `POST /webhook/incoming`
  - `POST /webhook/outgoing`
- SQLite storage: `data/messages.db`

## Data model (SQLite)

- `users`
- `sessions`
- `conversations`
- `conversation_members`
- `messages`
- `message_receipts`

## Run

```bash
npm install
npm start
```

App URL: `http://localhost:8080`

## Web app usage

1. Register a user (or login if already registered).
2. Open/start a chat by entering a peer username.
3. Select a conversation from chat list.
4. Send messages in realtime.
5. Scroll to top of chat to auto-load older messages.

Read receipts are automatic when recipient tab is foreground/focused.

## Optional env

- `HOST` (default `0.0.0.0`)
- `PORT` (default `8080`)
- `SESSION_TTL_HOURS` (default `168`)
- `WEBHOOK_TOKEN` (optional secret for webhook endpoints)
- `FORWARD_WEBHOOK_URL` (optional downstream forwarding)

## API examples

Register:

```bash
curl -X POST http://localhost:8080/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"userId":"alice","displayName":"Alice","password":"pass1234"}'
```

Login:

```bash
curl -X POST http://localhost:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"userId":"alice","password":"pass1234"}'
```

Create/open direct conversation:

```bash
curl -X POST 'http://localhost:8080/conversations/direct?peerId=bob' \
  -H 'Authorization: Bearer <session-token>'
```

List conversations:

```bash
curl 'http://localhost:8080/conversations' \
  -H 'Authorization: Bearer <session-token>'
```

Send message:

```bash
curl -X POST http://localhost:8080/messages \
  -H 'Authorization: Bearer <session-token>' \
  -H 'Content-Type: application/json' \
  -d '{"recipient":"bob","text":"Hello Bob"}'
```

Get messages (cursor pagination):

```bash
curl 'http://localhost:8080/messages?conversationId=direct:alice:bob&limit=20' \
  -H 'Authorization: Bearer <session-token>'
```

Older page:

```bash
curl 'http://localhost:8080/messages?conversationId=direct:alice:bob&limit=20&before=<nextCursor>' \
  -H 'Authorization: Bearer <session-token>'
```

Mark read:

```bash
curl -X POST http://localhost:8080/messages/<message-id>/read \
  -H 'Authorization: Bearer <session-token>'
```

## Share publicly

Use tunnel script:

```bash
WEBHOOK_TOKEN=shared-secret npm run share:cloudflared
```

The script prints a `Public URL: https://...` line.

## Security notes

- Use strong passwords even for POC users.
- Keep session tokens private.
- Set `WEBHOOK_TOKEN` before exposing webhook endpoints.
