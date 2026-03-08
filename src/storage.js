const path = require('path');
const fs = require('fs/promises');
const Database = require('better-sqlite3');

class MessageStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'messages.db');
    this.db = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'participant',
        joined_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, user_id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id),
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        channel TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        text TEXT NOT NULL,
        metadata TEXT NOT NULL,
        provider_timestamp TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        tags TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
      );

      CREATE TABLE IF NOT EXISTS message_receipts (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id),
        FOREIGN KEY (message_id) REFERENCES messages(id),
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conv_received
        ON messages(conversation_id, received_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_direction_received
        ON messages(direction, received_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_receipts_message
        ON message_receipts(message_id);
    `);

    this.upsertUserStmt = this.db.prepare(`
      INSERT INTO users (user_id, display_name, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name
    `);

    this.upsertConversationStmt = this.db.prepare(`
      INSERT INTO conversations (conversation_id, created_at)
      VALUES (?, ?)
      ON CONFLICT(conversation_id) DO NOTHING
    `);

    this.upsertConversationMemberStmt = this.db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
      VALUES (?, ?, 'participant', ?)
      ON CONFLICT(conversation_id, user_id) DO NOTHING
    `);

    this.insertMessageStmt = this.db.prepare(`
      INSERT INTO messages (
        id, conversation_id, direction, channel, sender_id, recipient_id,
        text, metadata, provider_timestamp, received_at, processed_at, tags
      ) VALUES (
        @id, @conversation_id, @direction, @channel, @sender_id, @recipient_id,
        @text, @metadata, @provider_timestamp, @received_at, @processed_at, @tags
      )
    `);

    this.upsertReceiptStmt = this.db.prepare(`
      INSERT INTO message_receipts (message_id, user_id, status, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id, user_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
    `);

    this.listMessagesBase = `
      SELECT
        m.id,
        m.conversation_id,
        m.direction,
        m.channel,
        m.sender_id,
        m.recipient_id,
        m.text,
        m.metadata,
        m.provider_timestamp,
        m.received_at,
        m.processed_at,
        m.tags,
        rr.status AS recipient_status,
        rr.updated_at AS recipient_status_at
      FROM messages m
      LEFT JOIN message_receipts rr
        ON rr.message_id = m.id AND rr.user_id = m.recipient_id
    `;

    this.getMessageStmt = this.db.prepare(`
      SELECT
        m.id,
        m.conversation_id,
        m.direction,
        m.channel,
        m.sender_id,
        m.recipient_id,
        m.text,
        m.metadata,
        m.provider_timestamp,
        m.received_at,
        m.processed_at,
        m.tags,
        rr.status AS recipient_status,
        rr.updated_at AS recipient_status_at
      FROM messages m
      LEFT JOIN message_receipts rr
        ON rr.message_id = m.id AND rr.user_id = m.recipient_id
      WHERE m.id = ?
    `);

    this.countMessagesStmt = this.db.prepare('SELECT COUNT(1) AS count FROM messages');
    this.countConversationsStmt = this.db.prepare('SELECT COUNT(1) AS count FROM conversations');

    this.addMessageTx = this.db.transaction((message) => {
      const now = new Date().toISOString();
      this.upsertUserStmt.run(message.sender, message.sender, now);
      this.upsertUserStmt.run(message.recipient, message.recipient, now);
      this.upsertConversationStmt.run(message.conversationId, now);
      this.upsertConversationMemberStmt.run(message.conversationId, message.sender, now);
      this.upsertConversationMemberStmt.run(message.conversationId, message.recipient, now);

      this.insertMessageStmt.run(this.serializeMessage(message));

      this.upsertReceiptStmt.run(message.id, message.sender, 'sent', now);
      this.upsertReceiptStmt.run(message.id, message.recipient, 'delivered', now);
    });
  }

  serializeMessage(message) {
    return {
      id: message.id,
      conversation_id: message.conversationId,
      direction: message.direction,
      channel: message.channel,
      sender_id: message.sender,
      recipient_id: message.recipient,
      text: message.text,
      metadata: JSON.stringify(message.metadata || {}),
      provider_timestamp: message.providerTimestamp || null,
      received_at: message.receivedAt,
      processed_at: message.processedAt,
      tags: JSON.stringify(message.tags || [])
    };
  }

  deserializeMessage(row) {
    if (!row) return null;

    const recipientStatus = row.recipient_status || 'delivered';
    const isRead = recipientStatus === 'read';

    return {
      id: row.id,
      conversationId: row.conversation_id,
      direction: row.direction,
      channel: row.channel,
      sender: row.sender_id,
      recipient: row.recipient_id,
      text: row.text,
      metadata: safeJson(row.metadata, {}),
      status: isRead ? 'read' : recipientStatus,
      providerTimestamp: row.provider_timestamp,
      receivedAt: row.received_at,
      processedAt: row.processed_at,
      tags: safeJson(row.tags, []),
      readAt: isRead ? row.recipient_status_at : null,
      readBy: isRead ? row.recipient_id : null
    };
  }

  addMessage(message) {
    this.addMessageTx(message);
  }

  listMessages({ direction, limit, conversationId, beforeCursor }) {
    const safeLimit = Math.min(Math.max(Number(limit || 50), 1), 500);
    const clauses = [];
    const params = [];

    if (direction === 'incoming' || direction === 'outgoing') {
      clauses.push('m.direction = ?');
      params.push(direction);
    }

    if (conversationId) {
      clauses.push('m.conversation_id = ?');
      params.push(conversationId);
    }

    const decodedCursor = decodeCursor(beforeCursor);
    if (decodedCursor) {
      clauses.push('(m.received_at < ? OR (m.received_at = ? AND m.id < ?))');
      params.push(decodedCursor.receivedAt, decodedCursor.receivedAt, decodedCursor.id);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `${this.listMessagesBase} ${where} ORDER BY m.received_at DESC, m.id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, safeLimit);
    const messages = rows.map((row) => this.deserializeMessage(row));

    let nextCursor = null;
    if (rows.length === safeLimit) {
      const last = rows[rows.length - 1];
      nextCursor = encodeCursor({ receivedAt: last.received_at, id: last.id });
    }

    return { messages, nextCursor };
  }

  markAsRead(messageId, reader) {
    const now = new Date().toISOString();
    this.upsertUserStmt.run(reader, reader, now);
    this.upsertReceiptStmt.run(messageId, reader, 'read', now);
    return this.getById(messageId);
  }

  getById(messageId) {
    return this.deserializeMessage(this.getMessageStmt.get(messageId));
  }

  countMessages() {
    return this.countMessagesStmt.get().count;
  }

  countConversations() {
    return this.countConversationsStmt.get().count;
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

function safeJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed?.receivedAt || !parsed?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = { MessageStore };
