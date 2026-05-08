// ============================================================
//  wa.js — Fitur WhatsApp (engine dari bot_badak 95%)
//  Login, Kick, Import VCF, Buat Grup, Payment, User Mgmt
// ============================================================
'use strict';

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino   = require('pino');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Markup } = require('telegraf');

const S = require('./shared');

// ========== HUMAN DELAY ENGINE (badak) ==========
async function humanDelay(minMs = 1200, maxMs = 3800) {
    return new Promise(r => setTimeout(r, Math.floor(Math.random() * (maxMs - minMs + 1) + minMs)));
}
function gaussianRandom(mean, std) {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
function getSessionMood() {
    const r = Math.random();
    if (r < 0.50) return 'normal';
    if (r < 0.75) return 'cepat';
    if (r < 0.90) return 'pelan';
    return 'distracted';
}
async function humanDelayKick(mood) {
    const cfg = { cepat: [18,4], pelan: [45,10], distracted: [70,25], normal: [30,8] };
    let [base, std] = cfg[mood] || cfg.normal;
    if (Math.random() < 0.15) base += 20 + Math.random() * 30;
    const d = clamp(gaussianRandom(base, std), 10, 120);
    S.log('INFO', 'HumanDelay', `Jeda kick [${mood}]: ${Math.round(d)}s`);
    return new Promise(r => setTimeout(r, Math.floor(d * 1000)));
}
async function humanDelayAdd(mood) {
    const cfg = { cepat: [35,8], pelan: [75,15], distracted: [110,30], normal: [55,12] };
    let [base, std] = cfg[mood] || cfg.normal;
    if (Math.random() < 0.20) base += 30 + Math.random() * 60;
    const d = clamp(gaussianRandom(base, std), 25, 240);
    S.log('INFO', 'HumanDelay', `Jeda add [${mood}]: ${Math.round(d)}s`);
    return new Promise(r => setTimeout(r, Math.floor(d * 1000)));
}
async function humanDelayLongBreak(label = 'break') {
    const d = Math.random() < 0.6
        ? clamp(gaussianRandom(180, 40), 90, 260)
        : clamp(gaussianRandom(450, 90), 280, 720);
    S.log('INFO', 'HumanDelay', `Long break [${label}]: ${Math.round(d/60)}m`);
    return new Promise(r => setTimeout(r, Math.floor(d * 1000)));
}
async function humanDelayError() {
    const d = clamp(gaussianRandom(300, 80), 180, 600);
    return new Promise(r => setTimeout(r, Math.floor(d * 1000)));
}
async function humanDelayNatural(minSec = 3, maxSec = 25) {
    return new Promise(r => setTimeout(r, Math.floor((minSec + Math.random() * (maxSec - minSec)) * 1000)));
}
async function simulateReadAndType(sock, jid, shouldType = false) {
    try {
        await sock.sendPresenceUpdate('available');
        await humanDelayNatural(1, 3);
        if (shouldType && Math.random() > 0.3) {
            await sock.sendPresenceUpdate('composing', jid);
            await humanDelayNatural(2, 6);
            await sock.sendPresenceUpdate('paused', jid);
        }
        await humanDelayNatural(1, 4);
    } catch (err) { S.log('WARN', 'Simulate', err.message); }
}
function isActiveHours() {
    const h = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta', hour: 'numeric', hour12: false }));
    return h >= 8 && h <= 22;
}

// ========== FINGERPRINT & AUTH ==========
function generateDynamicFingerprint() {
    const chrome  = ['120','121','122','123','124'];
    const edge    = ['120','121','122'];
    const safari  = ['16','17','17.4'];
    const osList  = ['Windows','MacOS','Linux'];
    const os      = osList[Math.floor(Math.random() * osList.length)];
    let browser, version;
    if (os === 'MacOS')        { browser = 'Safari'; version = safari[Math.floor(Math.random() * safari.length)]; }
    else if (Math.random() > 0.3) { browser = 'Chrome'; version = chrome[Math.floor(Math.random() * chrome.length)]; }
    else                       { browser = 'Edge';   version = edge[Math.floor(Math.random() * edge.length)]; }
    const build = Math.floor(Math.random() * 9999);
    let ua = '';
    if (browser === 'Chrome')
        ua = `Mozilla/5.0 (${os === 'Windows' ? 'Windows NT 10.0; Win64; x64' : 'Macintosh; Intel Mac OS X 10_15_7'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.${build}.${Math.floor(Math.random()*99)} Safari/537.36`;
    else if (browser === 'Edge')
        ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36 Edg/${version}.0.${build}`;
    else
        ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
    return [os, browser, `${version}.0.${build}`, ua];
}
function getEncryptedAuthFolder(userId) {
    const week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const hash = crypto.createHash('sha256').update(`wa_${userId}_v3_${week}`).digest('hex').substring(0, 32);
    return path.join(S.AUTH_BASE_FOLDER, hash);
}

// ========== BACKGROUND SPOOFER ==========
async function startBackgroundActivitySpooler(sock, userId) {
    let active = true;
    const acts = [
        () => sock.sendPresenceUpdate('available'),
        () => sock.sendPresenceUpdate('unavailable'),
        () => sock.sendPresenceUpdate('recording'),
        () => sock.sendPresenceUpdate('paused'),
    ];
    const run = async () => {
        if (!active) return;
        const session = S.userSessions.get(userId);
        if (!session?.loggedIn) return;
        setTimeout(async () => {
            try {
                await acts[Math.floor(Math.random() * acts.length)]();
                if (Math.random() > 0.7 && session.groupId) {
                    await humanDelayNatural(0.5, 2);
                    await sock.sendPresenceUpdate('composing', session.groupId);
                    await humanDelayNatural(1, 4);
                    await sock.sendPresenceUpdate('paused', session.groupId);
                }
            } catch (err) {
                S.log('WARN', 'Spoofer', err.message);
                await new Promise(r => setTimeout(r, 60000));
            }
            run();
        }, (5 + Math.random() * 20) * 60 * 1000);
    };
    run();
    return () => { active = false; };
}

// ========== ANIMATIONS ==========
const SPINNER = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const CLOCK   = ['🕐','🕑','🕒','🕓','🕔','🕕','🕖','🕗','🕘','🕙','🕚','🕛'];
const PULSE   = ['🔴','🟠','🟡','🟢','🟡','🟠'];

async function liveMessage(ctx, initText, frameFn, interval = 900) {
    let msg;
    try   { msg = await ctx.reply(initText, { parse_mode: 'Markdown' }); }
    catch { try { msg = await S.safeReply(ctx, initText); } catch { return { stop: async () => {} }; } }
    let frame = 0, stopped = false;
    const timer = setInterval(async () => {
        if (stopped) return;
        try { await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, frameFn(frame), { parse_mode: 'Markdown' }); }
        catch (_) {}
        frame++;
    }, interval);
    return {
        stop: async (finalText) => {
            stopped = true; clearInterval(timer);
            if (finalText) {
                try { await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, finalText, { parse_mode: 'Markdown' }); }
                catch (_) {}
            }
        },
    };
}
async function spinnerMessage(ctx, label) {
    return liveMessage(ctx, `${SPINNER[0]} *${label}*`, i => `${SPINNER[i % SPINNER.length]} *${label}*`, 750);
}
function buildProgressBar(done, total, width = 14) {
    const pct    = total === 0 ? 1 : Math.min(done / total, 1);
    const filled = Math.round(pct * width);
    return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + '] ' + String(Math.round(pct * 100)).padStart(3) + '%';
}
async function liveKickProgress(ctx, total) {
    let current = 0;
    const anim  = await liveMessage(ctx,
        `🦵 *Memulai kick...*\n${buildProgressBar(0, total)}\n0/${total} orang`,
        i => {
            const spin = SPINNER[i % SPINNER.length], pulse = PULSE[i % PULSE.length];
            return `${pulse} *Sedang mengkick anggota...*\n\n${buildProgressBar(current, total)}\n${spin} \`${current}/${total}\` orang dikick\n\n_Sabar, jeda antar kick untuk stealth mode..._`;
        }, 800);
    return { update: n => { current = n; }, stop: t => anim.stop(t) };
}
async function liveCountdown(ctx, totalMs, headerText, onDone) {
    const endTime = Date.now() + totalMs;
    const anim    = await liveMessage(ctx, `⏳ ${headerText}\n\nMenghitung...`,
        i => {
            const left  = Math.max(0, endTime - Date.now());
            const sisa  = Math.ceil(left / 1000);
            const clock = CLOCK[i % CLOCK.length];
            const pulse = PULSE[i % PULSE.length];
            return `${pulse} ${headerText}\n\n${clock} Sisa: \`${String(Math.floor(sisa/60)).padStart(2,'0')}:${String(sisa%60).padStart(2,'0')}\`\n${buildProgressBar(totalMs - left, totalMs)}\n\n_WA server ngelepas koneksi lama..._`;
        }, 1000);
    setTimeout(async () => {
        await anim.stop('✅ Cooldown selesai!\n\nSilakan tekan 🔑 Login WhatsApp lagi.');
        if (onDone) onDone();
    }, totalMs);
    return anim;
}
async function liveConnecting(ctx) {
    const labels = ['Menyiapkan koneksi WA','Memuat auth session','Menghubungi server WA','Menunggu QR code'];
    let phase = 0;
    return liveMessage(ctx, `${CLOCK[0]} Menyambungkan ke WhatsApp...`,
        i => {
            if (i > 0 && i % 4 === 0 && phase < labels.length - 1) phase++;
            return `${CLOCK[i % CLOCK.length]} Menghubungkan ke WhatsApp\n\n${SPINNER[i % SPINNER.length]} ${labels[phase]}...\n\n_QR code akan muncul sebentar lagi_`;
        }, 700);
}

// ========== QR SENDER ==========
async function sendQR(ctx, qr) {
    if (!qr) { await S.safeReply(ctx, '❌ QR kosong.'); return; }
    await humanDelay(1800, 3600);
    try {
        if (Math.random() >= 0.25) {
            const buf = await QRCode.toBuffer(qr, { type:'png', width:1024, margin:2, color:{ dark:'#000000', light:'#FFFFFF' }, scale:8 });
            await ctx.replyWithPhoto({ source: buf }, { caption: '📱 SCAN QR CODE DI WHATSAPP\n\n1. Buka WA → Perangkat Tertaut\n2. Tap Tautkan Perangkat\n3. Scan QR di atas\n\n_Gagal scan? Screenshot lalu scan dari galeri_' });
        } else {
            await S.safeReply(ctx, `📱 SCAN QR CODE MANUAL\n\n\`\`\`\n${qr}\n\`\`\``);
        }
    } catch { await S.safeReply(ctx, `📱 SCAN QR CODE (backup)\n\n\`\`\`\n${qr}\n\`\`\``); }
}

// ========== KICK ONE BY ONE ==========
async function naturalKickOneByOne(sock, groupId, jids, onProgress) {
    let kicked = 0;
    const shuffled = [...jids];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let mood = getSessionMood(), actionsSince = 0, trigger = 5 + Math.floor(Math.random() * 6);
    for (let i = 0; i < shuffled.length; i++) {
        const jid = shuffled[i];
        if (++actionsSince >= trigger) {
            mood = getSessionMood(); actionsSince = 0; trigger = 5 + Math.floor(Math.random() * 6);
            S.log('INFO', 'Kick', `Mood → ${mood}`);
        }
        try {
            await simulateReadAndType(sock, groupId, false);
            await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
            kicked++;
            if (onProgress) onProgress(kicked);
            S.log('INFO', 'Kick', `✅ ${jid} (${kicked}/${shuffled.length}) [${mood}]`);
            if (i + 1 < shuffled.length) {
                if (Math.random() < 0.08) { await humanDelayLongBreak('kick-break'); mood = getSessionMood(); actionsSince = 0; }
                else await humanDelayKick(mood);
            }
        } catch (err) {
            S.log('ERROR', 'Kick', `Gagal: ${err.message}`);
            if (err.message?.includes('Connection Closed') || err.message?.includes('Connection Lost'))
                return { kicked, stopped: true, reason: 'connection' };
            await humanDelayError();
        }
    }
    return { kicked, stopped: false };
}

// ========== ADD CONTACTS TO GROUP ==========
async function addContactsToGroup(ctx, userId, contacts, groupId, groupName) {
    S.touchSession(userId);
    const session = S.userSessions.get(userId);
    if (!session?.loggedIn) return S.safeReply(ctx, '❌ Session WA berakhir. Tekan 🔑 Login WhatsApp.');
    const total = contacts.length;
    let berhasil = 0, gagal = 0, notWA = 0;
    const statusMsg = await S.safeReply(ctx, `⏳ Menambahkan ${total} kontak ke grup...\n\n⚠️ Proses berjalan lambat untuk keamanan WA.`);
    let mood = getSessionMood(), actionsSince = 0, trigger = 4 + Math.floor(Math.random() * 5);
    for (let i = 0; i < contacts.length; i++) {
        const cur = S.userSessions.get(userId);
        if (!cur?.loggedIn) {
            await S.safeReply(ctx, `⚠️ Session WA terputus.\n\n✅ Berhasil: ${berhasil}\n📵 No WA: ${notWA}\n❌ Belum: ${total - berhasil - notWA}`);
            S.vcfPending.delete(userId); return;
        }
        if (++actionsSince >= trigger) { mood = getSessionMood(); actionsSince = 0; trigger = 4 + Math.floor(Math.random() * 5); }
        const c = contacts[i];
        try {
            const [r] = await cur.sock.onWhatsApp(c.phone);
            if (!r?.exists) { notWA++; if (i + 1 < contacts.length) await humanDelayNatural(3, 8); continue; }
            await simulateReadAndType(cur.sock, groupId, true);
            await cur.sock.groupParticipantsUpdate(groupId, [r.jid], 'add');
            berhasil++;
            try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, `⏳ ${i+1}/${total}\n✅ ${berhasil} | 📵 ${notWA} | ❌ ${gagal}\n_Mood: ${mood}_`); } catch (_) {}
            if (i + 1 < contacts.length) {
                if (Math.random() < 0.10) { await humanDelayLongBreak('add-break'); mood = getSessionMood(); actionsSince = 0; }
                else await humanDelayAdd(mood);
            }
        } catch (err) {
            gagal++;
            S.log('ERROR', 'Add', err.message);
            if (err.message?.includes('Connection Closed') || err.message?.includes('Connection Lost')) {
                await S.safeReply(ctx, `🔴 Koneksi WA terputus.\n✅ ${berhasil} | 📵 ${notWA} | ❌ ${total-berhasil-notWA}`);
                S.vcfPending.delete(userId); return;
            }
            await humanDelayError();
        }
    }
    await S.safeReply(ctx, `╔${S.DIVIDER}╗\n║  HASIL IMPORT VCF\n╚${S.DIVIDER}╝\n\n🎯 Grup: ${S.esc(groupName)}\n\n${S.DIVIDER_THIN}\n✅ Berhasil: ${berhasil}\n📵 Tidak ada WA: ${notWA}\n❌ Error: ${gagal}`);
    S.vcfPending.delete(userId);
}

// ========== DESTROY SESSION ==========
async function destroySession(userId) {
    const old = S.userSessions.get(userId);
    if (!old) return;
    if (old.qrTimer)    clearTimeout(old.qrTimer);
    if (old.reconnTimer) clearTimeout(old.reconnTimer);
    try { old.sock.ev.removeAllListeners(); old.sock.end(new Error('destroyed')); }
    catch (err) { S.log('WARN', 'Destroy', err.message); }
    S.userSessions.delete(userId);
    await new Promise(r => setTimeout(r, 3500));
}

// ========== LOGIN ==========
async function startLogin(ctx, userId) {
    const cooldown = S.conflictCooldowns.get(userId);
    if (cooldown && Date.now() < cooldown) {
        const sisa = Math.ceil((cooldown - Date.now()) / 1000);
        return S.safeReply(ctx, `⏳ Tunggu ${sisa} detik\n\n_Anti Stream Conflict aktif_`);
    }
    if (S.loginLocks.get(userId)) return S.safeReply(ctx, '⏳ Login sedang berjalan...');
    S.loginLocks.set(userId, true);
    try {
        if (S.userSessions.has(userId)) { await S.safeReply(ctx, '🔄 _Menutup koneksi lama..._'); await destroySession(userId); }
        const authFolder = getEncryptedAuthFolder(userId);
        const { version }       = await fetchLatestBaileysVersion();
        const browserProfile    = generateDynamicFingerprint();
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const connectAnim       = await liveConnecting(ctx);
        const sock = makeWASocket({
            auth: state, browser: browserProfile,
            logger: pino({ level: 'silent' }),
            connectTimeoutMs: 60000, defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 30000, retryRequestDelayMs: 500,
            version, generateHighQualityLinkPreview: false,
            printQRInTerminal: false, shouldReconnect: () => false,
        });
        const session = {
            sock, saveCreds, qrTimer: null, reconnTimer: null,
            lastQR: null, qrBlocked: false, loggedIn: false,
            groupId: null, groupName: null, members: [],
            _groupPickerList: null, _vcfGroupPickerList: null,
            createdAt: Date.now(), lastActivity: Date.now(),
        };
        S.userSessions.set(userId, session);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                session.lastQR = qr;
                if (!session.qrBlocked) {
                    session.qrBlocked = true;
                    try { await connectAnim.stop(null); } catch (_) {}
                    await sendQR(ctx, qr);
                    session.qrTimer = setTimeout(async () => {
                        if (!session.loggedIn) { session.qrBlocked = false; await S.safeReply(ctx, '⏱ QR expired. Ketik /refreshqr untuk QR baru.'); }
                    }, 60000);
                }
            }
            if (connection === 'close') {
                if (session.qrTimer)    clearTimeout(session.qrTimer);
                if (session.reconnTimer) clearTimeout(session.reconnTimer);
                const err        = lastDisconnect?.error;
                const statusCode = err?.output?.statusCode ?? err?.output?.payload?.statusCode;
                const attempts   = (S.reconnectAttempts.get(userId) || 0) + 1;
                S.log('INFO', 'Connection', `[${userId}] close code=${statusCode} attempt=${attempts}`);
                if (statusCode === 515) {
                    sock.ev.removeAllListeners(); S.userSessions.delete(userId);
                    S.reconnectAttempts.delete(userId);
                    S.conflictCooldowns.set(userId, Date.now() + S.CONFLICT_COOLDOWN_MS);
                    try { await connectAnim.stop(null); } catch (_) {}
                    await S.safeReply(ctx, `⚠️ Stream Conflict (515)\n\nWA mendeteksi koneksi ganda.\n\n• Bot restart terlalu cepat\n• Ada instance bot lain aktif\n• Session belum dilepas server WA`);
                    await liveCountdown(ctx, S.CONFLICT_COOLDOWN_MS, 'Cooldown Stream Conflict', () => S.conflictCooldowns.delete(userId));
                    return;
                }
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                    sock.ev.removeAllListeners(); S.userSessions.delete(userId); S.reconnectAttempts.delete(userId);
                    await S.safeReply(ctx, '🚫 Session ditolak WhatsApp.\nTekan 🔑 Login WhatsApp.');
                    return;
                }
                if (attempts <= S.MAX_RECONNECT_ATTEMPTS) {
                    S.reconnectAttempts.set(userId, attempts);
                    const delayMs = Math.min(5000 * Math.pow(2, attempts - 1), 30000);
                    sock.ev.removeAllListeners(); S.userSessions.delete(userId);
                    await S.safeReply(ctx, `🔌 Terputus (${statusCode || '?'}).\n🔄 Reconnect dalam ${Math.ceil(delayMs/1000)}s... (${attempts}/${S.MAX_RECONNECT_ATTEMPTS})`);
                    const t = setTimeout(async () => { try { await startLogin(ctx, userId); } catch (e) { S.log('ERROR','Login','Auto-reconnect error',e); } }, delayMs);
                    const pending = S.userSessions.get(userId);
                    if (pending) pending.reconnTimer = t;
                    else S.userSessions.set(userId, { reconnTimer: t, loggedIn: false, _pendingReconn: true });
                } else {
                    sock.ev.removeAllListeners(); S.userSessions.delete(userId); S.reconnectAttempts.delete(userId);
                    await S.safeReply(ctx, `❌ Koneksi gagal ${S.MAX_RECONNECT_ATTEMPTS}x.\n\nTekan 🔑 Login WhatsApp untuk coba manual.`);
                }
            }
            if (connection === 'open') {
                session.loggedIn = true;
                if (session.qrTimer) clearTimeout(session.qrTimer);
                S.reconnectAttempts.delete(userId); S.conflictCooldowns.delete(userId);
                try { await connectAnim.stop(null); } catch (_) {}
                try { await sock.sendPresenceUpdate('available'); } catch (_) {}
                startBackgroundActivitySpooler(sock, userId);
                await S.safeReply(ctx, '✅ LOGIN WHATSAPP BERHASIL!\n\nPilih menu di keyboard bawah.', { ...(S.isAdmin(userId) ? S.KB_ADMIN_MAIN : S.KB_MAIN) });
            }
        });
        sock.ev.on('creds.update', saveCreds);
    } catch (err) {
        S.log('ERROR', 'Login', err.message, err);
        await S.safeReply(ctx, `❌ Gagal login: ${S.esc(err.message)}`);
    } finally { S.loginLocks.delete(userId); }
}

// ========== GROUP & KICK MENU ==========
async function showGroupPicker(ctx, userId, session) {
    S.touchSession(userId);
    const anim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (!groups.length) { await anim.stop('❌ Tidak ada grup.'); return; }
        const isTrial = await S.isTrialOnly(userId);
        const display = isTrial ? groups.slice(0, 1) : groups;
        session._groupPickerList = display;
        const buttons = display.map((g, i) => {
            const label = `${i+1}. ${g.subject} (${g.participants?.length || 0} 👥)`.substring(0, 64);
            return [Markup.button.callback(label, `selectgrp_${i}`)];
        });
        buttons.push([Markup.button.callback('❌ Batal', 'selectgrp_cancel')]);
        await anim.stop(null);
        let header = `╔${S.DIVIDER}╗\n║  PILIH GRUP\n╚${S.DIVIDER}╝\n\n`;
        if (isTrial) header += `⚠️ _Trial: hanya 1 grup_\n\n`;
        header += 'Ketuk nama grup yang ingin dipilih:';
        await S.safeReply(ctx, header, { reply_markup: { inline_keyboard: buttons } });
    } catch (err) { await anim.stop(`❌ Error: ${S.esc(err.message)}`); }
}

function buildMemberKeyboard(members, selected) {
    const buttons = members.map(m => [Markup.button.callback(
        `${selected.has(m.jid) ? '✅' : '⬜'} ${m.name.substring(0, 25)}`, `toggle_${m.jid}`
    )]);
    buttons.push([Markup.button.callback('🔨 KICK TERPILIH', 'do_kick')]);
    buttons.push([Markup.button.callback('❌ BATAL', 'cancel_kick')]);
    return { reply_markup: { inline_keyboard: buttons } };
}

async function showKickMenu(ctx, userId, session) {
    S.touchSession(userId);
    const anim = await spinnerMessage(ctx, 'Mengambil daftar anggota...');
    try {
        const metadata  = await session.sock.groupMetadata(session.groupId);
        const myJid     = session.sock.user.id.replace(/:.*@/, '@');
        const allMembers = metadata.participants
            .filter(p => {
                const isMe  = p.id === myJid || p.id.split('@')[0] === myJid.split('@')[0];
                const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
                return !isMe && !isAdm;
            })
            .map(p => ({ jid: p.id, name: p.id.split('@')[0] }));
        if (!allMembers.length) { await anim.stop(null); return S.safeReply(ctx, 'ℹ️ Tidak ada anggota yang bisa dikick.\n\nSemua anggota adalah admin.'); }
        session.members = allMembers;
        S.kickSelections.set(userId, new Set());
        await anim.stop(null);
        await S.safeReply(ctx,
            `╔${S.DIVIDER}╗\n║  MENU KICK ANGGOTA\n╚${S.DIVIDER}╝\n\n🎯 Grup: ${S.esc(session.groupName || '')}\n👥 Non-admin: ${allMembers.length} orang\n\nKetuk nama untuk pilih/batal.\n\n⚠️ _Kick tidak bisa dibatalkan!_`,
            { ...buildMemberKeyboard(allMembers, S.kickSelections.get(userId)) }
        );
    } catch (err) { await anim.stop(`❌ Error: ${S.esc(err.message)}`); }
}

// ========== PAYMENT ==========
async function showPriceMenu(ctx) {
    const kb = Markup.inlineKeyboard(
        Object.entries(S.PACKAGES).map(([k, p]) => [Markup.button.callback(`📦 ${p.label} — ${S.formatRupiah(p.price)}`, `buy_${k}`)])
    );
    await S.safeReply(ctx,
        `╔${S.DIVIDER}╗\n║  PAKET HARGA\n╚${S.DIVIDER}╝\n\n` +
        Object.values(S.PACKAGES).map(p => `📦 ${p.label} → ${S.formatRupiah(p.price)}`).join('\n') +
        '\n\nPilih paket di bawah:',
        { ...kb }
    );
}

// ========== SESSION CLEANUP ==========
setInterval(async () => {
    const now = Date.now();
    for (const [uid, sess] of S.userSessions.entries())
        if (sess.lastActivity && (now - sess.lastActivity) > S.SESSION_IDLE_MS) {
            S.log('INFO', 'Cleanup', `Session idle ${uid}`);
            await destroySession(uid);
        }
    if (S.userSessions.size > S.MAX_CONCURRENT_SESSIONS) {
        S.log('WARN', 'Cleanup', `Over limit (${S.userSessions.size})`);
        const oldest = [...S.userSessions.entries()].sort((a, b) => (a[1].createdAt||0) - (b[1].createdAt||0))[0];
        if (oldest) await destroySession(oldest[0]);
    }
    for (const [uid, entry] of S.rateLimitMap.entries())
        if (now > entry.resetAt + 60000) S.rateLimitMap.delete(uid);
    for (const [uid, p] of S.vcfPending.entries())
        if (p.createdAt && now - p.createdAt > 15 * 60 * 1000) S.vcfPending.delete(uid);
    for (const [uid, t] of S.loginLocks.entries())
        if (now - t > 5 * 60 * 1000) S.loginLocks.delete(uid);
}, 30 * 60 * 1000);

// ========== REGISTER HANDLERS ke tgBot ==========
function register(tgBot) {

    // Rate limit middleware
    tgBot.use(async (ctx, next) => {
        const uid = ctx.from?.id;
        if (uid && S.isRateLimited(uid)) { try { await S.safeReply(ctx, '⏳ Terlalu cepat!'); } catch (_) {} return; }
        return next();
    });

    // /start
    tgBot.command('start', async ctx => {
        const userId   = ctx.from.id;
        const name     = ctx.from.first_name || 'User';
        const status   = await S.getUserStatus(userId);
        const loggedIn = S.userSessions.get(userId)?.loggedIn;
        const kb       = await S.getKeyboard(userId);
        if (S.isAdmin(userId))
            return S.safeReply(ctx, `╔${S.DIVIDER}╗\n║  ${S.BOT_NAME}\n╚${S.DIVIDER}╝\n\n👑 Admin ${S.esc(name)}\n\n${loggedIn ? '✅ WA: *Terhubung*' : '🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp*'}`, { ...kb });
        if (status === 'regular') {
            const u = S.db.getUser(userId);
            return S.safeReply(ctx, `╔${S.DIVIDER}╗\n║  ${S.BOT_NAME}\n╚${S.DIVIDER}╝\n\n✅ Halo ${S.esc(name)}!\n\n🏷️ Premium Aktif\n📅 Hingga: ${S.formatDate(u.expiresAt)}\n⏳ Sisa: ${S.formatCountdown(u.expiresAt)}\n\n${loggedIn ? '📡 WA: *Terhubung* ✅' : '🔴 WA: *Belum login*'}`, { ...kb });
        }
        if (status === 'trial') {
            const u = S.db.getUser(userId);
            return S.safeReply(ctx, `╔${S.DIVIDER}╗\n║  ${S.BOT_NAME}\n╚${S.DIVIDER}╝\n\n🎁 Halo ${S.esc(name)}!\n\n🏷️ Trial Aktif\n⏱ Habis: ${S.formatDate(u.trialExpiresAt)}\n⏳ Sisa: ${S.formatCountdown(u.trialExpiresAt)}\n\n${loggedIn ? '📡 WA: *Terhubung* ✅' : '🔴 WA: *Belum login*'}`, { ...kb });
        }
        if (status === 'expired' || status === 'trial_expired')
            return S.safeReply(ctx, '⚠️ Akses lo sudah berakhir.\nPerpanjang untuk pakai lagi!', { ...kb });
        await S.safeReply(ctx, `${S.BOT_NAME}\n\n👋 Halo ${S.esc(name)}!\n\nBot ini bisa:\n• Kick anggota grup WA\n• Import kontak VCF ke grup\n• Buat grup baru\n\n🔧 File Tools bisa diakses semua orang.\nPilih menu di bawah 👇`, { ...kb });
    });

    // /trial
    tgBot.command('trial', async ctx => {
        const user   = ctx.from;
        const status = await S.getUserStatus(user.id);
        if (status === 'admin')   return S.safeReply(ctx, '👑 Lo adalah admin.', await S.getKeyboard(user.id));
        if (status === 'regular') return S.safeReply(ctx, '✅ Sudah punya akses reguler.', await S.getKeyboard(user.id));
        if (status === 'trial') {
            const u = S.db.getUser(user.id);
            return S.safeReply(ctx, `⏱ Masih trial. Sisa: ${S.formatCountdown(u.trialExpiresAt)}`, { ...S.KB_PRE_LOGIN });
        }
        const existing = S.db.getUser(user.id);
        if (existing?.hadTrial) return S.safeReply(ctx, '❌ Sudah pernah trial.\nKetik /beli untuk upgrade.');
        const exp = new Date(Date.now() + S.TRIAL_DURATION_HOURS * 3600000).toISOString();
        S.db.saveUser({ id: user.id, role: 'trial', trialExpiresAt: exp, hadTrial: 1, notifiedExpiry: 0 });
        await S.safeReply(ctx, `🎉 TRIAL AKTIF!\n\n✅ ${S.TRIAL_DURATION_HOURS} jam\n⏱ Berakhir: ${S.formatDate(exp)}\n\nTekan 🔑 Login WhatsApp untuk mulai!`, { ...S.KB_PRE_LOGIN });
    });

    // /beli
    tgBot.command('beli', async ctx => {
        if (S.isAdmin(ctx.from.id)) return S.safeReply(ctx, '👑 Admin tidak perlu beli paket.');
        await showPriceMenu(ctx);
    });

    // /login
    tgBot.command('login', S.requireAccess, async ctx => {
        const s = S.userSessions.get(ctx.from.id);
        if (s?.loggedIn) return S.safeReply(ctx, '✅ Sudah login!');
        try { await startLogin(ctx, ctx.from.id); }
        catch (err) { await S.safeReply(ctx, `❌ Gagal: ${S.esc(err.message)}`); }
    });

    // /refreshqr
    tgBot.command('refreshqr', S.requireAccess, async ctx => {
        const s = S.userSessions.get(ctx.from.id);
        if (!s)           return S.safeReply(ctx, '❌ Belum ada sesi.');
        if (s.loggedIn)   return S.safeReply(ctx, '✅ Sudah login!');
        if (!s.lastQR)    return S.safeReply(ctx, '⏳ QR belum tersedia.');
        await sendQR(ctx, s.lastQR);
    });

    // /logout
    const doLogout = async (ctx) => {
        const userId = ctx.from.id;
        if (!S.userSessions.has(userId)) return S.safeReply(ctx, '❌ Belum login!');
        try {
            await destroySession(userId);
            const af = getEncryptedAuthFolder(userId);
            if (fs.existsSync(af)) fs.rmSync(af, { recursive: true, force: true });
            S.kickSelections.delete(userId); S.reconnectAttempts.delete(userId);
            S.conflictCooldowns.delete(userId); S.loginLocks.delete(userId); S.vcfPending.delete(userId);
            const kb = await S.getKeyboard(userId);
            await S.safeReply(ctx, '✅ Logout berhasil.', { ...kb });
        } catch (err) { await S.safeReply(ctx, `❌ Error: ${S.esc(err.message)}`); }
    };
    tgBot.command('logout', S.requireAccess, doLogout);

    // /status
    const doStatus = async ctx => {
        const userId   = ctx.from.id;
        const session  = S.userSessions.get(userId);
        const status   = await S.getUserStatus(userId);
        const u        = S.db.getUser(userId);
        const waStatus = !session ? '🔴 Belum Login' : session.loggedIn ? '🟢 Terhubung' : '🟡 Menunggu QR';
        const accLine  = status === 'admin' ? '👑 Admin'
            : status === 'regular' ? `⭐ Reguler (${S.formatCountdown(u?.expiresAt)})`
            : status === 'trial'   ? `🎁 Trial (${S.formatCountdown(u?.trialExpiresAt)})`
            : '-';
        await S.safeReply(ctx, `📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`);
    };
    tgBot.command('status', S.requireAccess, doStatus);

    // /myaccount
    tgBot.command('myaccount', async ctx => {
        const userId = ctx.from.id;
        const status = await S.getUserStatus(userId);
        if (status === 'admin') return S.safeReply(ctx, '👑 Admin bot.');
        const u = S.db.getUser(userId);
        if (!u) return S.safeReply(ctx, 'Belum terdaftar. Tekan 🎁 Coba Gratis', { ...S.KB_LANDING });
        await S.safeReply(ctx, `👤 ID: ${u.id}\nStatus: ${status}\nExp: ${u.expiresAt ? S.formatDate(u.expiresAt) : u.trialExpiresAt ? S.formatDate(u.trialExpiresAt) : '-'}`);
    });

    // /groups
    tgBot.command('groups', S.requireAccess, async ctx => {
        const s = S.userSessions.get(ctx.from.id);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        await showGroupPicker(ctx, ctx.from.id, s);
    });

    // /kickmenu
    tgBot.command('kickmenu', S.requireAccess, async ctx => {
        const s = S.userSessions.get(ctx.from.id);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        if (!s.groupId)   return S.safeReply(ctx, '❌ Pilih grup dulu!');
        await showKickMenu(ctx, ctx.from.id, s);
    });

    // /buatgrup (via command langsung)
    tgBot.command('buatgrup', S.requireAccess, async ctx => {
        const userId = ctx.from.id;
        const s      = S.userSessions.get(userId);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        const nama = ctx.message.text.replace('/buatgrup', '').trim().replace(/^['"]|['"]$/g, '');
        if (!nama) return S.safeReply(ctx, 'Format: /buatgrup "Nama Grup"');
        if (nama.length > 100) return S.safeReply(ctx, '❌ Nama terlalu panjang (maks 100 karakter).');
        try {
            const result = await s.sock.groupCreate(nama, []);
            s.groupId = result.id; s.groupName = nama;
            let link = '-';
            try { link = `https://chat.whatsapp.com/${await s.sock.groupInviteCode(result.id)}`; } catch (_) {}
            await S.safeReply(ctx, `✅ Grup berhasil dibuat!\n\n📋 ${nama}\n🔗 ${link}`);
        } catch (err) { await S.safeReply(ctx, `❌ Gagal: ${S.esc(err.message)}`); }
    });

    // /importvcf
    tgBot.command('importvcf', S.requireAccess, async ctx => {
        const userId = ctx.from.id;
        const s      = S.userSessions.get(userId);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        await showVcfGroupPicker(ctx, userId, s);
    });

    // /help
    tgBot.command('help', async ctx => {
        await S.safeReply(ctx,
            `🤖 *${S.BOT_NAME} - PANDUAN*\n\n` +
            `${'─'.repeat(30)}\n*📱 FITUR WA*\n` +
            `🔑 Login → Scan QR\n📋 Daftar/Pilih Grup\n➕ Buat Grup WA\n📥 Import VCF ke grup\n🔴 Kick anggota\n🚪 Logout WA\n\n` +
            `${'─'.repeat(30)}\n*🔧 FILE TOOLS*\nLihat menu 🔧 File Tools\n\n` +
            `${'─'.repeat(30)}\n*📋 PERINTAH*\n/start /trial /beli /login\n/refreshqr /logout /status\n/groups /kickmenu /buatgrup\n/importvcf /help\n\n` +
            `${'─'.repeat(30)}\n*💳 PEMBAYARAN*\n${S.PAYMENT_INFO}\nKonfirmasi: ${S.PAYMENT_CONTACT}`
        );
    });

    // /adduser
    tgBot.command('adduser', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return S.safeReply(ctx, '⛔ Akses ditolak.');
        const args = ctx.message.text.split(' ');
        const targetId = parseInt(args[1]); const pkgKey = args[2];
        if (!targetId || !pkgKey || !S.PACKAGES[pkgKey])
            return S.safeReply(ctx, 'Format: /adduser [user_id] [paket]\n\nPaket: 1bulan / 3bulan / 6bulan / 1tahun');
        const pkg = S.PACKAGES[pkgKey];
        const exp = new Date(Date.now() + pkg.days * 24 * 3600000).toISOString();
        S.db.saveUser({ id: targetId, role: 'regular', package: pkgKey, expiresAt: exp, hadTrial: 1, notifiedExpiry: 0 });
        await S.safeReply(ctx, `✅ User ditambahkan!\n\n🆔 ID: \`${targetId}\`\n📦 ${pkg.label}\n📅 ${S.formatDate(exp)}`);
        try { await tgBot.telegram.sendMessage(targetId, `🎉 Akses ${S.BOT_NAME} diaktifkan!\n\n📦 ${pkg.label}\n📅 ${S.formatDate(exp)}\n\nTekan 🔑 Login WhatsApp.`, { parse_mode: 'Markdown', ...S.KB_PRE_LOGIN }); } catch (_) {}
    });

    // /revoke
    tgBot.command('revoke', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return S.safeReply(ctx, '⛔ Hanya admin!');
        const userId = parseInt(ctx.message.text.split(' ')[1]);
        if (isNaN(userId)) return S.safeReply(ctx, 'Cara: /revoke [user_id]');
        if (!S.db.getUser(userId)) return S.safeReply(ctx, `❌ User ${userId} tidak ditemukan.`);
        S.db.deleteUser(userId);
        if (S.userSessions.has(userId)) { try { await destroySession(userId); } catch (_) {} }
        S.kickSelections.delete(userId); S.reconnectAttempts.delete(userId);
        S.conflictCooldowns.delete(userId); S.loginLocks.delete(userId);
        await S.safeReply(ctx, `✅ Akses user ${userId} dicabut.`);
        try { await tgBot.telegram.sendMessage(userId, `🔴 Akses dicabut.\nHub. admin: ${S.PAYMENT_CONTACT}`); } catch (_) {}
    });

    // /pendingpayment & /userlist
    tgBot.command('pendingpayment', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return;
        const list = S.db.getAllPendingPayments();
        if (!list.length) return S.safeReply(ctx, '📭 Tidak ada pending.');
        await S.safeReply(ctx, `PENDING: ${list.length}\n\n` + list.map(p => `👤 ${p.id}\n📦 ${p.packageKey||p.package}\n📅 ${S.formatDate(p.requestedAt||p.date)}`).join('\n\n'));
    });
    tgBot.command('userlist', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return S.safeReply(ctx, '⛔ Akses ditolak.');
        const users = S.db.getAllUsers();
        if (!users.length) return S.safeReply(ctx, 'Belum ada user.');
        const now     = new Date();
        const actives = users.filter(u => { const e = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt; return e && new Date(e) > now; });
        const expired = users.filter(u => { const e = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt; return !e || new Date(e) <= now; });
        let msg = `╔${S.DIVIDER}╗\n║  DAFTAR USER\n╚${S.DIVIDER}╝\n\n✅ Aktif: ${actives.length} | ❌ Expired: ${expired.length}\n\n`;
        actives.forEach((u, i) => { const e = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt; msg += `${i+1}. ID: \`${u.id}\` | ${u.role === 'trial' ? '🎁' : '⭐'}\n   Exp: ${S.formatDate(e)} (${S.formatCountdown(e)})\n\n`; });
        if (expired.length <= 10) expired.forEach((u, i) => { const e = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt; msg += `${i+1}. ID: \`${u.id}\` Expired: ${S.formatDate(e)}\n\n`; });
        else msg += `_(+${expired.length} expired tidak ditampilkan)_`;
        msg += '\n\n/revoke [id] — Cabut akses';
        await S.safeReply(ctx, msg);
    });

    // ===== HEARS =====
    tgBot.hears('🎁 Coba Gratis (Trial)', async ctx => {
        const userId = ctx.from.id;
        if (S.isAdmin(userId)) return S.safeReply(ctx, '👑 Admin tidak perlu trial.');
        const existing = S.db.getUser(userId);
        if (existing?.hadTrial) return S.safeReply(ctx, '❌ Sudah pernah trial.\nKetik /beli untuk upgrade.');
        if (existing?.role === 'regular') return S.safeReply(ctx, '✅ Sudah punya paket premium aktif!');
        const exp = new Date(Date.now() + S.TRIAL_DURATION_HOURS * 3600000).toISOString();
        S.db.saveUser({ id: userId, role: 'trial', trialExpiresAt: exp, hadTrial: 1, notifiedExpiry: 0 });
        await S.safeReply(ctx, `🎁 TRIAL AKTIF!\n\n⏳ ${S.TRIAL_DURATION_HOURS} jam\n📅 Berakhir: ${S.formatDate(exp)}\n\nSelamat mencoba!`, { ...(await S.getKeyboard(userId)) });
    });
    tgBot.hears('⭐ Premium', async ctx => {
        if (S.isAdmin(ctx.from.id)) return S.safeReply(ctx, '👑 Admin tidak perlu beli paket.');
        await showPriceMenu(ctx);
    });
    tgBot.hears('❓ Bantuan', async ctx => {
        await S.safeReply(ctx,
            `🤖 *${S.BOT_NAME} - PANDUAN*\n\n` +
            `📱 *Fitur WA:* Login → Pilih Grup → Import VCF / Kick\n` +
            `🔧 *File Tools:* Tekan tombol 🔧 File Tools\n\n` +
            `Butuh bantuan? Hub. ${S.PAYMENT_CONTACT}`
        );
    });
    tgBot.hears('🔑 Login WhatsApp', S.requireAccess, async ctx => {
        const s = S.userSessions.get(ctx.from.id);
        if (s?.loggedIn) return S.safeReply(ctx, '✅ Sudah login!');
        try { await startLogin(ctx, ctx.from.id); }
        catch (err) { await S.safeReply(ctx, `❌ Gagal: ${S.esc(err.message)}`); }
    });
    tgBot.hears(['📋 Daftar Grup', '🎯 Pilih Grup'], S.requireAccess, async ctx => {
        const s = S.userSessions.get(ctx.from.id);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        await showGroupPicker(ctx, ctx.from.id, s);
    });
    tgBot.hears('➕ Buat Grup WA', S.requireAccess, async ctx => {
        const s = S.userSessions.get(ctx.from.id);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        S.setState(ctx.from.id, { mode: 'buatgrup', phase: 'waiting_name' });
        await S.safeReply(ctx, '➕ Buat Grup WA\n\nKirim nama grup:\nKetik /batal untuk membatalkan.');
    });
    tgBot.hears('📥 Import VCF', S.requireAccess, async ctx => {
        const s = S.userSessions.get(ctx.from.id);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        await showVcfGroupPicker(ctx, ctx.from.id, s);
    });
    tgBot.hears('🔴 Kick Menu', S.requireAccess, async ctx => {
        const userId = ctx.from.id;
        const s      = S.userSessions.get(userId);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        if (!s.groupId)   return S.safeReply(ctx, '❌ Pilih grup dulu!');
        await showKickMenu(ctx, userId, s);
    });
    tgBot.hears('📊 Status', S.requireAccess, doStatus);
    tgBot.hears('🚪 Logout WhatsApp', S.requireAccess, doLogout);
    tgBot.hears('📋 Pending Payment', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return;
        const list = S.db.getAllPendingPayments();
        if (!list.length) return S.safeReply(ctx, '📭 Tidak ada pending.');
        await S.safeReply(ctx, `PENDING: ${list.length}\n\n` + list.map(p => `👤 ${p.id}\n📦 ${p.packageKey||p.package}\n📅 ${S.formatDate(p.requestedAt||p.date)}`).join('\n\n'));
    });
    tgBot.hears('👥 User List', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return S.safeReply(ctx, '⛔ Hanya admin.');
        const users = S.db.getAllUsers();
        if (!users.length) return S.safeReply(ctx, '👥 Belum ada user terdaftar.');
        const buttons = users.slice(0, 30).map(u => [Markup.button.callback(
            `${u.role === 'regular' ? '⭐' : u.role === 'trial' ? '🎁' : '❓'} ${u.id} (${u.role})`,
            `userinfo_${u.id}`
        )]);
        buttons.push([Markup.button.callback('❌ Tutup', 'close_userlist')]);
        await S.safeReply(ctx, `👥 DAFTAR USER (${users.length})`, { reply_markup: { inline_keyboard: buttons } });
    });
    // 📋 List Grup WA (dari File Tools menu)
    tgBot.hears('📋 List Grup WA', S.requireAccess, async ctx => {
        const s = S.userSessions.get(ctx.from.id);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        await showGroupPicker(ctx, ctx.from.id, s);
    });

    // ===== VCF GROUP PICKER =====
    async function showVcfGroupPicker(ctx, userId, session) {
        const anim = await spinnerMessage(ctx, 'Mengambil daftar grup...');
        try {
            const chats  = await session.sock.groupFetchAllParticipating();
            const groups = Object.values(chats);
            if (!groups.length) { await anim.stop('❌ Tidak ada grup.'); return; }
            const isTrial = await S.isTrialOnly(userId);
            const display = isTrial ? groups.slice(0, 1) : groups;
            session._vcfGroupPickerList = display;
            const buttons = display.map((g, i) => [Markup.button.callback(
                `${i+1}. ${g.subject} (${g.participants?.length || 0} 👥)`.substring(0, 64), `vcfgrp_${i}`
            )]);
            buttons.push([Markup.button.callback('❌ Batal', 'vcfgrp_cancel')]);
            await anim.stop(null);
            let header = `╔${S.DIVIDER}╗\n║  PILIH GRUP TUJUAN VCF\n╚${S.DIVIDER}╝\n\n`;
            if (isTrial) header += `⚠️ _Trial: hanya 1 grup_\n\n`;
            header += 'Pilih grup tujuan:';
            await S.safeReply(ctx, header, { reply_markup: { inline_keyboard: buttons } });
        } catch (err) { await anim.stop(`❌ Error: ${S.esc(err.message)}`); }
    }

    // ===== DOCUMENT HANDLER (VCF import WA) =====
    // Hanya handle jika ada vcfPending aktif — File Tools sudah di filetools.js
    tgBot.on('document', async (ctx, next) => {
        const userId  = ctx.from.id;
        const pending = S.vcfPending.get(userId);
        if (!pending?.waitingFile) return next(); // lanjut ke filetools
        const doc   = ctx.message.document;
        const fname = doc.file_name || '';
        if (!fname.toLowerCase().endsWith('.vcf'))
            return S.safeReply(ctx, '⚠️ File harus .vcf');
        if (doc.file_size && doc.file_size > 5 * 1024 * 1024) {
            S.vcfPending.delete(userId);
            return S.safeReply(ctx, '❌ File terlalu besar. Maks 5MB.');
        }
        await S.safeReply(ctx, '⏳ Membaca file VCF...');
        try {
            const link = await ctx.telegram.getFileLink(doc.file_id);
            const resp = await fetch(link.href);
            const contacts = S.parseVCF(await resp.text());
            if (!contacts.length) { S.vcfPending.delete(userId); return S.safeReply(ctx, '❌ Tidak ada nomor valid.'); }
            pending.contacts    = contacts;
            pending.waitingFile = false;
            S.vcfPending.set(userId, pending);
            await S.safeReply(ctx, `📊 ${contacts.length} kontak ditemukan.\n🎯 Grup: ${pending.groupName}\n\nTambahkan sekarang?`, {
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`✅ Tambah Semua (${contacts.length})`, 'vcf_add_all')],
                    [Markup.button.callback('❌ Batal', 'vcf_cancel')],
                ]),
            });
        } catch (err) { S.vcfPending.delete(userId); await S.safeReply(ctx, `❌ Error: ${S.esc(err.message)}`); }
    });

    // Buatgrup: waiting_name via state
    tgBot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId || !ctx.message?.text) return next();
        const state = S.getState(userId);
        if (!state || state.mode !== 'buatgrup' || ctx.message.text.startsWith('/')) return next();
        if (state.phase === 'waiting_name') {
            const gname = ctx.message.text.trim();
            if (!gname || gname.length > 100) return S.safeReply(ctx, '❌ Nama tidak valid (maks 100 karakter).');
            S.setState(userId, { ...state, phase: 'waiting_vcf', groupName: gname });
            await S.safeReply(ctx, `📋 Nama: ${gname}\n\nKirim file .vcf untuk ditambahkan ke grup.\nAtau ketik /buatkosongan untuk buat tanpa member.\nKetik /batal untuk batal.`);
            return;
        }
        return next();
    });

    // /buatkosongan
    tgBot.command('buatkosongan', async ctx => {
        const userId = ctx.from.id;
        const s      = S.userSessions.get(userId);
        if (!s?.loggedIn) return S.safeReply(ctx, '❌ Login dulu!');
        const state = S.getState(userId);
        if (!state || state.mode !== 'buatgrup') return S.safeReply(ctx, '❌ Mulai dulu dengan menu ➕ Buat Grup WA.');
        try {
            const result = await s.sock.groupCreate(state.groupName, [s.sock.user?.id]);
            await S.safeReply(ctx, `✅ Grup kosong dibuat!\n\n📋 ${result.subject}\n🆔 ${result.id}`);
            S.clearState(userId);
        } catch (err) { await S.safeReply(ctx, `❌ Gagal: ${S.esc(err.message)}`); S.clearState(userId); }
    });

    // /batal
    tgBot.command('batal', async ctx => {
        S.clearState(ctx.from.id);
        S.vcfPending.delete(ctx.from.id);
        await S.safeReply(ctx, '✅ Proses dibatalkan.');
    });

    // ===== INLINE BUTTON ACTIONS =====
    tgBot.action(/^selectgrp_(\d+|cancel)$/, S.requireAccess, async ctx => {
        const userId = ctx.from.id;
        await ctx.answerCbQuery();
        const param   = ctx.match[1];
        const session = S.userSessions.get(userId);
        if (param === 'cancel') { if (session) session._groupPickerList = null; return ctx.editMessageText('✖ Dibatalkan.'); }
        if (!session?.loggedIn) return ctx.editMessageText('❌ Session habis. Login ulang.');
        const idx  = parseInt(param);
        const list = session._groupPickerList;
        if (!list || isNaN(idx) || idx < 0 || idx >= list.length) return ctx.editMessageText('❌ Data tidak ditemukan.');
        const t = list[idx];
        session.groupId = t.id; session.groupName = t.subject; session._groupPickerList = null;
        await ctx.editMessageText(`✅ Grup terpilih!\n\n🎯 ${S.esc(t.subject)}\n👥 ${t.participants?.length || 0} anggota\n\nTekan 🔴 Kick Menu untuk mulai.`);
    });
    tgBot.action(/^vcfgrp_(\d+|cancel)$/, S.requireAccess, async ctx => {
        const userId = ctx.from.id;
        await ctx.answerCbQuery();
        const param   = ctx.match[1];
        const session = S.userSessions.get(userId);
        if (param === 'cancel') { if (session) session._vcfGroupPickerList = null; return ctx.editMessageText('✖ Dibatalkan.'); }
        if (!session?.loggedIn) return ctx.editMessageText('❌ Session habis. Login ulang.');
        const idx  = parseInt(param);
        const list = session._vcfGroupPickerList;
        if (!list || isNaN(idx) || idx < 0 || idx >= list.length) return ctx.editMessageText('❌ Data tidak ditemukan.');
        const t = list[idx];
        session._vcfGroupPickerList = null;
        S.vcfPending.set(userId, { waitingFile: true, groupId: t.id, groupName: t.subject, createdAt: Date.now() });
        await ctx.editMessageText(`✅ Grup tujuan VCF dipilih!\n\n🎯 ${S.esc(t.subject)}\n👥 ${t.participants?.length || 0} anggota\n\n📎 Kirim file .vcf sekarang.`);
    });
    tgBot.action('vcf_add_all', async ctx => {
        const userId = ctx.from.id;
        if (!await S.canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
        await ctx.answerCbQuery();
        const p = S.vcfPending.get(userId);
        if (!p?.contacts) return S.safeReply(ctx, '❌ Data tidak ditemukan.');
        await addContactsToGroup(ctx, userId, p.contacts, p.groupId, p.groupName);
    });
    tgBot.action('vcf_cancel', async ctx => {
        S.vcfPending.delete(ctx.from.id);
        await ctx.answerCbQuery('Dibatalkan');
        await S.safeReply(ctx, '✖ Import dibatalkan.');
    });
    tgBot.action(/^toggle_(.+)$/, async ctx => {
        const userId = ctx.from.id;
        if (!await S.canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
        S.touchSession(userId);
        const jid      = ctx.match[1];
        const session  = S.userSessions.get(userId);
        if (!session || !S.kickSelections.has(userId)) return ctx.answerCbQuery('Session expired.');
        const sel = S.kickSelections.get(userId);
        if (sel.has(jid)) { sel.delete(jid); await ctx.answerCbQuery('❌ Dihapus'); }
        else              { sel.add(jid);    await ctx.answerCbQuery('✅ Ditambahkan'); }
        try { await ctx.editMessageReplyMarkup(buildMemberKeyboard(session.members, sel).reply_markup); } catch (_) {}
    });
    tgBot.action('do_kick', async ctx => {
        const userId = ctx.from.id;
        if (!await S.canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
        await ctx.answerCbQuery();
        S.touchSession(userId);
        if (!S.isAdmin(userId) && !isActiveHours())
            return S.safeReply(ctx, '⚠️ Kick hanya bisa dilakukan jam 08.00 - 22.00 WIB.\n\n_Menghindari deteksi WA._');
        const session = S.userSessions.get(userId);
        const sel     = S.kickSelections.get(userId);
        if (!session?.loggedIn) return S.safeReply(ctx, '❌ Session expired.');
        if (!sel?.size)         return S.safeReply(ctx, '⚠️ Belum ada yang dipilih!');
        const jidList  = Array.from(sel);
        const kickAnim = await liveKickProgress(ctx, jidList.length);
        const result   = await naturalKickOneByOne(session.sock, session.groupId, jidList, n => kickAnim.update(n));
        S.kickSelections.set(userId, new Set());
        if (result.stopped && result.reason === 'connection')
            await kickAnim.stop(`🔴 Koneksi WA terputus!\n\n🦵 ${result.kicked}/${jidList.length} dikick.`);
        else
            await kickAnim.stop(`✅ Kick Selesai!\n\n🦵 ${result.kicked}/${jidList.length} anggota dikick.\n🎯 ${S.esc(session.groupName || 'N/A')}`);
    });
    tgBot.action('cancel_kick', async ctx => {
        S.kickSelections.set(ctx.from.id, new Set());
        await ctx.answerCbQuery('Dibatalkan');
        await S.safeReply(ctx, '✖ Kick dibatalkan.');
    });

    // Payment approve/reject
    Object.keys(S.PACKAGES).forEach(pkgKey => {
        tgBot.action(`buy_${pkgKey}`, async ctx => {
            await ctx.answerCbQuery();
            if (S.isAdmin(ctx.from.id)) return S.safeReply(ctx, '👑 Admin tidak perlu beli paket.');
            const pkg  = S.PACKAGES[pkgKey];
            const user = ctx.from;
            S.db.addPendingPayment({ id: user.id, username: user.username || null, firstName: user.first_name || '', lastName: user.last_name || '', packageKey: pkgKey, requestedAt: new Date().toISOString() });
            for (const adminId of S.ADMIN_IDS) {
                try {
                    await tgBot.telegram.sendMessage(adminId,
                        `🔔 Permintaan Beli\n👤 ${user.id} (@${user.username || '-'})\n📦 ${pkg.label} (${S.formatRupiah(pkg.price)})`,
                        { ...Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `admin_approve_${user.id}_${pkgKey}`), Markup.button.callback('❌ Reject', `admin_reject_${user.id}`)]]) }
                    );
                } catch (_) {}
            }
            await S.safeReply(ctx, `✅ Permintaan diterima!\n\n💰 ${S.formatRupiah(pkg.price)}\n${S.PAYMENT_INFO}\n\nKonfirmasi ke ${S.PAYMENT_CONTACT}: KICKER-${user.id}-${pkgKey}`);
        });
    });
    tgBot.action(/^admin_approve_(\d+)_(\w+)$/, async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
        await ctx.answerCbQuery();
        const targetId = parseInt(ctx.match[1]); const pkgKey = ctx.match[2];
        if (!S.PACKAGES[pkgKey]) return ctx.editMessageText(`❌ Paket tidak valid: ${pkgKey}`);
        const pkg = S.PACKAGES[pkgKey];
        const exp = new Date(Date.now() + pkg.days * 24 * 3600000).toISOString();
        S.db.saveUser({ id: targetId, role: 'regular', package: pkgKey, expiresAt: exp, hadTrial: 1, notifiedExpiry: 0 });
        S.db.removePendingPayment(targetId);
        await ctx.editMessageText(`✅ APPROVED!\nID: ${targetId}\nPaket: ${pkg.label}\nAktif hingga: ${S.formatDate(exp)}`);
        try { await tgBot.telegram.sendMessage(targetId, `🎉 PEMBAYARAN DIKONFIRMASI!\n\n📦 ${pkg.label}\n📅 ${S.formatDate(exp)}\n\nTekan 🔑 Login WhatsApp.`, { parse_mode: 'Markdown', ...S.KB_PRE_LOGIN }); } catch (_) {}
    });
    tgBot.action(/^admin_reject_(\d+)$/, async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
        await ctx.answerCbQuery();
        const targetId = parseInt(ctx.match[1]);
        S.db.removePendingPayment(targetId);
        await ctx.editMessageText(`❌ REJECTED\nID: ${targetId}`);
        try { await tgBot.telegram.sendMessage(targetId, `❌ Pembayaran ditolak.\nHub. ${S.PAYMENT_CONTACT}`, { ...S.KB_LANDING }); } catch (_) {}
    });

    // User list inline
    tgBot.action(/^userinfo_(\d+)$/, async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Hanya admin!');
        await ctx.answerCbQuery();
        const userId = parseInt(ctx.match[1]);
        const user   = S.db.getUser(userId);
        if (!user) return ctx.editMessageText('❌ User tidak ditemukan.');
        const exp = user.role === 'regular' ? S.formatDate(user.expiresAt) : user.role === 'trial' ? S.formatDate(user.trialExpiresAt) : '-';
        await ctx.editMessageText(`👤 DETAIL USER\n${'─'.repeat(20)}\n🆔 ${userId}\n📋 ${user.role}\n📅 Exp: ${exp}`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('🔴 Revoke', `revoke_${userId}`)], [Markup.button.callback('↩️ Kembali', 'back_userlist')]]),
        });
    });
    tgBot.action(/^revoke_(\d+)$/, async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Hanya admin!');
        await ctx.answerCbQuery('🔴 Revoking...');
        const userId = parseInt(ctx.match[1]);
        if (!S.db.getUser(userId)) return ctx.editMessageText('❌ User tidak ditemukan.');
        S.db.deleteUser(userId);
        if (S.userSessions.has(userId)) { try { await destroySession(userId); } catch (_) {} }
        S.kickSelections.delete(userId); S.reconnectAttempts.delete(userId); S.conflictCooldowns.delete(userId); S.loginLocks.delete(userId);
        await ctx.editMessageText(`✅ Akses user ${userId} dicabut.`);
        try { await tgBot.telegram.sendMessage(userId, `🔴 Akses dicabut.\nHub. admin: ${S.PAYMENT_CONTACT}`); } catch (_) {}
    });
    tgBot.action('back_userlist', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return;
        const users = S.db.getAllUsers();
        if (!users.length) return ctx.editMessageText('👥 Belum ada user.');
        const buttons = users.slice(0, 30).map(u => [Markup.button.callback(
            `${u.role === 'regular' ? '⭐' : u.role === 'trial' ? '🎁' : '❓'} ${u.id} (${u.role})`, `userinfo_${u.id}`
        )]);
        buttons.push([Markup.button.callback('❌ Tutup', 'close_userlist')]);
        await ctx.editMessageText(`👥 DAFTAR USER (${users.length})`, { reply_markup: { inline_keyboard: buttons } });
    });
    tgBot.action('close_userlist', async ctx => { try { await ctx.deleteMessage(); } catch (_) {} });

    // Auto expiry check
    setInterval(async () => {
        const users = S.db.getAllUsers();
        const now   = new Date();
        for (const u of users) {
            if (u.notifiedExpiry) continue;
            const exp = u.role === 'regular' ? u.expiresAt : u.role === 'trial' ? u.trialExpiresAt : null;
            if (!exp) continue;
            const msLeft = new Date(exp) - now;
            if (msLeft > 0 && msLeft < 24 * 3600000) {
                try {
                    await tgBot.telegram.sendMessage(u.id, `⚠️ Akses ${u.role} kamu akan berakhir dalam ${S.formatCountdown(exp)}!\n\nKetik /beli untuk perpanjang.`);
                    S.db.updateNotifiedFlag(u.id);
                } catch (_) {}
            }
        }
    }, 60 * 60 * 1000);
}

module.exports = { register };
