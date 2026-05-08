// ============================================================
//  index.js — Entry point utama bot
// ============================================================
'use strict';

const { Telegraf } = require('telegraf');
const S = require('./shared');

const waTools   = require('./watools');
const fileTools = require('./filetools');

const bot = new Telegraf(S.TELEGRAM_BOT_TOKEN);

// Register semua handler
waTools.register(bot);
fileTools.register(bot);

// Health check endpoint (opsional, untuk Railway)
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    if (req.headers['x-api-key'] === S.HEALTH_API_KEY) {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', sessions: S.userSessions.size, uptime: process.uptime() }));
    } else {
        res.writeHead(200);
        res.end('OK');
    }
}).listen(PORT, () => S.log('INFO', 'Server', `Health check listening on port ${PORT}`));

// Graceful shutdown
const shutdown = async (signal) => {
    S.log('INFO', 'Bot', `${signal} diterima, shutdown...`);
    bot.stop(signal);
    process.exit(0);
};
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Launch bot
bot.launch()
    .then(() => S.log('INFO', 'Bot', `✅ ${S.BOT_NAME} berjalan!`))
    .catch(err => { S.log('ERROR', 'Bot', 'Gagal start', err); process.exit(1); });
