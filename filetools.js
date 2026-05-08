// ============================================================
//  filetools.js — Fitur File Tools (dari bot_merged v7.0.0)
//  TXT↔VCF, XLSX→VCF, Gabung, Pecah, Tambah/Hapus Kontak,
//  Rename, Hitung, Pesan→TXT, Admin File Manager
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');
const { Markup } = require('telegraf');
const S = require('./shared');

let XLSX = null;
try { XLSX = require('xlsx'); console.log('✅ xlsx loaded'); }
catch { console.log('⚠️  xlsx tidak terinstall. XLSX → VCF tidak tersedia.'); }

// ========== NAMING HELPER ==========
async function askNamingMode(ctx, userId, stateUpdate) {
    S.setState(userId, { ...S.getState(userId), ...stateUpdate });
    await S.safeReply(ctx, `📝 *Pilih mode penamaan output:*\n\n📂 *Default* — nama dari file asli\n✏️ *Custom* — kamu tentukan sendiri`, {
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📂 Default (nama dari file)', `naming_default_${userId}`)],
            [Markup.button.callback('✏️ Custom (nama manual)',     `naming_custom_${userId}`)],
        ]),
    });
}

async function dispatchNaming(ctx, userId, state, customName) {
    switch (state.pendingFinalize) {
        case 'cv_txt_to_vcf':   return executeCvTxtToVcf(ctx, userId, state, customName);
        case 'cv_vcf_to_txt':   return executeCvVcfToTxt(ctx, userId, state, customName);
        case 'cv_xlsx_to_vcf':  return executeCvXlsxToVcf(ctx, userId, state, customName);
        case 'txt2vcf':         return executeTxt2Vcf(ctx, userId, state, customName);
        case 'gabungtxt':       return executeGabungTxt(ctx, userId, state, customName);
        case 'gabungvcf':       return executeGabungVcf(ctx, userId, state, customName);
        case 'pecahfile_parts': {
            const perFile = Math.ceil(state.contacts.length / state.partsCount);
            return executePecahCtc(ctx, userId, state, perFile, customName);
        }
        case 'pecahctc_naming': return executePecahCtc(ctx, userId, state, state.countPerFile, customName);
        default:
            S.clearState(userId);
            await S.safeReply(ctx, '❌ Unknown operation. State dihapus.');
    }
}

// ========== 1. TXT → VCF ==========
async function handleCvTxtToVcfStart(ctx, userId) {
    S.setState(userId, { mode: 'cv_txt_to_vcf', files: [], fileNames: [], collecting: true });
    await S.safeReply(ctx, `📥 *Mengumpulkan file TXT...*\n\nKirimkan file .txt, lalu tekan /done untuk lanjutkan.`);
}
async function handleCvTxtToVcfFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.txt';
    if (!fname.toLowerCase().endsWith('.txt')) return S.safeReply(ctx, '⚠️ Hanya file .txt yang diterima.');
    if (state.files.length >= S.MAX_FILES_PER_BATCH) return S.safeReply(ctx, `❌ Maks ${S.MAX_FILES_PER_BATCH} file per batch.`);
    try {
        const buf = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        state.files.push({ name: fname, content: buf.toString('utf-8') });
        state.fileNames.push(fname);
        S.setState(userId, state);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
}
async function finalizeCvTxtToVcf(ctx, userId, state) {
    if (!state.files.length) { S.clearState(userId); return S.safeReply(ctx, '❌ Tidak ada file.'); }
    await askNamingMode(ctx, userId, { phase: 'naming', pendingFinalize: 'cv_txt_to_vcf' });
}
async function executeCvTxtToVcf(ctx, userId, state, customName = null) {
    try {
        await S.safeReply(ctx, `📥 *${state.files.length} file diterima*\n\n${state.fileNames.map((f,i) => `${i+1}. ${f}`).join('\n')}\n\n⏳ Memproses...`);
        const results = [];
        for (let i = 0; i < state.files.length; i++) {
            const file     = state.files[i];
            const contacts = S.parseTxtLines(file.content);
            const outName  = customName ? (state.files.length === 1 ? customName : `${customName}_${i+1}`) : file.name.replace(/\.txt$/i, '');
            await S.sendFile(ctx, Buffer.from(S.generateVCF(contacts), 'utf-8'), `${outName}.vcf`, `✅ ${file.name} → ${outName}.vcf (${contacts.length} kontak)`);
            results.push(`✅ ${file.name} → ${outName}.vcf (${contacts.length} kontak)`);
        }
        await S.safeReply(ctx, `📦 *HASIL*\n\n${results.join('\n')}\n\n📊 Total: ${state.files.length} file`);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
    finally { S.clearState(userId); }
}

// ========== 2. VCF → TXT ==========
async function handleCvVcfToTxtStart(ctx, userId) {
    S.setState(userId, { mode: 'cv_vcf_to_txt', files: [], fileNames: [], collecting: true });
    await S.safeReply(ctx, `📥 *Mengumpulkan file VCF...*\n\nKirimkan file .vcf, lalu tekan /done untuk lanjutkan.`);
}
async function handleCvVcfToTxtFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return S.safeReply(ctx, '⚠️ Hanya file .vcf yang diterima.');
    if (state.files.length >= S.MAX_FILES_PER_BATCH) return S.safeReply(ctx, `❌ Maks ${S.MAX_FILES_PER_BATCH} file per batch.`);
    try {
        const buf = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        state.files.push({ name: fname, content: buf.toString('utf-8') });
        state.fileNames.push(fname);
        S.setState(userId, state);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
}
async function finalizeCvVcfToTxt(ctx, userId, state) {
    if (!state.files.length) { S.clearState(userId); return S.safeReply(ctx, '❌ Tidak ada file.'); }
    await askNamingMode(ctx, userId, { phase: 'naming', pendingFinalize: 'cv_vcf_to_txt' });
}
async function executeCvVcfToTxt(ctx, userId, state, customName = null) {
    try {
        await S.safeReply(ctx, `📥 *${state.files.length} file diterima*\n\n${state.fileNames.map((f,i) => `${i+1}. ${f}`).join('\n')}\n\n⏳ Memproses...`);
        const results = [];
        for (let i = 0; i < state.files.length; i++) {
            const file     = state.files[i];
            const contacts = S.parseVCF(file.content);
            const outName  = customName ? (state.files.length === 1 ? customName : `${customName}_${i+1}`) : file.name.replace(/\.vcf$/i, '');
            await S.sendFile(ctx, Buffer.from(contacts.map(c => c.phone).join('\n'), 'utf-8'), `${outName}.txt`, `✅ ${file.name} → ${outName}.txt (${contacts.length} nomor)`);
            results.push(`✅ ${file.name} → ${outName}.txt (${contacts.length} nomor)`);
        }
        await S.safeReply(ctx, `📦 *HASIL*\n\n${results.join('\n')}\n\n📊 Total: ${state.files.length} file`);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
    finally { S.clearState(userId); }
}

// ========== 3. XLSX → VCF ==========
async function handleCvXlsxToVcfStart(ctx, userId) {
    if (!XLSX) return S.safeReply(ctx, '❌ Fitur ini memerlukan package xlsx.\nAdmin: `npm install xlsx`');
    S.setState(userId, { mode: 'cv_xlsx_to_vcf', waiting: true });
    await S.safeReply(ctx, `📊 *XLSX → VCF*\n\nKirim file .xlsx.\nSemua cell akan dipindai untuk nomor telepon.\n\nKetik /batal untuk batal.`);
}
async function handleCvXlsxToVcfFile(ctx, userId, state, doc) {
    if (!XLSX) return S.safeReply(ctx, '❌ Package xlsx tidak terinstall.');
    const fname = doc.file_name || 'file.xlsx';
    if (!fname.toLowerCase().endsWith('.xlsx')) return S.safeReply(ctx, '⚠️ Hanya file .xlsx.');
    try {
        const buf = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        const wb  = XLSX.read(buf, { type: 'buffer' });
        let allNums = [], totalCells = 0;
        for (const sn of wb.SheetNames) {
            const data = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
            for (const row of data) {
                if (!row) continue;
                for (const cell of row) {
                    totalCells++;
                    if (cell != null && S.isPhoneNumber(String(cell))) {
                        const norm = S.normalizePhone(String(cell));
                        if (norm) allNums.push(norm);
                    }
                }
            }
        }
        const seen = new Set(); const unique = []; let dupCount = 0;
        for (const n of allNums) { if (seen.has(n)) { dupCount++; continue; } seen.add(n); unique.push(n); }
        S.setState(userId, { ...state, phase: 'naming', pendingFinalize: 'cv_xlsx_to_vcf', xlsxData: { uniqueNumbers: unique, totalCells, dupCount, allCount: allNums.length }, origFileName: fname, waiting: false });
        await S.safeReply(ctx,
            `📊 *Scan selesai!*\n\n📋 File: ${fname}\n🔢 Cell: ${totalCells}\n📞 Nomor: ${allNums.length}\n🚫 Duplikat: ${dupCount}\n✅ Unik: ${unique.length}\n\n📝 *Pilih mode penamaan:*`,
            { ...Markup.inlineKeyboard([[Markup.button.callback('📂 Default', `naming_default_${userId}`)], [Markup.button.callback('✏️ Custom', `naming_custom_${userId}`)]]) }
        );
    } catch (err) { S.log('ERROR', 'CvXlsxToVcf', err.message, err); await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}
async function executeCvXlsxToVcf(ctx, userId, state, customName = null) {
    try {
        const { uniqueNumbers, totalCells, dupCount, allCount } = state.xlsxData;
        const outName  = customName || state.origFileName.replace(/\.xlsx$/i, '');
        const contacts = uniqueNumbers.map(n => ({ name: `Kontak ${n}`, phone: n }));
        await S.sendFile(ctx, Buffer.from(S.generateVCF(contacts), 'utf-8'), `${outName}.vcf`,
            `📊 HASIL XLSX → VCF\n${'─'.repeat(28)}\n📋 File: ${state.origFileName}\n🔢 Cell: ${totalCells}\n📞 Ditemukan: ${allCount}\n🚫 Duplikat: ${dupCount}\n✅ Unik: ${uniqueNumbers.length}`
        );
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
    finally { S.clearState(userId); }
}

// ========== 4. TXT2VCF Auto ==========
async function handleTxt2VcfStart(ctx, userId) {
    S.setState(userId, { mode: 'txt2vcf', waiting: true });
    await S.safeReply(ctx, `📝 *TXT2VCF Auto-Detect*\n\nKirim file .txt.\n\nFormat yang didukung:\n• \`08123 Nama\`\n• \`Nama,08123\`\n• \`Nama|08123\`\n• \`081234567890\`\n\nKetik /batal untuk batal.`);
}
async function handleTxt2VcfFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.txt';
    if (!fname.toLowerCase().endsWith('.txt')) return S.safeReply(ctx, '⚠️ Hanya file .txt.');
    try {
        const buf      = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        const contacts = S.parseTxtLines(buf.toString('utf-8'));
        if (!contacts.length) return S.safeReply(ctx, '❌ Tidak ada nomor valid.');
        S.setState(userId, { ...state, phase: 'naming', pendingFinalize: 'txt2vcf', contacts, origFileName: fname, waiting: false });
        await S.safeReply(ctx, `📝 *${fname}* — ${contacts.length} kontak ditemukan.\n\n📝 *Pilih mode penamaan:*`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('📂 Default', `naming_default_${userId}`)], [Markup.button.callback('✏️ Custom', `naming_custom_${userId}`)]]),
        });
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}
async function executeTxt2Vcf(ctx, userId, state, customName = null) {
    try {
        const outName = customName || state.origFileName.replace(/\.txt$/i, '');
        await S.sendFile(ctx, Buffer.from(S.generateVCF(state.contacts), 'utf-8'), `${outName}.vcf`, `✅ ${state.origFileName} → ${outName}.vcf\n👤 ${state.contacts.length} kontak`);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
    finally { S.clearState(userId); }
}

// ========== 5. Gabung TXT ==========
async function handleGabungTxtStart(ctx, userId) {
    S.setState(userId, { mode: 'gabungtxt', files: [], fileNames: [], collecting: true });
    await S.safeReply(ctx, `📥 *Mengumpulkan file TXT...*\n\nKirimkan file .txt, lalu tekan /done.`);
}
async function handleGabungTxtFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.txt';
    if (!fname.toLowerCase().endsWith('.txt')) return S.safeReply(ctx, '⚠️ Hanya file .txt.');
    if (state.files.length >= S.MAX_FILES_PER_BATCH) return S.safeReply(ctx, `❌ Maks ${S.MAX_FILES_PER_BATCH} file.`);
    try {
        const buf = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        state.files.push({ name: fname, content: buf.toString('utf-8') });
        state.fileNames.push(fname);
        S.setState(userId, state);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
}
async function finalizeGabungTxt(ctx, userId, state) {
    if (state.files.length < 2) { S.clearState(userId); return S.safeReply(ctx, '❌ Minimal 2 file untuk digabung.'); }
    await askNamingMode(ctx, userId, { phase: 'naming', pendingFinalize: 'gabungtxt' });
}
async function executeGabungTxt(ctx, userId, state, customName = null) {
    try {
        await S.safeReply(ctx, `📥 *${state.files.length} file diterima*\n\n${state.fileNames.map((f,i) => `${i+1}. ${f}`).join('\n')}\n\n⏳ Memproses...`);
        const allLines = []; let totalLines = 0;
        for (const file of state.files) {
            const lines = file.content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            totalLines += lines.length; allLines.push(...lines);
        }
        const seen = new Set(); const merged = []; let dupCount = 0;
        for (const line of allLines) {
            const key = S.normalizePhone(line) || line.toLowerCase();
            if (!key || seen.has(key)) { dupCount++; continue; }
            seen.add(key); merged.push(line);
        }
        const outName = customName || 'gabungan';
        await S.sendFile(ctx, Buffer.from(merged.join('\n'), 'utf-8'), `${outName}.txt`,
            `📄 HASIL GABUNG TXT\n${'─'.repeat(28)}\n📁 ${state.files.length} file\n📝 Total: ${totalLines}\n🚫 Duplikat: ${dupCount}\n✅ Unik: ${merged.length}`
        );
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
    finally { S.clearState(userId); }
}

// ========== 6. Gabung VCF ==========
async function handleGabungVcfStart(ctx, userId) {
    S.setState(userId, { mode: 'gabungvcf', files: [], fileNames: [], collecting: true });
    await S.safeReply(ctx, `📥 *Mengumpulkan file VCF...*\n\nKirimkan file .vcf, lalu tekan /done.`);
}
async function handleGabungVcfFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return S.safeReply(ctx, '⚠️ Hanya file .vcf.');
    if (state.files.length >= S.MAX_FILES_PER_BATCH) return S.safeReply(ctx, `❌ Maks ${S.MAX_FILES_PER_BATCH} file.`);
    try {
        const buf = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        state.files.push({ name: fname, content: buf.toString('utf-8') });
        state.fileNames.push(fname);
        S.setState(userId, state);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
}
async function finalizeGabungVcf(ctx, userId, state) {
    if (state.files.length < 2) { S.clearState(userId); return S.safeReply(ctx, '❌ Minimal 2 file.'); }
    await askNamingMode(ctx, userId, { phase: 'naming', pendingFinalize: 'gabungvcf' });
}
async function executeGabungVcf(ctx, userId, state, customName = null) {
    try {
        await S.safeReply(ctx, `📥 *${state.files.length} file diterima*\n\n${state.fileNames.map((f,i) => `${i+1}. ${f}`).join('\n')}\n\n⏳ Memproses...`);
        const allContacts = []; const seen = new Set(); let total = 0, dupCount = 0;
        for (const file of state.files) {
            const cs = S.parseVCF(file.content); total += cs.length;
            for (const c of cs) { if (seen.has(c.phone)) { dupCount++; continue; } seen.add(c.phone); allContacts.push(c); }
        }
        const outName = customName || 'gabungan';
        await S.sendFile(ctx, Buffer.from(S.generateVCF(allContacts), 'utf-8'), `${outName}.vcf`,
            `📄 HASIL GABUNG VCF\n${'─'.repeat(28)}\n📁 ${state.files.length} file\n📝 Total: ${total}\n🚫 Duplikat: ${dupCount}\n✅ Unik: ${allContacts.length}`
        );
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
    finally { S.clearState(userId); }
}

// ========== 7. Pecah VCF (bagian) ==========
async function handlePecahFileStart(ctx, userId) {
    S.setState(userId, { mode: 'pecahfile', waiting: true });
    await S.safeReply(ctx, `✂️ *PECAH VCF (BAGIAN)*\n\nKirim file .vcf yang ingin dipecah.\n\nKetik /batal untuk batal.`);
}
async function handlePecahFileVcf(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return S.safeReply(ctx, '⚠️ Hanya file .vcf.');
    try {
        const buf      = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        const contacts = S.parseVCF(buf.toString('utf-8'));
        if (contacts.length < 2) return S.safeReply(ctx, '❌ Minimal 2 kontak.');
        S.setState(userId, { mode: 'pecahfile', phase: 'choose_parts', contacts, baseName: fname.replace(/\.vcf$/i, '') });
        await S.safeReply(ctx, `📋 *${fname}* — ${contacts.length} kontak\n\n✏️ *Ketik jumlah bagian:*\nContoh: \`4\`\n\nKetik /batal untuk batal.`);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}

// ========== 8. Pecah VCF (per jumlah kontak) ==========
async function handlePecahCtcStart(ctx, userId) {
    S.setState(userId, { mode: 'pecahctc', phase: 'waiting_file_request' });
    await S.safeReply(ctx, `✂️ *PECAH VCF (PER JUMLAH KONTAK)*\n\nKirim file .vcf yang ingin dipecah.\n\nKetik /batal untuk batal.`);
}
async function handlePecahCtcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return S.safeReply(ctx, '⚠️ Hanya file .vcf.');
    try {
        const buf      = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        const contacts = S.parseVCF(buf.toString('utf-8'));
        if (!contacts.length) return S.safeReply(ctx, '❌ Tidak ada kontak valid.');
        S.setState(userId, { mode: 'pecahctc', phase: 'waiting_count', contacts, baseName: fname.replace(/\.vcf$/i, ''), origFileName: fname });
        await S.safeReply(ctx, `📋 *${fname}* — ${contacts.length} kontak\n\n✏️ *Ketik jumlah kontak per file:*\nContoh: \`100\`\n\nKetik /batal untuk batal.`);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}
async function executePecahCtc(ctx, userId, state, countPerFile, customName = null) {
    try {
        const contacts   = state.contacts;
        const baseName   = customName || state.baseName;
        const totalParts = Math.ceil(contacts.length / countPerFile);
        await S.safeReply(ctx, `📋 Total: ${contacts.length}\n📏 Per file: ${countPerFile}\n📁 Bagian: ${totalParts}\n\n⏳ Memproses...`);
        for (let i = 0; i < totalParts; i++) {
            const part = contacts.slice(i * countPerFile, (i + 1) * countPerFile);
            await S.sendFile(ctx, Buffer.from(S.generateVCF(part), 'utf-8'), `${baseName}_${String(i+1).padStart(3,'0')}.vcf`, `📄 Bagian ${i+1}/${totalParts}: ${part.length} kontak`);
        }
        await S.safeReply(ctx, `✅ Dipecah menjadi ${totalParts} bagian\n📋 Total: ${contacts.length}\n📏 Per file: ${countPerFile}`);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
    finally { S.clearState(userId); }
}

// ========== 9. Tambah Kontak ==========
async function handleAddCtcStart(ctx, userId) {
    S.setState(userId, { mode: 'addctc', phase: 'waiting_vcf' });
    await S.safeReply(ctx, `➕ *TAMBAH KONTAK VCF*\n\nKirim file .vcf yang ingin ditambahi kontak.\n\nKetik /batal untuk batal.`);
}
async function handleAddCtcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return S.safeReply(ctx, '⚠️ Hanya file .vcf.');
    try {
        const buf      = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        const contacts = S.parseVCF(buf.toString('utf-8'));
        if (!contacts.length) return S.safeReply(ctx, '❌ Tidak ada kontak valid.');
        S.setState(userId, { mode: 'addctc', phase: 'waiting_contacts', existingContacts: contacts, fileName: fname });
        await S.safeReply(ctx, `📋 *${fname}* — ${contacts.length} kontak\n\n${'─'.repeat(28)}\nKirim kontak tambahan (satu per baris):\n\nContoh:\nNama|081234567890\n081987654321\n\n/done untuk simpan, /batal untuk batal.`);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}

// ========== 10. Hapus Kontak ==========
async function handleDelCtcStart(ctx, userId) {
    S.setState(userId, { mode: 'delctc', phase: 'waiting_vcf' });
    await S.safeReply(ctx, `➖ *HAPUS KONTAK VCF*\n\nKirim file .vcf.\n\nKetik /batal untuk batal.`);
}
async function handleDelCtcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return S.safeReply(ctx, '⚠️ Hanya file .vcf.');
    try {
        const buf      = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        const contacts = S.parseVCF(buf.toString('utf-8'));
        if (!contacts.length) return S.safeReply(ctx, '❌ Tidak ada kontak valid.');
        const maxShow = Math.min(30, contacts.length);
        let preview = `📋 *DAFTAR KONTAK*\n${'─'.repeat(28)}\n📇 *${fname}*\n👤 Total: ${contacts.length}\n\n`;
        for (let i = 0; i < maxShow; i++) preview += `${i+1}. ${contacts[i].name} → ${contacts[i].phone}\n`;
        if (contacts.length > 30) preview += `\n... dan ${contacts.length - 30} lainnya`;
        preview += `\n${'─'.repeat(28)}\nKetik nomor urut yang dihapus:\nFormat: \`1,3,5-8,10\`\n\n/batal untuk batal.`;
        S.setState(userId, { mode: 'delctc', phase: 'waiting_input', contacts, fileName: fname });
        await S.safeReply(ctx, preview);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}

// ========== 11. Hitung Kontak ==========
async function handleHitungCtcStart(ctx, userId) {
    S.setState(userId, { mode: 'hitungctc', waiting: true });
    await S.safeReply(ctx, `🔢 *HITUNG KONTAK VCF*\n\nKirim file .vcf.\n\nKetik /batal untuk batal.`);
}
async function handleHitungCtcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return S.safeReply(ctx, '⚠️ Hanya file .vcf.');
    try {
        const buf      = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        const contacts = S.parseVCF(buf.toString('utf-8'));
        const seen = new Set(); let withName = 0, noName = 0, dup = 0;
        for (const c of contacts) {
            if (c.name && c.name !== 'Tanpa Nama') withName++; else noName++;
            if (seen.has(c.phone)) dup++; else seen.add(c.phone);
        }
        await S.safeReply(ctx, `🔢 *HASIL HITUNG*\n${'─'.repeat(28)}\n📇 File: ${fname}\n👤 Total: ${contacts.length}\n✅ Punya nama: ${withName}\n❓ Tanpa nama: ${noName}\n📞 Nomor unik: ${seen.size}\n🚫 Duplikat: ${dup}`);
        S.clearState(userId);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}

// ========== 12. Rename Kontak ==========
async function handleRenamectcStart(ctx, userId) {
    S.setState(userId, { mode: 'renamectc', phase: 'waiting_vcf' });
    await S.safeReply(ctx, `✏️ *RENAME KONTAK VCF*\n\nKirim file .vcf.\n\nKetik /batal untuk batal.`);
}
async function handleRenamectcFile(ctx, userId, state, doc) {
    const fname = doc.file_name || 'file.vcf';
    if (!fname.toLowerCase().endsWith('.vcf')) return S.safeReply(ctx, '⚠️ Hanya file .vcf.');
    try {
        const buf      = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        const contacts = S.parseVCF(buf.toString('utf-8'));
        if (!contacts.length) return S.safeReply(ctx, '❌ Tidak ada kontak valid.');
        let preview = `📋 *PREVIEW*\n${'─'.repeat(28)}\n📇 *${fname}* — ${contacts.length} kontak\n\n`;
        contacts.slice(0, 5).forEach((c, i) => { preview += `${i+1}. ${c.name} → ${c.phone}\n`; });
        if (contacts.length > 5) preview += `... dan ${contacts.length - 5} lainnya`;
        preview += `\n${'─'.repeat(28)}\nPilih metode:`;
        S.setState(userId, { mode: 'renamectc', phase: 'choose_method', contacts, fileName: fname });
        await S.safeReply(ctx, preview, {
            ...Markup.inlineKeyboard([
                [Markup.button.callback('➕ Tambah Prefix',     'rename_prefix')],
                [Markup.button.callback('➕ Tambah Suffix',     'rename_suffix')],
                [Markup.button.callback('🔢 Ganti + Nomor Urut','rename_numbered')],
                [Markup.button.callback('❌ Batal',             'rename_cancel')],
            ]),
        });
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}

// ========== 13. Rename File ==========
async function handleRenameFileStart(ctx, userId, newName) {
    if (!newName?.trim()) return S.safeReply(ctx, 'Format: /renamefile [nama_baru]\nContoh: /renamefile arisan_baru');
    if (/[\/\\:*?"<>|]/.test(newName))    return S.safeReply(ctx, '❌ Nama tidak boleh mengandung: / \\ : * ? " < > |');
    if (newName.length > 100)              return S.safeReply(ctx, '❌ Nama maks 100 karakter.');
    S.setState(userId, { mode: 'renamefile', newName: newName.trim(), waiting: true });
    await S.safeReply(ctx, `✏️ *RENAME FILE*\n\nNama baru: *${newName.trim()}*\n(ekstensi dipertahankan)\n\nKirim file sekarang.\nKetik /batal untuk batal.`);
}
async function handleRenameFile(ctx, userId, state, doc) {
    const fname      = doc.file_name || 'file';
    const ext        = path.extname(fname) || '';
    const newName    = `${state.newName}${ext}`;
    try {
        const buf = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        await S.sendFile(ctx, buf, S.safeFilename(newName), `✅ ${fname} → ${newName}`);
        S.clearState(userId);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}

// ========== 14. Pesan ke TXT ==========
async function handleTotxtStart(ctx, userId) {
    S.setState(userId, { mode: 'totxt', messages: [], active: true });
    await S.safeReply(ctx, `📄 *PESAN KE TXT*\n\nMode aktif. Setiap pesan teks yang kamu kirim akan disimpan.\n\n/done → generate file TXT (maks 500 pesan)\n/batal → batalkan`);
}

// ========== 15. Rekap Grup ==========
async function handleRekapGroup(ctx, userId) {
    S.setState(userId, { mode: 'rekapgroup', phase: 'waiting_photo' });
    await S.safeReply(ctx, `📸 *Rekap Grup*\n\nKirim foto screenshot info grup WA.\nAtau kirim foto dengan caption:\n\`NamaGrup|JumlahMember\`\n\nKetik /batal untuk batal.`);
}

// ========== 16. Admin File Manager ==========
async function handleCvAdminFile(ctx, userId) {
    if (!S.isAdmin(userId)) return S.safeReply(ctx, '⛔ Hanya admin.');
    await S.safeReply(ctx, `📁 *ADMIN FILE MANAGER*\n\nPilih aksi:`, {
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📤 Upload File',    'adminfile_upload')],
            [Markup.button.callback('📂 Lihat File',     'adminfile_list')],
            [Markup.button.callback('🗑️ Hapus File',    'adminfile_delete')],
            [Markup.button.callback('📥 Download File',  'adminfile_download')],
        ]),
    });
}

// ========== REGISTER HANDLERS ==========
function register(tgBot) {

    // ===== NAMING INLINE HANDLERS =====
    tgBot.action(/^naming_default_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('✅ Menggunakan nama default');
        const userId = parseInt(ctx.match[1]);
        if (ctx.from.id !== userId) return ctx.answerCbQuery('⛔ Bukan milikmu.');
        const state = S.getState(userId);
        if (!state) return ctx.editMessageText('❌ Session expired. Ulangi proses.');
        await ctx.editMessageText('✅ Menggunakan nama default...');
        await dispatchNaming(ctx, userId, state, null);
    });
    tgBot.action(/^naming_custom_(\d+)$/, async ctx => {
        await ctx.answerCbQuery('✏️ Masukkan nama custom');
        const userId = parseInt(ctx.match[1]);
        if (ctx.from.id !== userId) return ctx.answerCbQuery('⛔ Bukan milikmu.');
        const state = S.getState(userId);
        if (!state) return ctx.editMessageText('❌ Session expired. Ulangi proses.');
        S.setState(userId, { ...state, phase: 'waiting_custom_name' });
        await ctx.editMessageText('✏️ Ketik nama output:\n\n_Contoh: kontak_baru_ (tanpa ekstensi)\n\nKetik /batal untuk batal.');
    });

    // ===== MIDDLEWARE TEXT STATES =====
    tgBot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId || !ctx.message?.text) return next();
        const state = S.getState(userId);
        if (!state || state.mode === 'buatgrup') return next(); // buatgrup ditangani wa.js

        const text = ctx.message.text;
        if (text.startsWith('/')) return next();

        // Custom name input
        if (state.phase === 'waiting_custom_name') {
            const customName = text.trim().replace(/[\/\\:*?"<>|]/g, '_').substring(0, 100);
            if (!customName) return S.safeReply(ctx, '❌ Nama tidak valid.');
            await S.safeReply(ctx, `✅ Nama: *${customName}*\n\n⏳ Memproses...`);
            await dispatchNaming(ctx, userId, state, customName);
            return;
        }
        // Pecah VCF: pilih jumlah bagian
        if (state.mode === 'pecahfile' && state.phase === 'choose_parts') {
            const parts = parseInt(text.trim());
            if (isNaN(parts) || parts < 2) return S.safeReply(ctx, '❌ Masukkan angka minimal 2. Contoh: `4`');
            if (parts > state.contacts.length) return S.safeReply(ctx, `❌ Jumlah bagian (${parts}) melebihi kontak (${state.contacts.length}).`);
            S.setState(userId, { ...state, phase: 'naming', pendingFinalize: 'pecahfile_parts', partsCount: parts });
            await S.safeReply(ctx, `📊 *${state.contacts.length} kontak* → *${parts} bagian*\n\n📝 *Pilih mode penamaan:*`, {
                ...Markup.inlineKeyboard([[Markup.button.callback('📂 Default', `naming_default_${userId}`)], [Markup.button.callback('✏️ Custom', `naming_custom_${userId}`)]]),
            });
            return;
        }
        // Pecah VCF: pilih jumlah per file
        if (state.mode === 'pecahctc' && state.phase === 'waiting_count') {
            const count = parseInt(text.trim());
            if (isNaN(count) || count < 1) return S.safeReply(ctx, '❌ Masukkan angka minimal 1.');
            S.setState(userId, { ...state, phase: 'naming', pendingFinalize: 'pecahctc_naming', countPerFile: count });
            await S.safeReply(ctx, `📊 *${state.contacts.length} kontak* → *${count}/file* = *${Math.ceil(state.contacts.length/count)} bagian*\n\n📝 *Pilih mode penamaan:*`, {
                ...Markup.inlineKeyboard([[Markup.button.callback('📂 Default', `naming_default_${userId}`)], [Markup.button.callback('✏️ Custom', `naming_custom_${userId}`)]]),
            });
            return;
        }
        // Tambah kontak teks
        if (state.mode === 'addctc' && state.phase === 'waiting_contacts') {
            const seen = new Set(state.existingContacts.map(c => c.phone));
            let added = 0, skipped = 0; const newCtc = [];
            for (const line of text.split(/\r?\n/)) {
                const p = S.autoDetectAndParse(line); if (!p) continue;
                const n = S.normalizePhone(p.phone); if (!n) continue;
                if (seen.has(n)) { skipped++; continue; }
                seen.add(n); newCtc.push({ name: p.name || `Kontak ${n}`, phone: n }); added++;
            }
            if (!newCtc.length) return S.safeReply(ctx, '⚠️ Tidak ada kontak baru valid. Kirim lagi atau /done.');
            const all = [...state.existingContacts, ...newCtc];
            const base = state.fileName.replace(/\.vcf$/i, '');
            await S.sendFile(ctx, Buffer.from(S.generateVCF(all), 'utf-8'), `${base}_updated.vcf`, `✅ ${added} ditambahkan\n👤 Total: ${all.length}\n🚫 ${skipped} duplikat`);
            S.clearState(userId); return;
        }
        // Hapus kontak input range
        if (state.mode === 'delctc' && state.phase === 'waiting_input') {
            try {
                const toDelete = new Set();
                for (const part of text.split(',')) {
                    if (part.includes('-')) {
                        const [s, e] = part.split('-').map(n => parseInt(n.trim()));
                        if (!isNaN(s) && !isNaN(e)) for (let i = Math.max(1,s); i <= Math.min(e, state.contacts.length); i++) toDelete.add(i);
                    } else { const n = parseInt(part.trim()); if (!isNaN(n) && n >= 1 && n <= state.contacts.length) toDelete.add(n); }
                }
                if (!toDelete.size) return S.safeReply(ctx, '❌ Format tidak valid. Contoh: 1,3,5-8,10');
                const newContacts = [...state.contacts];
                Array.from(toDelete).sort((a,b) => b-a).forEach(idx => newContacts.splice(idx-1, 1));
                const base = state.fileName.replace(/\.vcf$/i, '');
                await S.sendFile(ctx, Buffer.from(S.generateVCF(newContacts), 'utf-8'), `${base}_dihapus.vcf`, `✅ ${toDelete.size} kontak dihapus\nSisa: ${newContacts.length}`);
                S.clearState(userId);
            } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
            return;
        }
        // Pesan ke TXT
        if (state.mode === 'totxt' && state.active) {
            if (state.messages.length >= 500) return S.safeReply(ctx, '⚠️ Sudah 500 pesan. Ketik /done untuk generate.');
            state.messages.push(text);
            S.setState(userId, state);
            await S.safeReply(ctx, `✅ Pesan ke-${state.messages.length} disimpan.`);
            return;
        }
        // Rename kontak
        if (state.mode === 'renamectc') {
            const base = state.fileName.replace(/\.vcf$/i, '');
            if (state.phase === 'input_prefix') {
                const renamed = state.contacts.map(c => ({ name: `${text} ${c.name}`, phone: c.phone }));
                await S.sendFile(ctx, Buffer.from(S.generateVCF(renamed), 'utf-8'), `${base}_prefix.vcf`, `✅ Prefix "${text}" ditambahkan ke ${state.contacts.length} kontak`);
                S.clearState(userId); return;
            }
            if (state.phase === 'input_suffix') {
                const renamed = state.contacts.map(c => ({ name: `${c.name} ${text}`, phone: c.phone }));
                await S.sendFile(ctx, Buffer.from(S.generateVCF(renamed), 'utf-8'), `${base}_suffix.vcf`, `✅ Suffix "${text}" ditambahkan ke ${state.contacts.length} kontak`);
                S.clearState(userId); return;
            }
            if (state.phase === 'input_numbered') {
                const renamed = state.contacts.map((c, i) => ({ name: `${text} ${i+1}`, phone: c.phone }));
                await S.sendFile(ctx, Buffer.from(S.generateVCF(renamed), 'utf-8'), `${base}_numbered.vcf`, `✅ ${state.contacts.length} kontak di-rename "${text} 1" s/d "${text} ${state.contacts.length}"`);
                S.clearState(userId); return;
            }
        }
        return next();
    });

    // ===== DOCUMENT HANDLER (File Tools) =====
    tgBot.on('document', async (ctx, next) => {
        const userId = ctx.from.id;
        const state  = S.getState(userId);
        const doc    = ctx.message.document;
        if (!state) return next();

        switch (state.mode) {
            case 'cv_txt_to_vcf':      return handleCvTxtToVcfFile(ctx, userId, state, doc);
            case 'cv_vcf_to_txt':      return handleCvVcfToTxtFile(ctx, userId, state, doc);
            case 'cv_xlsx_to_vcf':     return handleCvXlsxToVcfFile(ctx, userId, state, doc);
            case 'txt2vcf':            return handleTxt2VcfFile(ctx, userId, state, doc);
            case 'gabungtxt':          return handleGabungTxtFile(ctx, userId, state, doc);
            case 'gabungvcf':          return handleGabungVcfFile(ctx, userId, state, doc);
            case 'pecahfile':
                if (state.waiting)     return handlePecahFileVcf(ctx, userId, state, doc);
                break;
            case 'pecahctc':
                if (state.phase === 'waiting_file_request') return handlePecahCtcFile(ctx, userId, state, doc);
                break;
            case 'addctc':             return handleAddCtcFile(ctx, userId, state, doc);
            case 'delctc':             return handleDelCtcFile(ctx, userId, state, doc);
            case 'hitungctc':          return handleHitungCtcFile(ctx, userId, state, doc);
            case 'renamectc':          return handleRenamectcFile(ctx, userId, state, doc);
            case 'renamefile':         return handleRenameFile(ctx, userId, state, doc);
            case 'cvadminfile_upload': return handleAdminFileUploadFile(ctx, userId, state, doc);
            case 'buatgrup': {
                if (state.phase === 'waiting_vcf') {
                    const fname = doc.file_name || '';
                    if (!fname.toLowerCase().endsWith('.vcf')) return S.safeReply(ctx, '⚠️ Hanya file .vcf.');
                    try {
                        const buf      = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
                        const contacts = S.parseVCF(buf.toString('utf-8'));
                        const session  = S.userSessions.get(userId);
                        if (!session?.loggedIn) return S.safeReply(ctx, '❌ Sesi WA tidak aktif.');
                        await S.safeReply(ctx, `⏳ Membuat grup "${state.groupName}" dengan ${contacts.length} kontak...`);
                        const phones    = contacts.map(c => `${c.phone}@s.whatsapp.net`);
                        const groupData = await session.sock.groupCreate(state.groupName, phones);
                        await S.safeReply(ctx, `✅ Grup berhasil dibuat!\n\n📋 ${groupData.subject}\n👥 ${contacts.length} member\n🆔 ${groupData.id}`);
                        S.clearState(userId);
                    } catch (err) { await S.safeReply(ctx, `❌ Gagal: ${err.message}`); S.clearState(userId); }
                }
                return;
            }
            default: return next();
        }
    });

    // ===== PHOTO HANDLER =====
    tgBot.on('photo', async (ctx, next) => {
        const userId = ctx.from.id;
        const state  = S.getState(userId);
        if (!state || state.mode !== 'rekapgroup') return next();
        const caption = ctx.message.caption || '';
        const match   = caption.match(/^(.+?)\|(\d+)$/);
        if (match) {
            S.clearState(userId);
            return S.safeReply(ctx, `📸 REKAP GRUP\n${'─'.repeat(28)}\n📋 Nama: ${match[1].trim()}\n👥 Member: ${match[2]}\n📅 ${S.formatDate(new Date().toISOString())}`);
        }
        await S.safeReply(ctx, `📸 Foto diterima!\n\nBot tidak bisa membaca teks dari gambar.\nKirim ulang dengan caption:\n\`NamaGrup|JumlahMember\``);
    });

    // ===== HEARS FILE TOOLS =====
    tgBot.hears('🔧 File Tools', async ctx => {
        await S.safeReply(ctx, '🔧 *FILE TOOLS MENU*\n\nPilih tool:', { ...S.KB_FILE_TOOLS });
    });
    tgBot.hears('↩️ Kembali', async ctx => {
        const kb = await S.getKeyboard(ctx.from.id);
        await S.safeReply(ctx, '↩️ Kembali ke menu utama.', { ...kb });
    });
    tgBot.hears('🔄 TXT → VCF',       async ctx => handleCvTxtToVcfStart(ctx, ctx.from.id));
    tgBot.hears('🔄 VCF → TXT',       async ctx => handleCvVcfToTxtStart(ctx, ctx.from.id));
    tgBot.hears('📊 XLSX → VCF',      async ctx => handleCvXlsxToVcfStart(ctx, ctx.from.id));
    tgBot.hears('📝 TXT2VCF Auto',    async ctx => handleTxt2VcfStart(ctx, ctx.from.id));
    tgBot.hears('🔗 Gabung TXT',      async ctx => handleGabungTxtStart(ctx, ctx.from.id));
    tgBot.hears('🔗 Gabung VCF',      async ctx => handleGabungVcfStart(ctx, ctx.from.id));
    tgBot.hears('✂️ Pecah VCF',       async ctx => handlePecahFileStart(ctx, ctx.from.id));
    tgBot.hears('✂️ Pecah VCF (jlh)', async ctx => handlePecahCtcStart(ctx, ctx.from.id));
    tgBot.hears('➕ Tambah Kontak',   async ctx => handleAddCtcStart(ctx, ctx.from.id));
    tgBot.hears('➖ Hapus Kontak',    async ctx => handleDelCtcStart(ctx, ctx.from.id));
    tgBot.hears('🔢 Hitung Kontak',   async ctx => handleHitungCtcStart(ctx, ctx.from.id));
    tgBot.hears('✏️ Rename Kontak',   async ctx => handleRenamectcStart(ctx, ctx.from.id));
    tgBot.hears('📸 Rekap Grup',      async ctx => handleRekapGroup(ctx, ctx.from.id));
    tgBot.hears('📄 Pesan ke TXT',    async ctx => handleTotxtStart(ctx, ctx.from.id));
    tgBot.hears('📁 Admin File Manager', async ctx => handleCvAdminFile(ctx, ctx.from.id));
    tgBot.hears('📝 Rename File', async ctx => { await S.safeReply(ctx, 'Format: /renamefile [nama_baru]\nContoh: /renamefile arisan_2024'); });

    // /renamefile command
    tgBot.command('renamefile', async ctx => {
        const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
        await handleRenameFileStart(ctx, ctx.from.id, args);
    });

    // /done & /selesai
    tgBot.command(['done', 'selesai'], async ctx => {
        const userId = ctx.from.id;
        const state  = S.getState(userId);
        if (!state) return S.safeReply(ctx, '❌ Tidak ada proses yang berjalan.');
        switch (state.mode) {
            case 'cv_txt_to_vcf': return finalizeCvTxtToVcf(ctx, userId, state);
            case 'cv_vcf_to_txt': return finalizeCvVcfToTxt(ctx, userId, state);
            case 'gabungtxt':     return finalizeGabungTxt(ctx, userId, state);
            case 'gabungvcf':     return finalizeGabungVcf(ctx, userId, state);
            case 'totxt': {
                if (!state.messages.length) { S.clearState(userId); return S.safeReply(ctx, '❌ Tidak ada pesan.'); }
                await S.sendFile(ctx, Buffer.from(state.messages.join('\n'), 'utf-8'), `pesan_${Date.now()}.txt`, `✅ ${state.messages.length} pesan disimpan`);
                S.clearState(userId); return;
            }
            default: S.clearState(userId); return S.safeReply(ctx, '✅ Proses dihentikan.');
        }
    });

    // /batal — juga handle di sini, wa.js juga punya
    // Tidak double register karena wa.js sudah daftar /batal — cukup satu
    // (index.js urutan register filetools setelah wa, action jadi override)

    // ===== RENAME KONTAK ACTIONS =====
    tgBot.action('rename_prefix', async ctx => {
        await ctx.answerCbQuery();
        const state = S.getState(ctx.from.id);
        if (!state || state.mode !== 'renamectc') return;
        S.setState(ctx.from.id, { ...state, phase: 'input_prefix' });
        await S.safeReply(ctx, '✏️ Masukkan prefix:\n\nContoh: Tim A\nHasil: "Tim A Budi"');
    });
    tgBot.action('rename_suffix', async ctx => {
        await ctx.answerCbQuery();
        const state = S.getState(ctx.from.id);
        if (!state || state.mode !== 'renamectc') return;
        S.setState(ctx.from.id, { ...state, phase: 'input_suffix' });
        await S.safeReply(ctx, '✏️ Masukkan suffix:\n\nContoh: (2025)\nHasil: "Budi (2025)"');
    });
    tgBot.action('rename_numbered', async ctx => {
        await ctx.answerCbQuery();
        const state = S.getState(ctx.from.id);
        if (!state || state.mode !== 'renamectc') return;
        S.setState(ctx.from.id, { ...state, phase: 'input_numbered' });
        await S.safeReply(ctx, '✏️ Masukkan template:\n\nContoh: Member\nHasil: "Member 1", "Member 2"...');
    });
    tgBot.action('rename_cancel', async ctx => { S.clearState(ctx.from.id); await ctx.editMessageText('✖ Dibatalkan.'); });

    // ===== ADMIN FILE MANAGER ACTIONS =====
    tgBot.action('adminfile_upload', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
        await ctx.answerCbQuery();
        S.setState(ctx.from.id, { mode: 'cvadminfile_upload', waiting: true });
        await S.safeReply(ctx, '📤 Kirim file yang ingin diupload.\nKetik /batal untuk batal.');
    });
    tgBot.action('adminfile_list', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
        await ctx.answerCbQuery();
        try {
            const files = fs.readdirSync(S.ADMIN_FILES_DIR);
            if (!files.length) return S.safeReply(ctx, '📂 Kosong.');
            let text = `📂 DAFTAR FILE ADMIN\n${'─'.repeat(28)}\n`;
            files.forEach((f, i) => { const s = fs.statSync(path.join(S.ADMIN_FILES_DIR, f)); text += `${i+1}. ${f} (${(s.size/1024).toFixed(1)}KB)\n`; });
            text += `${'─'.repeat(28)}\nTotal: ${files.length} file`;
            await S.safeReply(ctx, text);
        } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); }
    });
    tgBot.action('adminfile_delete', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
        await ctx.answerCbQuery();
        const files = fs.readdirSync(S.ADMIN_FILES_DIR);
        if (!files.length) return S.safeReply(ctx, '📂 Tidak ada file.');
        const buttons = files.map((f, i) => [Markup.button.callback(`🗑️ ${f.substring(0,30)}`, `adminfiledel_${i}`)]);
        buttons.push([Markup.button.callback('❌ Batal', 'adminfiledel_cancel')]);
        S.setState(ctx.from.id, { mode: 'cvadminfile_delete', fileList: files });
        await S.safeReply(ctx, '🗑️ HAPUS FILE — Pilih file:', { reply_markup: { inline_keyboard: buttons } });
    });
    tgBot.action(/^adminfiledel_(\d+)$/, async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
        const idx   = parseInt(ctx.match[1]);
        const state = S.getState(ctx.from.id);
        if (!state?.fileList) return ctx.editMessageText('❌ Session expired.');
        const fname = state.fileList[idx];
        if (!fname) return ctx.editMessageText('❌ File tidak ditemukan.');
        try { fs.unlinkSync(path.join(S.ADMIN_FILES_DIR, S.safeFilename(fname))); S.clearState(ctx.from.id); await ctx.editMessageText(`✅ Dihapus: ${fname}`); }
        catch (err) { await ctx.editMessageText(`❌ Error: ${err.message}`); }
    });
    tgBot.action('adminfiledel_cancel', async ctx => { S.clearState(ctx.from.id); await ctx.editMessageText('✖ Dibatalkan.'); });
    tgBot.action('adminfile_download', async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
        await ctx.answerCbQuery();
        const files = fs.readdirSync(S.ADMIN_FILES_DIR);
        if (!files.length) return S.safeReply(ctx, '📂 Tidak ada file.');
        const buttons = files.map((f, i) => [Markup.button.callback(`📥 ${f.substring(0,30)}`, `adminfiledl_${i}`)]);
        buttons.push([Markup.button.callback('❌ Batal', 'adminfiledl_cancel')]);
        S.setState(ctx.from.id, { mode: 'cvadminfile_download', fileList: files });
        await S.safeReply(ctx, '📥 DOWNLOAD FILE — Pilih file:', { reply_markup: { inline_keyboard: buttons } });
    });
    tgBot.action(/^adminfiledl_(\d+)$/, async ctx => {
        if (!S.isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
        await ctx.answerCbQuery();
        const idx   = parseInt(ctx.match[1]);
        const state = S.getState(ctx.from.id);
        if (!state?.fileList) return ctx.editMessageText('❌ Session expired.');
        const fname = state.fileList[idx];
        if (!fname) return ctx.editMessageText('❌ File tidak ditemukan.');
        try {
            const buf = fs.readFileSync(path.join(S.ADMIN_FILES_DIR, S.safeFilename(fname)));
            await S.sendFile(ctx, buf, S.safeFilename(fname), `📥 File: ${fname}`);
            S.clearState(ctx.from.id);
        } catch (err) { await ctx.editMessageText(`❌ Error: ${err.message}`); }
    });
    tgBot.action('adminfiledl_cancel', async ctx => { S.clearState(ctx.from.id); await ctx.editMessageText('✖ Dibatalkan.'); });
}

async function handleAdminFileUploadFile(ctx, userId, state, doc) {
    const fname = S.safeFilename(doc.file_name || 'unnamed');
    try {
        const files = fs.readdirSync(S.ADMIN_FILES_DIR);
        if (files.length >= S.MAX_ADMIN_FILES) { S.clearState(userId); return S.safeReply(ctx, `❌ Batas ${S.MAX_ADMIN_FILES} file tercapai.`); }
    } catch (_) {}
    try {
        const buf   = await S.downloadTelegramFile(ctx, doc.file_id, S.bytesToMB(doc.file_size));
        let finalPath = path.join(S.ADMIN_FILES_DIR, fname);
        if (fs.existsSync(finalPath)) {
            const { name, ext } = path.parse(fname);
            finalPath = path.join(S.ADMIN_FILES_DIR, `${name}_${Date.now()}${ext}`);
        }
        fs.writeFileSync(finalPath, buf);
        await S.safeReply(ctx, `✅ File diupload: ${path.basename(finalPath)}`);
        S.clearState(userId);
    } catch (err) { await S.safeReply(ctx, `❌ Error: ${err.message}`); S.clearState(userId); }
}

module.exports = { register };
