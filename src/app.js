'use strict';

const path = require('path');
const express = require('express');
const { z } = require('zod');
const { config } = require('../config/environment');
const routes = require('./server/routes');
const { queryService } = require('./services/queryService');

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', routes);

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Request error:', err.message);
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, error: 'Validation failed', issues: err.issues });
  }
  const status = err.status || 400;
  return res.status(status).json({ success: false, error: err.message || 'Internal server error' });
});

let syncTimer = null;

async function coldBootSync() {
  console.log(`Cold-boot sync starting (MOCK_MODE=${config.MOCK_MODE})...`);
  const result = await queryService.syncAll();
  console.log('Cold-boot sync complete:', JSON.stringify(result));
}

async function start() {
  await coldBootSync();

  const server = app.listen(config.PORT, () => {
    console.log(`TeamSG Media Chatbot listening on http://localhost:${config.PORT}`);
  });

  syncTimer = setInterval(() => {
    queryService.syncAll().catch((err) => console.error('Scheduled sync failed:', err.message));
  }, config.SYNC_INTERVAL_MS);
  syncTimer.unref();

  const shutdown = (signal) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    clearInterval(syncTimer);
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));
  process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

module.exports = { app };
