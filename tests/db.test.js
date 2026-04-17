'use strict';

const { createDb } = require('../src/db');

describe('createDb', () => {
  let db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  test('insertViolation returns saved row with id and received_at', () => {
    const row = db.insertViolation({
      document_uri: 'https://example.com/page',
      referrer: null,
      violated_directive: 'script-src',
      effective_directive: 'script-src',
      original_policy: "default-src 'self'",
      blocked_uri: 'https://evil.com/bad.js',
      status_code: 0,
      source_file: null,
      line_number: null,
      column_number: null,
      raw: '{}',
    });

    expect(row).toBeDefined();
    expect(typeof row.id).toBe('number');
    expect(row.id).toBeGreaterThan(0);
    expect(row.document_uri).toBe('https://example.com/page');
    expect(row.violated_directive).toBe('script-src');
    expect(row.blocked_uri).toBe('https://evil.com/bad.js');
    expect(row.received_at).toBeTruthy();
  });

  test('insertViolation handles null fields', () => {
    const row = db.insertViolation({
      document_uri: null,
      referrer: null,
      violated_directive: null,
      effective_directive: null,
      original_policy: null,
      blocked_uri: null,
      status_code: null,
      source_file: null,
      line_number: null,
      column_number: null,
      raw: '{"test":true}',
    });

    expect(row.id).toBeGreaterThan(0);
    expect(row.document_uri).toBeNull();
    expect(row.raw).toBe('{"test":true}');
  });

  test('getViolationsSince returns rows on or after the given ISO string', () => {
    const past = '2000-01-01T00:00:00.000Z';
    const future = '2099-01-01T00:00:00.000Z';

    db.insertViolation({
      document_uri: 'https://a.com', referrer: null, violated_directive: 'script-src',
      effective_directive: null, original_policy: null, blocked_uri: null,
      status_code: null, source_file: null, line_number: null, column_number: null,
      raw: '{}',
    });

    const results = db.getViolationsSince(past);
    expect(results.length).toBe(1);

    const none = db.getViolationsSince(future);
    expect(none.length).toBe(0);
  });

  test('getViolationsSince returns multiple rows ordered descending', () => {
    for (let i = 0; i < 3; i++) {
      db.insertViolation({
        document_uri: `https://example.com/${i}`,
        referrer: null, violated_directive: 'script-src',
        effective_directive: null, original_policy: null, blocked_uri: null,
        status_code: null, source_file: null, line_number: null, column_number: null,
        raw: '{}',
      });
    }

    const results = db.getViolationsSince('2000-01-01T00:00:00.000Z');
    expect(results.length).toBe(3);
    // Descending order: later ids first
    expect(results[0].id).toBeGreaterThan(results[1].id);
  });

  test('multiple db instances use separate in-memory databases', () => {
    const db2 = createDb(':memory:');
    db2.insertViolation({
      document_uri: 'https://other.com', referrer: null, violated_directive: 'img-src',
      effective_directive: null, original_policy: null, blocked_uri: null,
      status_code: null, source_file: null, line_number: null, column_number: null,
      raw: '{}',
    });

    const db1Results = db.getViolationsSince('2000-01-01T00:00:00.000Z');
    const db2Results = db2.getViolationsSince('2000-01-01T00:00:00.000Z');

    expect(db1Results.length).toBe(0);
    expect(db2Results.length).toBe(1);

    db2.close();
  });
});
