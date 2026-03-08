# POC Architecture

1. Source system sends event to `/webhook/incoming` or `/webhook/outgoing`.
2. Service validates auth (optional bearer token).
3. Payload is normalized into a stable message schema.
4. Processor enriches message with tags and internal timestamps.
5. Message is appended to `data/messages.ndjson` and retained in memory for fast reads.
6. Service forwards message to:
   - connected desktop clients via SSE (`/stream`)
   - optional downstream webhook (`FORWARD_WEBHOOK_URL`)
7. Consumers can query stored events using `/messages`.

## Message schema

```json
{
  "id": "uuid",
  "direction": "incoming|outgoing",
  "channel": "desktop|whatsapp|sms|...",
  "sender": "string",
  "recipient": "string",
  "text": "string",
  "metadata": {},
  "status": "received|sent|...",
  "providerTimestamp": "ISO timestamp or null",
  "receivedAt": "ISO timestamp",
  "processedAt": "ISO timestamp",
  "tags": ["urgent", "problem", "greeting"]
}
```
