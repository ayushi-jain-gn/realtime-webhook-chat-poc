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
    await this.ensureCompatibleSchema();
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      );

      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
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

      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conv_received ON messages(conversation_id, received_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_receipts_user_status ON message_receipts(user_id, status);
    `);

    this.createUserStmt = this.db.prepare(`
      INSERT INTO users (user_id, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.getUserStmt = this.db.prepare(`
      SELECT user_id, display_name, password_salt, password_hash, created_at
      FROM users
      WHERE user_id = ?
    `);

    this.upsertMinimalUserStmt = this.db.prepare(`
      INSERT INTO users (user_id, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, '', '', ?)
      ON CONFLICT(user_id) DO NOTHING
    `);

    this.createSessionStmt = this.db.prepare(`
      INSERT INTO sessions (token, user_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `);

    this.deleteSessionStmt = this.db.prepare('DELETE FROM sessions WHERE token = ?');

    this.getSessionStmt = this.db.prepare(`
      SELECT s.token, s.user_id, s.expires_at, u.display_name
      FROM sessions s
      JOIN users u ON u.user_id = s.user_id
      WHERE s.token = ?
    `);

    this.cleanupSessionsStmt = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?');

    this.upsertConversationStmt = this.db.prepare(`
      INSERT INTO conversations (conversation_id, type, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(conversation_id) DO NOTHING
    `);

    this.upsertConversationMemberStmt = this.db.prepare(`
      INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
      VALUES (?, ?, 'participant', ?)
      ON CONFLICT(conversation_id, user_id) DO NOTHING
    `);

    this.isMemberStmt = this.db.prepare(
      'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1'
    );

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
    this.countUsersStmt = this.db.prepare('SELECT COUNT(1) AS count FROM users');

    this.addMessageTx = this.db.transaction((message) => {
      const now = new Date().toISOString();
      this.upsertConversationStmt.run(message.conversationId, 'direct', now);
      this.upsertConversationMemberStmt.run(message.conversationId, message.sender, now);
      this.upsertConversationMemberStmt.run(message.conversationId, message.recipient, now);

      this.insertMessageStmt.run(this.serializeMessage(message));

      this.upsertReceiptStmt.run(message.id, message.sender, 'sent', now);
      this.upsertReceiptStmt.run(message.id, message.recipient, 'delivered', now);
    });
  }

  async ensureCompatibleSchema() {
    const hasMessages = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get();

    if (!hasMessages) {
      return;
    }

    const columns = this.db.prepare('PRAGMA table_info(messages)').all().map((col) => col.name);
    const compatible =
      columns.includes('conversation_id') && columns.includes('sender_id') && columns.includes('recipient_id');
    if (compatible) {
      return;
    }

    this.db.close();

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const legacyPath = this.dbPath.replace(/\.db$/, `.legacy-${stamp}.db`);
    await fs.rename(this.dbPath, legacyPath);
    await fs.rm(`${this.dbPath}-wal`, { force: true }).catch(() => {});
    await fs.rm(`${this.dbPath}-shm`, { force: true }).catch(() => {});

    this.db = new Database(this.dbPath);
  }

  cleanupExpiredSessions(nowIso) {
    this.cleanupSessionsStmt.run(nowIso);
  }

  createUser({ userId, displayName, passwordSalt, passwordHash }) {
    const now = new Date().toISOString();
    this.createUserStmt.run(userId, displayName, passwordSalt, passwordHash, now);
  }

  getUserById(userId) {
    return this.getUserStmt.get(userId) || null;
  }

  createSession({ token, userId, expiresAt }) {
    const now = new Date().toISOString();
    this.createSessionStmt.run(token, userId, now, expiresAt);
  }

  deleteSession(token) {
    this.deleteSessionStmt.run(token);
  }

  getSession(token) {
    return this.getSessionStmt.get(token) || null;
  }

  ensureConversationForPair(userA, userB) {
    const normalizedA = String(userA).trim().toLowerCase();
    const normalizedB = String(userB).trim().toLowerCase();
    const members = [normalizedA, normalizedB].sort();
    const conversationId = `direct:${members[0]}:${members[1]}`;
    const now = new Date().toISOString();

    this.upsertMinimalUserStmt.run(normalizedA, normalizedA, now);
    this.upsertMinimalUserStmt.run(normalizedB, normalizedB, now);
    this.upsertConversationStmt.run(conversationId, 'direct', now);
    this.upsertConversationMemberStmt.run(conversationId, normalizedA, now);
    this.upsertConversationMemberStmt.run(conversationId, normalizedB, now);

    return conversationId;
  }

  isConversationMember(conversationId, userId) {
    return Boolean(this.isMemberStmt.get(conversationId, userId));
  }

  listConversationsForUser(userId, limit = 50) {
    const rows = this.db
      .prepare(
        `
        SELECT
          c.conversation_id,
          c.type,
          lm.id AS last_message_id,
          lm.sender_id,
          lm.recipient_id,
          lm.text AS last_message_text,
          lm.received_at AS last_message_at,
          (
            SELECT COUNT(1)
            FROM message_receipts r
            JOIN messages m2 ON m2.id = r.message_id
            WHERE m2.conversation_id = c.conversation_id
              AND r.user_id = ?
              AND r.status != 'read'
              AND m2.recipient_id = ?
          ) AS unread_count
        FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id = c.conversation_id
        LEFT JOIN messages lm
          ON lm.id = (
            SELECT m.id
            FROM messages m
            WHERE m.conversation_id = c.conversation_id
            ORDER BY m.received_at DESC, m.id DESC
            LIMIT 1
          )
        WHERE cm.user_id = ?
        ORDER BY COALESCE(lm.received_at, c.created_at) DESC
        LIMIT ?
      `
      )
      .all(userId, userId, userId, Math.min(Math.max(Number(limit), 1), 200));

    return rows.map((row) => {
      const peerId = peerFromConversation(row.conversation_id, userId);
      return {
        conversationId: row.conversation_id,
        type: row.type,
        peerId,
        lastMessage: row.last_message_id
          ? {
              id: row.last_message_id,
              text: row.last_message_text,
              sender: row.sender_id,
              recipient: row.recipient_id,
              at: row.last_message_at
            }
          : null,
        unreadCount: Number(row.unread_count || 0)
      };
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

  listMessagesForUser({ userId, conversationId, limit, beforeCursor }) {
    if (!this.isConversationMember(conversationId, userId)) {
      return { messages: [], nextCursor: null, unauthorized: true };
    }

    const safeLimit = Math.min(Math.max(Number(limit || 50), 1), 500);
    const params = [conversationId];
    const clauses = ['m.conversation_id = ?'];

    const decodedCursor = decodeCursor(beforeCursor);
    if (decodedCursor) {
      clauses.push('(m.received_at < ? OR (m.received_at = ? AND m.id < ?))');
      params.push(decodedCursor.receivedAt, decodedCursor.receivedAt, decodedCursor.id);
    }

    const sql = `
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
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.received_at DESC, m.id DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params, safeLimit);
    const messages = rows.map((row) => this.deserializeMessage(row));

    let nextCursor = null;
    if (rows.length === safeLimit) {
      const last = rows[rows.length - 1];
      nextCursor = encodeCursor({ receivedAt: last.received_at, id: last.id });
    }

    return { messages, nextCursor, unauthorized: false };
  }

  markAsRead(messageId, reader) {
    const message = this.getById(messageId);
    if (!message) return null;
    if (!this.isConversationMember(message.conversationId, reader)) return null;

    const now = new Date().toISOString();
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

  countUsers() {
    return this.countUsersStmt.get().count;
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

function peerFromConversation(conversationId, userId) {
  if (!conversationId.startsWith('direct:')) return null;
  const parts = conversationId.split(':');
  const a = parts[1] || '';
  const b = parts[2] || '';
  return a === String(userId).toLowerCase() ? b : a;
}

module.exports = { MessageStore };
