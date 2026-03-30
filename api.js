#!/usr/bin/env node
/**
 * SynthForce Contact Form API
 * Receives form submissions, stores them, and forwards to Telegram
 */

const http = require('http');
const fs = require('fs');
const https = require('https');

const PORT = 3001;
const SUBMISSIONS_FILE = '/home/ubuntu/website/submissions.json';
const TELEGRAM_BOT_TOKEN = '8693806948:AAFi-jCDhavDmRD-QjDiuPq2vX9UlgxIQ7w';
const TELEGRAM_CHAT_ID = '5534884780';

// Ensure submissions file exists
if (!fs.existsSync(SUBMISSIONS_FILE)) {
  fs.writeFileSync(SUBMISSIONS_FILE, '[]');
}

function sendTelegram(text) {
  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: text,
    parse_mode: 'Markdown'
  });
  
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  };
  
  const req = https.request(options);
  req.write(payload);
  req.end();
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.method === 'POST' && req.url === '/api/contact') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const submission = {
          ...data,
          timestamp: new Date().toISOString(),
          ip: req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress
        };
        
        // Store
        const submissions = JSON.parse(fs.readFileSync(SUBMISSIONS_FILE));
        submissions.push(submission);
        fs.writeFileSync(SUBMISSIONS_FILE, JSON.stringify(submissions, null, 2));
        
        // Notify via Telegram
        sendTelegram(
          `🔔 *New SynthForce Lead!*\n\n` +
          `👤 *Name:* ${data.name || 'N/A'}\n` +
          `📧 *Email:* ${data.email || 'N/A'}\n` +
          `📋 *Subject:* ${data.subject || 'N/A'}\n` +
          `💬 *Details:* ${data.details || 'N/A'}\n\n` +
          `_Received: ${submission.timestamp}_`
        );
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Request received! We\'ll get back to you shortly.' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'Invalid request' }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`SynthForce API running on port ${PORT}`);
});
