'use strict';

const Database = require('better-sqlite3');

function createDb(dbPath = './violations.db') {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS violations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      document_uri TEXT,
      referrer     TEXT,
      violated_directive  TEXT,
      effective_directive TEXT,
      original_policy     TEXT,
      blocked_uri  TEXT,
      status_code  INTEGER,
      source_file  TEXT,
      line_number  INTEGER,
      column_number INTEGER,
      raw          TEXT NOT NULL
    )
  `);

  const stmts = {
    insert: db.prepare(`
      INSERT INTO violations (
        document_uri, referrer, violated_directive, effective_directive,
        original_policy, blocked_uri, status_code, source_file,
        line_number, column_number, raw
      ) VALUES (
        @document_uri, @referrer, @violated_directive, @effective_directive,
        @original_policy, @blocked_uri, @status_code, @source_file,
        @line_number, @column_number, @raw
      )
    `),
    selectById: db.prepare('SELECT * FROM violations WHERE id = ?'),
    selectSince: db.prepare(`
      SELECT * FROM violations
      WHERE received_at >= ?
      ORDER BY received_at DESC, id DESC
    `),
  };

  return {
    insertViolation(violation) {
      const result = stmts.insert.run(violation);
      return stmts.selectById.get(result.lastInsertRowid);
    },

    getViolationsSince(since) {
      return stmts.selectSince.all(since);
    },

    close() {
      db.close();
    },
  };
}

module.exports = { createDb };
