'use strict';

const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { queryService } = require('../services/queryService');
const { chat, getActiveProviderInfo } = require('../services/aiEngine');
const { config } = require('../../config/environment');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx or .xls files are accepted'), ok);
  },
});

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mockMode: config.MOCK_MODE,
    stats: queryService.getStats(),
    ai: getActiveProviderInfo(),
  });
});

router.post('/sync', async (req, res, next) => {
  try {
    const result = await queryService.syncAll();
    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
});

router.post('/upload-excel', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded. Attach a file under the "file" field.' });
      }
      const result = await queryService.ingestExcelBuffer(req.file.buffer, req.file.originalname);
      return res.json({ success: true, result });
    } catch (e) {
      return next(e);
    }
  });
});

const filterQuerySchema = z.object({
  sport: z.string().optional(),
  medal: z.string().optional(),
  country: z.string().optional(),
  status: z.string().optional(),
  athleteName: z.string().optional(),
  recordType: z.string().optional(),
});

router.get('/medals', (req, res, next) => {
  try {
    const q = filterQuerySchema.parse(req.query);
    res.json({ success: true, data: queryService.getMedalSummary(q) });
  } catch (e) {
    next(e);
  }
});

router.get('/records', (req, res, next) => {
  try {
    const q = filterQuerySchema.parse(req.query);
    res.json({ success: true, data: queryService.getRecords(q) });
  } catch (e) {
    next(e);
  }
});

router.get('/schedule', (req, res, next) => {
  try {
    const q = filterQuerySchema.parse(req.query);
    res.json({ success: true, data: queryService.getSchedule(q) });
  } catch (e) {
    next(e);
  }
});

router.get('/contingent', (req, res, next) => {
  try {
    const q = filterQuerySchema.parse(req.query);
    res.json({ success: true, data: queryService.getContingent(q) });
  } catch (e) {
    next(e);
  }
});

router.get('/highlights/:sport?', (req, res, next) => {
  try {
    res.json({ success: true, data: queryService.getHighlights({ sport: req.params.sport }) });
  } catch (e) {
    next(e);
  }
});

const chatBodySchema = z.object({
  message: z.string().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .max(20)
    .optional(),
});

router.post('/chat', async (req, res, next) => {
  try {
    const body = chatBodySchema.parse(req.body);
    const result = await chat(body);
    res.json({ success: true, data: result });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
