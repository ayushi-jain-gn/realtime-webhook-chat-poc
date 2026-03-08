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
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        channel TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        text TEXT NOT NULL,
        metadata TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_timestamp TEXT,
        received_at TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        tags TEXT NOT NULL,
        read_at TEXT,
        read_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_received_at
        ON messages(received_at DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_direction_received_at
        ON messages(direction, received_at DESC);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO messages (
        id, direction, channel, sender, recipient, text, metadata, status,
        provider_timestamp, received_at, processed_at, tags, read_at, read_by
      ) VALUES (
        @id, @direction, @channel, @sender, @recipient, @text, @metadata, @status,
        @provider_timestamp, @received_at, @processed_at, @tags, @read_at, @read_by
      )
    `);

    this.byIdStmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    this.listStmt = this.db.prepare('SELECT * FROM messages ORDER BY received_at DESC LIMIT ?');
    this.listByDirectionStmt = this.db.prepare(
      'SELECT * FROM messages WHERE direction = ? ORDER BY received_at DESC LIMIT ?'
    );
    this.markReadStmt = this.db.prepare(
      `UPDATE messages
       SET status = 'read', read_at = ?, read_by = ?
       WHERE id = ?`
    );
    this.countStmt = this.db.prepare('SELECT COUNT(1) AS count FROM messages');
  }

  serialize(message) {
    return {
      id: message.id,
      direction: message.direction,
      channel: message.channel,
      sender: message.sender,
      recipient: message.recipient,
      text: message.text,
      metadata: JSON.stringify(message.metadata || {}),
      status: message.status,
      provider_timestamp: message.providerTimestamp || null,
      received_at: message.receivedAt,
      processed_at: message.processedAt,
      tags: JSON.stringify(message.tags || []),
      read_at: message.readAt || null,
      read_by: message.readBy || null
    };
  }

  deserialize(row) {
    if (!row) return null;
    return {
      id: row.id,
      direction: row.direction,
      channel: row.channel,
      sender: row.sender,
      recipient: row.recipient,
      text: row.text,
      metadata: safeJson(row.metadata, {}),
      status: row.status,
      providerTimestamp: row.provider_timestamp,
      receivedAt: row.received_at,
      processedAt: row.processed_at,
      tags: safeJson(row.tags, []),
      readAt: row.read_at,
      readBy: row.read_by
    };
  }

  addMessage(message) {
    this.insertStmt.run(this.serialize(message));
  }

  listMessages({ direction, limit }) {
    const safeLimit = Math.min(Number(limit || 50), 500);
    const rows =
      direction === 'incoming' || direction === 'outgoing'
        ? this.listByDirectionStmt.all(direction, safeLimit)
        : this.listStmt.all(safeLimit);
    return rows.map((row) => this.deserialize(row));
  }

  markAsRead(messageId, reader) {
    const readAt = new Date().toISOString();
    const result = this.markReadStmt.run(readAt, reader, messageId);
    if (!result.changes) return null;
    return this.getById(messageId);
  }

  getById(messageId) {
    return this.deserialize(this.byIdStmt.get(messageId));
  }

  count() {
    return this.countStmt.get().count;
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

module.exports = { MessageStore };
