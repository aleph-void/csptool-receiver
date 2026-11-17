'use strict';

const { createServer } = require('http');
const { Server } = require('socket.io');
const { createApp } = require('./src/app');
const { createDb } = require('./src/db');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || './violations.db';

const db = createDb(DB_PATH);
const app = createApp(db);
const httpServer = createServer(app);
const io = new Server(httpServer);

app.locals.io = io;

io.on('connection', (socket) => {
  const today = new Date().toISOString().split('T')[0];
  const violations = db.getViolationsSince(`${today}T00:00:00.000Z`);
  socket.emit('initial', violations);
});

httpServer.listen(PORT, HOST, () => {
  console.log(`CSP Receiver running on port ${PORT}`);
});

module.exports = { app, io, db, httpServer };
