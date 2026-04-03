#!/usr/bin/env node
/**
 * SynthForce Contact Intake API
 * - validates submissions
 * - stores them on disk
 * - optionally forwards to Telegram
 * - exposes /healthz for deployment checks
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3001);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBMISSIONS_FILE = process.env.SUBMISSIONS_FILE || path.join(DATA_DIR, 'submissions.json');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://synthforce.io';
const TRUST_PROXY = process.env.TRUST_PROXY !== 'false';
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 8;

const rateLimit = new Map();

ensureStorage();

function ensureStorage() {
  fs.mkdirSync(path.dirname(SUBMISSIONS_FILE), { recursive: true });
  if (!fs.existsSync(SUBMISSIONS_FILE)) {
    fs.writeFileSync(SUBMISSIONS_FILE, '[]\n');
  }
}

function getRequestIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return origin === ALLOWED_ORIGIN;
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || ALLOWED_ORIGIN);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readJsonFile() {
  try {
    return JSON.parse(fs.readFileSync(SUBMISSIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeJsonFile(data) {
  fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function sanitizeText(value, maxLength = 4000) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeMultiline(value, maxLength = 4000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r/g, '')
    .trim()
    .slice(0, maxLength);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeTelegram(text) {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return Promise.resolve({ skipped: true });
  }

  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, body });
          } else {
            reject(new Error(`Telegram error ${res.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function validateSubmission(raw, ip) {
  const name = sanitizeText(raw.name, 120);
  const email = sanitizeText(raw.email, 200).toLowerCase();
  const task = sanitizeText(raw.task, 200);
  const timeline = sanitizeText(raw.timeline, 120);
  const budget = sanitizeText(raw.budget, 120);
  const details = sanitizeMultiline(raw.details, 4000);
  const source = sanitizeText(raw.source || 'website', 80);
  const website = sanitizeText(raw.website || raw.companyWebsite || '', 200);

  if (website) {
    return { ok: false, status: 400, message: 'Invalid request' };
  }
  if (!name || name.length < 2) {
    return { ok: false, status: 400, message: 'Please enter your name.' };
  }
  if (!isValidEmail(email)) {
    return { ok: false, status: 400, message: 'Please enter a valid email address.' };
  }
  if (!task) {
    return { ok: false, status: 400, message: 'Please describe the type of work you need.' };
  }
  if (!details || details.length < 10) {
    return { ok: false, status: 400, message: 'Please include a few more project details.' };
  }

  const now = Date.now();
  const existing = (rateLimit.get(ip) || []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (existing.length >= RATE_LIMIT_MAX) {
    rateLimit.set(ip, existing);
    return { ok: false, status: 429, message: 'Too many submissions. Please try again shortly.' };
  }
  existing.push(now);
  rateLimit.set(ip, existing);

  return {
    ok: true,
    submission: {
      name,
      email,
      task,
      details,
      timeline,
      budget,
      source,
      timestamp: new Date().toISOString(),
      ip,
      userAgent: sanitizeText(raw.userAgent || '', 300) || sanitizeText(raw.ua || '', 300) || '',
    },
  };
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    json(res, 200, {
      ok: true,
      service: 'synthforce-contact-api',
      submissionsFile: SUBMISSIONS_FILE,
      telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/contact') {
    if (!isAllowedOrigin(req.headers.origin)) {
      json(res, 403, { ok: false, message: 'Origin not allowed' });
      return;
    }

    try {
      const rawBody = await parseBody(req);
      const payload = JSON.parse(rawBody || '{}');
      const ip = getRequestIp(req);
      const result = validateSubmission(payload, ip);

      if (!result.ok) {
        json(res, result.status, { ok: false, message: result.message });
        return;
      }

      const submissions = readJsonFile();
      submissions.push(result.submission);
      writeJsonFile(submissions);

      const telegramText = [
        '🔔 *New SynthForce lead*',
        '',
        `👤 *Name:* ${escapeTelegram(result.submission.name)}`,
        `📧 *Email:* ${escapeTelegram(result.submission.email)}`,
        `📋 *Task:* ${escapeTelegram(result.submission.task)}`,
        `⏱ *Timeline:* ${escapeTelegram(result.submission.timeline || 'Not specified')}`,
        `💰 *Budget:* ${escapeTelegram(result.submission.budget || 'Not specified')}`,
        `🧭 *Source:* ${escapeTelegram(result.submission.source)}`,
        `🌐 *IP:* ${escapeTelegram(result.submission.ip)}`,
        '',
        `💬 *Details:* ${escapeTelegram(result.submission.details)}`,
        '',
        `_Received ${escapeTelegram(result.submission.timestamp)}_`,
      ].join('\n');

      sendTelegram(telegramText).catch((error) => {
        console.error('Telegram notify failed:', error.message);
      });

      json(res, 200, {
        ok: true,
        message: "Request received. We'll follow up by email as soon as possible.",
      });
    } catch (error) {
      const status = error.message === 'Payload too large' ? 413 : 400;
      json(res, status, {
        ok: false,
        message: status === 413 ? 'Submission too large.' : 'Invalid request.',
      });
    }
    return;
  }

  json(res, 404, { ok: false, message: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`SynthForce contact API listening on port ${PORT}`);
});
