'use strict';

const { createServer } = require('http');
const { Server } = require('socket.io');
const Client = require('socket.io-client');
const request = require('supertest');
const { createApp } = require('../src/app');
const { createDb } = require('../src/db');

function buildTestServer() {
  const db = createDb(':memory:');
  const app = createApp(db);
  const httpServer = createServer(app);
  const io = new Server(httpServer);

  app.locals.io = io;

  io.on('connection', (socket) => {
    const today = new Date().toISOString().split('T')[0];
    const violations = db.getViolationsSince(`${today}T00:00:00.000Z`);
    socket.emit('initial', violations);
  });

  return { db, app, httpServer, io };
}

async function startServer(httpServer) {
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port));
  });
}

async function stopServer({ io, db, httpServer }) {
  io.close();
  db.close();
  await new Promise((resolve) => httpServer.close(resolve));
}

// Register 'initial' listener BEFORE connecting to avoid missing the event.
function connectClient(port) {
  return new Promise((resolve, reject) => {
    const socket = new Client(`http://127.0.0.1:${port}`, {
      forceNew: true,
      reconnection: false,
    });
    // Resolve with socket + the first 'initial' payload in one shot
    const timer = setTimeout(() => reject(new Error('connect timeout')), 5000);
    socket.once('initial', (data) => {
      clearTimeout(timer);
      resolve({ socket, data });
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

describe('Socket.io', () => {
  test('client receives empty initial violations when db is empty', async () => {
    const srv = buildTestServer();
    const port = await startServer(srv.httpServer);

    const { socket, data } = await connectClient(port);

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);

    socket.disconnect();
    await stopServer(srv);
  });

  test('client receives seeded violations in initial event', async () => {
    const srv = buildTestServer();
    const port = await startServer(srv.httpServer);

    srv.db.insertViolation({
      document_uri: 'https://seeded.com', referrer: null,
      violated_directive: 'script-src', effective_directive: null,
      original_policy: null, blocked_uri: 'https://evil.com/bad.js',
      status_code: null, source_file: null, line_number: null, column_number: null,
      raw: '{}',
    });

    const { socket, data } = await connectClient(port);

    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.some(v => v.document_uri === 'https://seeded.com')).toBe(true);

    socket.disconnect();
    await stopServer(srv);
  });

  test('connected client receives violation event when POST is made', async () => {
    const srv = buildTestServer();
    const port = await startServer(srv.httpServer);

    const { socket } = await connectClient(port);

    const violationPromise = once(socket, 'violation');

    await request(srv.app)
      .post('/violations')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify({
        'csp-report': {
          'document-uri': 'https://realtime.com',
          'violated-directive': 'font-src',
          'blocked-uri': 'https://fonts.evil.com/bad.woff2',
        },
      }));

    const v = await violationPromise;
    expect(v).toHaveProperty('id');
    expect(v.violated_directive).toBe('font-src');
    expect(v.document_uri).toBe('https://realtime.com');

    socket.disconnect();
    await stopServer(srv);
  });

  test('multiple clients all receive the violation event', async () => {
    const srv = buildTestServer();
    const port = await startServer(srv.httpServer);

    const [r1, r2] = await Promise.all([connectClient(port), connectClient(port)]);

    const v1Promise = once(r1.socket, 'violation');
    const v2Promise = once(r2.socket, 'violation');

    await request(srv.app)
      .post('/violations')
      .set('Content-Type', 'application/csp-report')
      .send(JSON.stringify({
        'csp-report': {
          'document-uri': 'https://multi.com',
          'violated-directive': 'media-src',
        },
      }));

    const [v1, v2] = await Promise.all([v1Promise, v2Promise]);
    expect(v1.violated_directive).toBe('media-src');
    expect(v2.violated_directive).toBe('media-src');

    r1.socket.disconnect();
    r2.socket.disconnect();
    await stopServer(srv);
  });
});
