// ============================================================
//  shared.js — Konfigurasi, DB, Utils, State bersama
//  Dipakai oleh: wa.js dan filetools.js
// ============================================================
'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ========== KONFIGURASI ==========
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN tidak ditemukan!'); process.exit(1); }

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
if (ADMIN_IDS.length === 0) { console.error('❌ ADMIN_IDS tidak valid!'); process.exit(1); }

const BOT_NAME             = process.env.BOT_NAME            || '⚡ WA Kicker Bot';
const PAYMENT_BANK_NAME    = process.env.PAYMENT_BANK_NAME   || 'SEA';
const PAYMENT_BANK_NUMBER  = process.env.PAYMENT_BANK_NUMBER || '1234567890';
const PAYMENT_BANK_HOLDER  = process.env.PAYMENT_BANK_HOLDER || 'Bot Owner';
const PAYMENT_DANA         = process.env.PAYMENT_DANA        || '081234567890';
const PAYMENT_CONTACT      = process.env.PAYMENT_CONTACT     || '@adminusername';
const TRIAL_DURATION_HOURS = parseInt(process.env.TRIAL_DURATION_HOURS || '24');
const HEALTH_API_KEY       = process.env.HEALTH_API_KEY      || crypto.randomBytes(16).toString('hex');
const MAX_FILE_SIZE_MB     = parseInt(process.env.MAX_FILE_SIZE_MB     || '10');
const MAX_FILES_PER_BATCH  = parseInt(process.env.MAX_FILES_PER_BATCH  || '20');
const MAX_CONTACTS_PER_FILE= parseInt(process.env.MAX_CONTACTS_PER_FILE|| '50000');
const MAX_ADMIN_FILES      = parseInt(process.env.MAX_ADMIN_FILES      || '100');
const DOWNLOAD_TIMEOUT_MS  = parseInt(process.env.DOWNLOAD_TIMEOUT_MS  || '30000');

const PAYMENT_INFO =
    `Transfer ke:\n` +
    `🏦 ${PAYMENT_BANK_NAME}: ${PAYMENT_BANK_NUMBER} a/n ${PAYMENT_BANK_HOLDER}\n` +
    `💚 Dana/Shopeepay: ${PAYMENT_DANA}`;

const PACKAGES = {
    '1bulan': { label: '1 Bulan',  days: 30,  price: parseInt(process.env.PRICE_1BULAN  || '50000')  },
    '3bulan': { label: '3 Bulan',  days: 90,  price: parseInt(process.env.PRICE_3BULAN  || '125000') },
    '6bulan': { label: '6 Bulan',  days: 180, price: parseInt(process.env.PRICE_6BULAN  || '200000') },
    '1tahun': { label: '1 Tahun',  days: 365, price: parseInt(process.env.PRICE_1TAHUN  || '350000') },
};

// ========== PERSISTENT STORAGE ==========
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const AUTH_BASE_FOLDER = path.join(DATA_DIR, 'auth_states');
if (!fs.existsSync(AUTH_BASE_FOLDER)) fs.mkdirSync(AUTH_BASE_FOLDER, { recursive: true });

const ADMIN_FILES_DIR = process.env.ADMIN_FILES_DIR || path.join(DATA_DIR, 'admin_files');
if (!fs.existsSync(ADMIN_FILES_DIR)) fs.mkdirSync(ADMIN_FILES_DIR, { recursive: true });

const TEMP_DIR   = path.join(DATA_DIR, 'temp');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(TEMP_DIR))   fs.mkdirSync(TEMP_DIR,   { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const USERS_FILE    = path.join(DATA_DIR, 'users.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

// ========== DATABASE JSON ==========
function readJSON(filePath, defaultVal = {}) {
    try {
        if (!fs.existsSync(filePath)) return defaultVal;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return defaultVal; }
}

function writeJSON(filePath, data) {
    const tmp = filePath + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw err;
    }
}

class UserDatabase {
    getUser(userId) {
        return readJSON(USERS_FILE)[String(userId)] || null;
    }
    saveUser(user) {
        const users = readJSON(USERS_FILE);
        users[String(user.id)] = {
            ...user,
            hadTrial:       user.hadTrial       ? 1 : 0,
            notifiedExpiry: user.notifiedExpiry ? 1 : 0,
            updatedAt:      new Date().toISOString(),
        };
        writeJSON(USERS_FILE, users);
    }
    getAllUsers()    { return Object.values(readJSON(USERS_FILE)); }
    deleteUser(userId) {
        const users = readJSON(USERS_FILE);
        delete users[String(userId)];
        writeJSON(USERS_FILE, users);
    }
    getAllPendingPayments() { return Object.values(readJSON(PAYMENTS_FILE)); }
    addPendingPayment(payment) {
        const payments = readJSON(PAYMENTS_FILE);
        payments[String(payment.id)] = payment;
        writeJSON(PAYMENTS_FILE, payments);
    }
    removePendingPayment(userId) {
        const payments = readJSON(PAYMENTS_FILE);
        delete payments[String(userId)];
        writeJSON(PAYMENTS_FILE, payments);
    }
    updateNotifiedFlag(userId) {
        const users = readJSON(USERS_FILE);
        if (users[String(userId)]) {
            users[String(userId)].notifiedExpiry = 1;
            writeJSON(USERS_FILE, users);
        }
    }
}
const db = new UserDatabase();

// ========== LOGGER ==========
const LOG_LEVELS = { INFO: '📘', WARN: '⚠️', ERROR: '❌', DEBUG: '🐛' };
function log(level, module, message, error = null) {
    const ts  = new Date().toISOString();
    const entry = `${ts} ${LOG_LEVELS[level] || '📘'} [${module}] ${message}`;
    console.log(entry);
    if (error && level === 'ERROR') {
        console.error(error.stack);
        try { fs.appendFileSync(path.join(DATA_DIR, 'error.log'), `${entry}\n${error?.stack || ''}\n\n`); } catch (_) {}
    }
}

// ========== GLOBAL STATE ==========
const userSessions      = new Map(); // WA sessions
const userStates        = new Map(); // file-tools states
const kickSelections    = new Map();
const loginLocks        = new Map();
const vcfPending        = new Map();
const conflictCooldowns = new Map();
const reconnectAttempts = new Map();
const rateLimitMap      = new Map();

const CONFLICT_COOLDOWN_MS    = 35000;
const MAX_RECONNECT_ATTEMPTS  = 3;
const MAX_CONCURRENT_SESSIONS = 50;
const SESSION_IDLE_MS         = 4 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS    = 5000;
const RATE_LIMIT_MAX          = 10;
const STATE_TTL_MS            = 30 * 60 * 1000;

// ========== RATE LIMITER ==========
function isRateLimited(userId) {
    const now   = Date.now();
    const entry = rateLimitMap.get(userId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    if (now > entry.resetAt) { entry.count = 1; entry.resetAt = now + RATE_LIMIT_WINDOW_MS; }
    else entry.count++;
    rateLimitMap.set(userId, entry);
    return entry.count > RATE_LIMIT_MAX;
}

// ========== STATE MANAGEMENT (File Tools) ==========
function setState(userId, data) {
    userStates.set(userId, { ...data, expiresAt: Date.now() + STATE_TTL_MS });
}
function getState(userId) {
    const s = userStates.get(userId);
    if (!s) return null;
    if (Date.now() > s.expiresAt) { userStates.delete(userId); return null; }
    return s;
}
function clearState(userId) { userStates.delete(userId); }

// ========== HELPERS ==========
function isAdmin(userId)   { return ADMIN_IDS.includes(userId); }
function touchSession(userId) {
    const s = userSessions.get(userId);
    if (s) s.lastActivity = Date.now();
}

async function getUserStatus(userId) {
    if (isAdmin(userId)) return 'admin';
    const u = db.getUser(userId);
    if (!u) return 'none';
    if (u.role === 'regular') return new Date(u.expiresAt)     > new Date() ? 'regular' : 'expired';
    if (u.role === 'trial')   return new Date(u.trialExpiresAt)> new Date() ? 'trial'   : 'trial_expired';
    return 'none';
}
async function canUseBot(userId) {
    return ['admin', 'regular', 'trial'].includes(await getUserStatus(userId));
}
async function isTrialOnly(userId) { return (await getUserStatus(userId)) === 'trial'; }

function formatDate(isoStr) {
    if (!isoStr) return '-';
    return new Date(isoStr).toLocaleString('id-ID', {
        day:'2-digit', month:'short', year:'numeric',
        hour:'2-digit', minute:'2-digit', timeZone:'Asia/Jakarta',
    });
}
function formatCountdown(isoStr) {
    const ms = new Date(isoStr) - new Date();
    if (ms <= 0) return 'SUDAH EXPIRED';
    const hours = Math.floor(ms / 3600000);
    const mins  = Math.floor((ms % 3600000) / 60000);
    if (hours >= 24) return `${Math.floor(hours/24)} hari ${hours%24} jam`;
    return `${hours} jam ${mins} menit`;
}
function formatRupiah(num) { return 'Rp ' + num.toLocaleString('id-ID'); }
function esc(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
function userDisplayName(u) {
    const name  = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama';
    const uname = u.username ? ` (@${u.username})` : '';
    return `${name}${uname}`;
}
function userDisplayNameEsc(u) {
    const name  = esc([u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama');
    const uname = u.username ? ` (@${esc(u.username)})` : '';
    return `${name}${uname}`;
}
function safeFilename(name) {
    return path.basename(name).replace(/[\/\\:*?"<>|]/g, '_').substring(0, 100);
}
function bytesToMB(bytes) { return bytes ? bytes / (1024 * 1024) : null; }

async function safeReply(ctx, text, opts = {}) {
    const mdOpts = { parse_mode: 'Markdown', ...opts };
    try { return await ctx.reply(text, mdOpts); }
    catch (err) {
        if (err.message?.includes('parse entities') || err.message?.includes('Bad Request')) {
            const { parse_mode, ...safeOpts } = mdOpts;
            try   { return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, '\\$&'), safeOpts); }
            catch { return await ctx.reply(text.replace(/[*_`[\]()~>#+=|{}.!\\-]/g, ''), mdOpts); }
        }
        log('WARN', 'SafeReply', `Gagal kirim: ${err.message}`);
    }
}

async function sendFile(ctx, buffer, filename, caption = '') {
    await ctx.replyWithDocument(
        { source: buffer, filename },
        caption ? { caption } : {}
    );
}

async function downloadTelegramFile(ctx, fileId, fileSizeMB = null) {
    if (fileSizeMB !== null && fileSizeMB > MAX_FILE_SIZE_MB)
        throw new Error(`File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
    const fileLink   = await ctx.telegram.getFileLink(fileId);
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
        const resp = await fetch(fileLink.href, { signal: controller.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.length > MAX_FILE_SIZE_MB * 1024 * 1024)
            throw new Error(`File terlalu besar. Maks ${MAX_FILE_SIZE_MB}MB.`);
        return buffer;
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Download timeout.`);
        throw err;
    } finally { clearTimeout(timer); }
}

// ========== KONTAK UTILS ==========
function normalizePhone(raw) {
    const str     = String(raw).trim();
    const hasPlus = str.startsWith('+');
    let digits    = str.replace(/\D/g, '');
    if (!digits) return null;
    if (hasPlus || digits.startsWith('00')) {
        const withCC = hasPlus ? digits : digits.slice(2);
        if (withCC.length >= 7) return withCC;
    }
    if (digits.startsWith('0'))  return '62' + digits.slice(1);
    if (digits.startsWith('62')) return digits;
    if (digits.length >= 9)      return '62' + digits;
    return digits.length >= 7 ? digits : null;
}
function isPhoneNumber(val) {
    const str = String(val).replace(/[\s\-().]/g, '');
    return /^(\+?62|0)[0-9]{8,13}$/.test(str) || /^[0-9]{10,15}$/.test(str);
}
function generateVCF(contacts) {
    const seen = new Set(); const unique = [];
    for (const { name, phone } of contacts) {
        const norm = normalizePhone(phone);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        unique.push({ name: name || `Kontak ${phone}`, phone: norm });
    }
    return unique.map(({ name, phone }) =>
        `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;TYPE=CELL:+${phone}\nEND:VCARD`
    ).join('\n');
}
function decodeQP(str) {
    return str.replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
function parseVCF(vcfText) {
    const contacts = []; const seen = new Set();
    const blocks   = vcfText.split(/END:VCARD/i).map(b => b.trim()).filter(Boolean);
    for (const block of blocks) {
        if (contacts.length >= MAX_CONTACTS_PER_FILE) break;
        let name = 'Tanpa Nama';
        const fnMatch = block.match(/^FN[;:][^\r\n]*/mi);
        const nMatch  = block.match(/^N[;:][^\r\n]*/mi);
        if (fnMatch) {
            const qp = fnMatch[0].match(/ENCODING=QUOTED-PRINTABLE.*?:(.*)/i);
            if (qp) { try { name = decodeQP(qp[1].trim()); } catch (_) {} }
            else name = fnMatch[0].replace(/^FN.*?:/i, '').trim();
        } else if (nMatch) {
            const raw   = nMatch[0].replace(/^N.*?:/i, '').trim();
            const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
            name = parts.slice(0, 2).reverse().join(' ').trim() || 'Tanpa Nama';
        }
        name = name.replace(/[\x00-\x1F]/g, '').trim() || 'Tanpa Nama';
        const telLines = block.match(/^TEL[^\r\n]*/gim) || [];
        for (const tl of telLines) {
            let num = tl.replace(/^TEL[^:]*:/i, '').replace(/[\s\-().]/g, '').trim();
            num = normalizePhone(num);
            if (!num || seen.has(num)) continue;
            seen.add(num); contacts.push({ name, phone: num });
        }
    }
    return contacts;
}
function autoDetectAndParse(line) {
    line = line.trim(); if (!line) return null;
    const m1 = line.match(/^(\+?[0-9]{10,15})\s+(.+)$/);
    if (m1) return { phone: m1[1], name: m1[2].trim() };
    const m2 = line.match(/^(.+?)[,|]\s*(\+?[0-9]{8,15})$/);
    if (m2) return { phone: m2[2], name: m2[1].trim() };
    const m3 = line.match(/^(\+?[0-9]{8,15})[,|]\s*(.+)$/);
    if (m3) return { phone: m3[1], name: m3[2].trim() };
    const m4 = line.match(/^(\+?[0-9]{10,15})$/);
    if (m4) return { phone: m4[1], name: `Kontak ${m4[1]}` };
    const m5 = line.match(/^(.+?)\t(\+?[0-9]{8,15})$/);
    if (m5) {
        const a = m5[1].trim(), b = m5[2].trim();
        return /^\+?[0-9]{10,15}$/.test(a.replace(/[\s\-().]/g, ''))
            ? { phone: a, name: b } : { phone: b, name: a };
    }
    return null;
}
function parseTxtLines(text) {
    const lines = text.split(/\r?\n/); const contacts = []; const seen = new Set();
    for (const line of lines) {
        if (contacts.length >= MAX_CONTACTS_PER_FILE) break;
        const parsed = autoDetectAndParse(line);
        if (!parsed) continue;
        const norm = normalizePhone(parsed.phone);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        contacts.push({ name: parsed.name || `Kontak ${norm}`, phone: norm });
    }
    return contacts;
}

// ========== DIVIDERS ==========
const DIVIDER      = '━━━━━━━━━━━━━━━━━━━━━━';
const DIVIDER_THIN = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

// ========== KEYBOARDS ==========
const KB_LANDING = {
    reply_markup: {
        keyboard: [
            [{ text: '🎁 Coba Gratis (Trial)' }, { text: '⭐ Premium' }],
            [{ text: '🔧 File Tools' }, { text: '❓ Bantuan' }],
        ],
        resize_keyboard: true, one_time_keyboard: false,
    },
};
const KB_PRE_LOGIN = {
    reply_markup: {
        keyboard: [
            [{ text: '🔑 Login WhatsApp' }],
            [{ text: '📊 Status' }, { text: '👤 Akun Saya' }],
            [{ text: '🔧 File Tools' }],
            [{ text: '⭐ Premium' }, { text: '❓ Bantuan' }],
        ],
        resize_keyboard: true, one_time_keyboard: false,
    },
};
const KB_MAIN = {
    reply_markup: {
        keyboard: [
            [{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }],
            [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }],
            [{ text: '🔴 Kick Menu' }, { text: '📊 Status' }],
            [{ text: '🔧 File Tools' }, { text: '🚪 Logout WhatsApp' }],
        ],
        resize_keyboard: true, one_time_keyboard: false,
    },
};
const KB_ADMIN_PRE = {
    reply_markup: {
        keyboard: [
            [{ text: '🔑 Login WhatsApp' }],
            [{ text: '📋 Pending Payment' }, { text: '👥 User List' }],
            [{ text: '🔧 File Tools' }, { text: '📁 Admin File Manager' }],
            [{ text: '📊 Status' }, { text: '❓ Bantuan' }],
        ],
        resize_keyboard: true, one_time_keyboard: false,
    },
};
const KB_ADMIN_MAIN = {
    reply_markup: {
        keyboard: [
            [{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }],
            [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }],
            [{ text: '🔴 Kick Menu' }, { text: '📊 Status' }],
            [{ text: '🔧 File Tools' }, { text: '📁 Admin File Manager' }],
            [{ text: '📋 Pending Payment' }, { text: '👥 User List' }],
            [{ text: '🚪 Logout WhatsApp' }],
        ],
        resize_keyboard: true, one_time_keyboard: false,
    },
};
const KB_FILE_TOOLS = {
    reply_markup: {
        keyboard: [
            [{ text: '🔄 TXT → VCF' }, { text: '🔄 VCF → TXT' }],
            [{ text: '📊 XLSX → VCF' }, { text: '📝 TXT2VCF Auto' }],
            [{ text: '🔗 Gabung TXT' }, { text: '🔗 Gabung VCF' }],
            [{ text: '✂️ Pecah VCF' }, { text: '✂️ Pecah VCF (jlh)' }],
            [{ text: '➕ Tambah Kontak' }, { text: '➖ Hapus Kontak' }],
            [{ text: '🔢 Hitung Kontak' }, { text: '✏️ Rename Kontak' }],
            [{ text: '📋 List Grup WA' }, { text: '📸 Rekap Grup' }],
            [{ text: '📄 Pesan ke TXT' }, { text: '📝 Rename File' }],
            [{ text: '↩️ Kembali' }],
        ],
        resize_keyboard: true, one_time_keyboard: false,
    },
};

async function getKeyboard(userId) {
    const loggedIn = userSessions.get(userId)?.loggedIn;
    if (isAdmin(userId)) return loggedIn ? KB_ADMIN_MAIN : KB_ADMIN_PRE;
    const status = await getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return loggedIn ? KB_MAIN : KB_PRE_LOGIN;
    return KB_LANDING;
}

async function requireAccess(ctx, next) {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isAdmin(userId)) return next();
    const status = await getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return next();
    if (status === 'expired')
        return safeReply(ctx, `╔${DIVIDER}╗\n║  AKSES BERAKHIR\n╚${DIVIDER}╝\n\nPaket lo sudah expired.\nKetik /beli untuk lihat paket.`, { ...KB_LANDING });
    if (status === 'trial_expired')
        return safeReply(ctx, `╔${DIVIDER}╗\n║  TRIAL BERAKHIR\n╚${DIVIDER}╝\n\nMasa trial habis.\nKetik /beli untuk upgrade.`, { ...KB_LANDING });
    await safeReply(ctx, `╔${DIVIDER}╗\n║  AKSES DITOLAK\n╚${DIVIDER}╝\n\nBot ini berbayar.\n\n🎁 Coba gratis ${TRIAL_DURATION_HOURS} jam → tekan Coba Gratis\n💳 Beli paket → tekan ⭐ Premium`, { ...KB_LANDING });
}

// ========== AUTO BACKUP ==========
function backupData() {
    try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        if (fs.existsSync(USERS_FILE))    fs.copyFileSync(USERS_FILE,    path.join(BACKUP_DIR, `users_${ts}.json`));
        if (fs.existsSync(PAYMENTS_FILE)) fs.copyFileSync(PAYMENTS_FILE, path.join(BACKUP_DIR, `payments_${ts}.json`));
        const files = fs.readdirSync(BACKUP_DIR).sort();
        const uB = files.filter(f => f.startsWith('users_'));
        const pB = files.filter(f => f.startsWith('payments_'));
        uB.slice(0, Math.max(0, uB.length - 24)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
        pB.slice(0, Math.max(0, pB.length - 24)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
        log('INFO', 'Backup', `Selesai: ${ts}`);
    } catch (err) { log('ERROR', 'Backup', err.message, err); }
}
setInterval(backupData, 60 * 60 * 1000);
setTimeout(backupData, 5000);

// ========== MEMORY MONITOR ==========
setInterval(() => {
    const m = process.memoryUsage();
    const heapMB = Math.round(m.heapUsed / 1024 / 1024);
    log('INFO', 'Memory', `Heap: ${heapMB}MB | RSS: ${Math.round(m.rss/1024/1024)}MB | Sessions: ${userSessions.size}`);
    if (heapMB > 400) log('WARN', 'Memory', `Heap tinggi (${heapMB}MB)`);
}, 30 * 60 * 1000);

module.exports = {
    // config
    TELEGRAM_BOT_TOKEN, ADMIN_IDS, BOT_NAME,
    PAYMENT_BANK_NAME, PAYMENT_BANK_NUMBER, PAYMENT_BANK_HOLDER,
    PAYMENT_DANA, PAYMENT_CONTACT, TRIAL_DURATION_HOURS,
    HEALTH_API_KEY, MAX_FILE_SIZE_MB, MAX_FILES_PER_BATCH,
    MAX_CONTACTS_PER_FILE, MAX_ADMIN_FILES, DOWNLOAD_TIMEOUT_MS,
    PAYMENT_INFO, PACKAGES,
    // paths
    DATA_DIR, AUTH_BASE_FOLDER, ADMIN_FILES_DIR, TEMP_DIR, BACKUP_DIR,
    USERS_FILE, PAYMENTS_FILE,
    // db
    db,
    // state
    userSessions, userStates, kickSelections, loginLocks,
    vcfPending, conflictCooldowns, reconnectAttempts, rateLimitMap,
    CONFLICT_COOLDOWN_MS, MAX_RECONNECT_ATTEMPTS, MAX_CONCURRENT_SESSIONS,
    SESSION_IDLE_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, STATE_TTL_MS,
    // functions
    isRateLimited, setState, getState, clearState,
    isAdmin, touchSession, getUserStatus, canUseBot, isTrialOnly,
    formatDate, formatCountdown, formatRupiah,
    esc, userDisplayName, userDisplayNameEsc, safeFilename, bytesToMB,
    safeReply, sendFile, downloadTelegramFile,
    normalizePhone, isPhoneNumber, generateVCF, decodeQP, parseVCF,
    autoDetectAndParse, parseTxtLines,
    DIVIDER, DIVIDER_THIN,
    KB_LANDING, KB_PRE_LOGIN, KB_MAIN, KB_ADMIN_PRE, KB_ADMIN_MAIN, KB_FILE_TOOLS,
    getKeyboard, requireAccess,
    log,
};
