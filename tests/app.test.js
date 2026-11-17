'use strict';

const request = require('supertest');
const { createApp, normalizeReport } = require('../src/app');
const { createDb } = require('../src/db');

describe('normalizeReport', () => {
  test('maps legacy report-uri kebab-case fields', () => {
    const report = {
      'document-uri': 'https://example.com',
      'violated-directive': 'script-src',
      'blocked-uri': 'https://evil.com/bad.js',
      'effective-directive': 'script-src',
      'original-policy': "default-src 'self'",
      'referrer': 'https://example.com',
      'status-code': 200,
      'source-file': 'https://example.com/app.js',
      'line-number': 42,
      'column-number': 7,
    };
    const result = normalizeReport(report, 'application/csp-report');

    expect(result.document_uri).toBe('https://example.com');
    expect(result.violated_directive).toBe('script-src');
    expect(result.blocked_uri).toBe('https://evil.com/bad.js');
    expect(result.status_code).toBe(200);
    expect(result.line_number).toBe(42);
    expect(result.raw).toBe(JSON.stringify(report));
  });

  test('maps Reporting API v1 camelCase fields', () => {
    const report = {
      documentURL: 'https://example.com',
      violatedDirective: 'img-src',
      blockedURL: 'https://cdn.evil.com/img.png',
      effectiveDirective: 'img-src',
      originalPolicy: "default-src 'self'",
      referrer: '',
      statusCode: 0,
      sourceFile: null,
      lineNumber: null,
      columnNumber: null,
    };
    const result = normalizeReport(report, 'application/reports+json');

    expect(result.document_uri).toBe('https://example.com');
    expect(result.violated_directive).toBe('img-src');
    expect(result.blocked_uri).toBe('https://cdn.evil.com/img.png');
    expect(result.status_code).toBe(0);
  });

  test('returns null for missing fields', () => {
    const result = normalizeReport({}, 'application/csp-report');
    expect(result.document_uri).toBeNull();
    expect(result.blocked_uri).toBeNull();
  });
});

describe('POST /violations', () => {
  let app, db;

  beforeEach(() => {
    db = createDb(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    db.close();
  });

  test('accepts legacy report-uri format and responds 204', async () => {
    const res = await request(app)
      .post('/violations')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify({
        'csp-report': {
          'document-uri': 'https://example.com',
          'violated-directive': 'script-src',
          'blocked-uri': 'https://evil.com/bad.js',
          'original-policy': "default-src 'self'",
        },
      }));

    expect(res.status).toBe(204);
    const rows = db.getViolationsSince('2000-01-01T00:00:00.000Z');
    expect(rows.length).toBe(1);
    expect(rows[0].document_uri).toBe('https://example.com');
    expect(rows[0].violated_directive).toBe('script-src');
  });

  test('accepts Reporting API v1 array format and responds 204', async () => {
    const res = await request(app)
      .post('/violations')
      .set('Content-Type', 'application/reports+json')
      .send([
        {
          type: 'csp-violation',
          age: 10,
          url: 'https://example.com',
          userAgent: 'Mozilla/5.0',
          body: {
            documentURL: 'https://example.com',
            violatedDirective: 'img-src',
            blockedURL: 'https://cdn.evil.com/img.png',
            originalPolicy: "default-src 'self'",
            statusCode: 0,
          },
        },
      ]);

    expect(res.status).toBe(204);
    const rows = db.getViolationsSince('2000-01-01T00:00:00.000Z');
    expect(rows.length).toBe(1);
    expect(rows[0].violated_directive).toBe('img-src');
    expect(rows[0].blocked_uri).toBe('https://cdn.evil.com/img.png');
  });

  test('filters out non-csp-violation types in reports+json', async () => {
    await request(app)
      .post('/violations')
      .set('Content-Type', 'application/reports+json')
      .send([
        { type: 'network-error', body: {} },
        {
          type: 'csp-violation',
          body: {
            documentURL: 'https://example.com',
            violatedDirective: 'script-src',
            blockedURL: 'https://evil.com/bad.js',
          },
        },
      ]);

    const rows = db.getViolationsSince('2000-01-01T00:00:00.000Z');
    expect(rows.length).toBe(1);
  });

  test('handles multiple csp-violation reports in one request', async () => {
    await request(app)
      .post('/violations')
      .set('Content-Type', 'application/reports+json')
      .send([
        { type: 'csp-violation', body: { documentURL: 'https://a.com', violatedDirective: 'script-src', blockedURL: 'https://evil.com/1.js' } },
        { type: 'csp-violation', body: { documentURL: 'https://b.com', violatedDirective: 'img-src', blockedURL: 'https://evil.com/2.png' } },
      ]);

    const rows = db.getViolationsSince('2000-01-01T00:00:00.000Z');
    expect(rows.length).toBe(2);
  });

  test('accepts application/json content type', async () => {
    const res = await request(app)
      .post('/violations')
      .set('Content-Type', 'application/json')
      .send({
        'csp-report': {
          'document-uri': 'https://bare.com',
          'violated-directive': 'style-src',
        },
      });

    expect(res.status).toBe(204);
  });

  test('returns 400 for non-object body', async () => {
    const res = await request(app)
      .post('/violations')
      .set('Content-Type', 'application/json')
      .send('"just a string"');

    expect(res.status).toBe(400);
  });

  test('emits violation event on app.locals.io when set', async () => {
    const emitted = [];
    app.locals.io = { emit: (event, data) => emitted.push({ event, data }) };

    await request(app)
      .post('/violations')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify({ 'csp-report': { 'document-uri': 'https://example.com', 'violated-directive': 'script-src' } }));

    expect(emitted.length).toBe(1);
    expect(emitted[0].event).toBe('violation');
    expect(emitted[0].data).toHaveProperty('id');
  });
});

describe('GET /violations', () => {
  let app, db;

  beforeEach(() => {
    db = createDb(':memory:');
    app = createApp(db);

    db.insertViolation({
      document_uri: 'https://example.com', referrer: null,
      violated_directive: 'script-src', effective_directive: 'script-src',
      original_policy: null, blocked_uri: 'https://evil.com/bad.js',
      status_code: null, source_file: null, line_number: null, column_number: null,
      raw: '{"test":1}',
    });
  });

  afterEach(() => {
    db.close();
  });

  test('returns JSON array of violations', async () => {
    const res = await request(app)
      .get('/violations')
      .query({ since: '2000-01-01' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].document_uri).toBe('https://example.com');
  });

  test('defaults since to today (no future violations in seeded data from past)', async () => {
    const res = await request(app).get('/violations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // The seeded row was just inserted, so it should be "today"
    expect(res.body.length).toBe(1);
  });

  test('returns empty array when since is far future', async () => {
    const res = await request(app)
      .get('/violations')
      .query({ since: '2099-01-01' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('accepts ISO datetime for since parameter', async () => {
    const res = await request(app)
      .get('/violations')
      .query({ since: '2000-01-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
  });
});

describe('GET /', () => {
  let app, db;

  beforeEach(() => {
    db = createDb(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    db.close();
  });

  test('serves the Vue frontend HTML', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('CSP Violation');
  });
});

describe('service health', () => {
  test('healthz is available for service startup checks', async () => {
    const db = createDb(':memory:');
    try {
      const response = await request(createApp(db)).get('/healthz');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    } finally { db.close(); }
  });
});
