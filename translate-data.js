/**
 * translate-data.js
 * Tự động dịch ItemsData_en.json → ItemsData_vn.json & ItemsData_zh.json
 *
 * Cách hoạt động:
 * - Mỗi item trong VN/ZH lưu thêm _enName và _enDesc (nguồn EN tại thời điểm dịch)
 * - Mỗi lần chạy, so sánh EN hiện tại với _enName/_enDesc đã lưu:
 *   + Nếu khác → dịch lại phần thay đổi
 *   + Nếu giống  → giữ nguyên bản dịch cũ
 * - Chạy node translate-data.js --force để dịch lại TOÀN BỘ (khi cần)
 * - Chạy node translate-data.js --watch để theo dõi file EN và tự động dịch khi có thay đổi
 *
 * - Dịch song song (concurrent) để tối ưu tốc độ
 * - Retry tự động khi bị rate limit
 * - Luôn copy Type, CollectionType, Icon, Rare, IsUnique, IconInAB, Category, Tag từ EN
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Config ──────────────────────────────────────
const EN_FILE   = path.join(__dirname, 'ItemsData_en.json');
const VN_FILE   = path.join(__dirname, 'ItemsData_vn.json');
const ZH_FILE   = path.join(__dirname, 'ItemsData_zh.json');

const CONCURRENCY = 16;
const RETRY_MAX   = 4;
const RETRY_BASE  = 400;

const GLOSSARY_EN = {
  vi: {
    'Top': '__TOP__',
    'Bottom': '__BOTTOM__',
    'Shoes': '__SHOES__',
    'Head': '__HEAD__',
    'Facepaint': '__FACEPAINT__',
    'Mask': '__MASK__',
  },
  'zh-TW': {
    'Top': '__TOP__',
    'Bottom': '__BOTTOM__',
    'Shoes': '__SHOES__',
    'Head': '__HEAD__',
    'Facepaint': '__FACEPAINT__',
    'Mask': '__MASK__',
  }
};

const GLOSSARY_TRANSLATIONS = {
  vi: {
    '__TOP__': 'Áo',
    '__BOTTOM__': 'Quần',
    '__SHOES__': 'Giày',
    '__HEAD__': 'Tóc',
    '__FACEPAINT__': 'Vẽ Mặt',
    '__MASK__': 'Mặt Nạ',
  },
  'zh-TW': {
    '__TOP__': '上衣',
    '__BOTTOM__': '裤子',
    '__SHOES__': '鞋子',
    '__HEAD__': '頭髮',
    '__FACEPAINT__': '面部彩繪',
    '__MASK__': '面具',
  }
};
// ────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function applyGlossary(text, lang) {
  const glossary = GLOSSARY_EN[lang];
  if (!glossary) return text;
  let result = text;
  for (const [en, placeholder] of Object.entries(glossary)) {
    const regex = new RegExp('\\b' + en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
    result = result.replace(regex, placeholder);
  }
  return result;
}

function restoreGlossary(text, lang) {
  const translations = GLOSSARY_TRANSLATIONS[lang];
  if (!translations) return text;
  let result = text;
  for (const [placeholder, translation] of Object.entries(translations)) {
    result = result.split(placeholder).join(translation);
  }
  return result;
}

// ── Google Translate (unofficial, miễn phí) ─────
function translateText(text, targetLang) {
  return new Promise((resolve, reject) => {
    if (!text || !text.trim()) { resolve(''); return; }

    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${
      encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;

    const req = https.get(url, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          let out = '';
          if (parsed?.[0]) for (const seg of parsed[0]) if (seg?.[0]) out += seg[0];
          resolve(out || text);
        } catch { reject(new Error('parse_error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function translate(text, lang) {
  for (let i = 0; i < RETRY_MAX; i++) {
    try {
      return await translateText(text, lang);
    } catch (e) {
      if (i < RETRY_MAX - 1) await sleep(RETRY_BASE * Math.pow(2, i));
    }
  }
  return text;
}

// ── Chạy N tác vụ song song với giới hạn concurrency ──
async function pool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Xử lý một ngôn ngữ ──────────────────────────
async function processLanguage(enData, existingData, targetLang, outputFile, label, force = false) {
  console.log(`\n🌐 ${label} (${targetLang})`);

  const existingMap = new Map(existingData.map(i => [i.Id, i]));

  // Phát hiện file cũ chưa có _enName/_enDesc
  const hasSourceTracking = existingData.some(item => '_enName' in item);
  if (!hasSourceTracking && existingData.length > 0 && !force) {
    console.log('   ⚠️  File cũ không có _enName/_enDesc, không thể phát hiện thay đổi.');
    console.log('   💡 Chạy với --force để dịch lại toàn bộ.');
    return { total: enData.length, translated: 0, unchanged: enData.length };
  }

  const toProcess = [];

  for (const en of enData) {
    const ex = existingMap.get(en.Id);
    if (!ex) {
      toProcess.push({ en, ex: null, needName: true, needDesc: true, isNew: true });
    } else if (force) {
      const needName = !!en.Name?.trim();
      const needDesc = !!en.Desc?.trim();
      toProcess.push({ en, ex, needName, needDesc, isNew: false });
    } else {
      const sourceName = ex._enName ?? en.Name;
      const sourceDesc = ex._enDesc ?? en.Desc;
      const nameChanged = en.Name !== sourceName;
      const descChanged = en.Desc !== sourceDesc;
      if (nameChanged || descChanged) {
        toProcess.push({ en, ex, needName: nameChanged, needDesc: descChanged, isNew: false });
      }
    }
  }

  const toTranslate = toProcess.filter(t => t.needName || t.needDesc);
  const newItems = toProcess.filter(t => t.isNew).length;
  const updatedItems = toProcess.filter(t => !t.isNew).length;
  const unchanged = enData.length - toProcess.length;

  console.log(`   Mới: ${newItems} | Cập nhật: ${updatedItems} | Giữ nguyên: ${unchchanged}`);

  // Dịch
  let done = 0;
  const translated = new Map();

  const tasks = toTranslate.map(({ en, ex, needName, needDesc }) => async () => {
    const result = { Name: ex?.Name ?? '', Desc: ex?.Desc ?? '' };

    if (needName)  result.Name = restoreGlossary(await translate(applyGlossary(en.Name, targetLang), targetLang), targetLang);
    if (needDesc)  result.Desc = restoreGlossary(await translate(applyGlossary(en.Desc, targetLang), targetLang), targetLang);

    translated.set(en.Id, result);
    done++;
    if (done % 50 === 0 || done === toTranslate.length) {
      process.stdout.write(`\r   Đã dịch: ${done}/${toTranslate.length}`);
    }
  });

  if (tasks.length > 0) {
    await pool(tasks, CONCURRENCY);
    console.log('');
  }

  // Ghép kết quả theo thứ tự EN
  const result = enData.map(en => {
    const ex  = existingMap.get(en.Id);
    const tr  = translated.get(en.Id);
    return {
      Id:             en.Id,
      Type:           en.Type,
      CollectionType: en.CollectionType,
      Name:           tr?.Name  ?? ex?.Name  ?? '',
      Desc:           tr?.Desc  ?? ex?.Desc  ?? '',
      Icon:           en.Icon,
      Rare:           en.Rare,
      IsUnique:       en.IsUnique,
      IconInAB:       en.IconInAB,
      Category:       en.Category ?? '',
      Tag:            en.Tag      ?? '',
      _enName:        en.Name,
      _enDesc:        en.Desc,
    };
  });

  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`   ✅ Ghi ${result.length} items → ${path.basename(outputFile)}`);
  return { total: result.length, translated: toTranslate.length, unchanged };
}

// ── Watch Mode ──────────────────────────────────
async function watchMode() {
  console.log('👁️  Watch mode: theo dõi ItemsData_en.json...');

  const run = async () => {
    try {
      if (!fs.existsSync(EN_FILE)) {
        console.log('   ⏳ Chờ file EN xuất hiện...');
        return;
      }

      const enData = JSON.parse(fs.readFileSync(EN_FILE, 'utf-8'));
      const vnData = fs.existsSync(VN_FILE) ? JSON.parse(fs.readFileSync(VN_FILE, 'utf-8')) : [];
      const zhData = fs.existsSync(ZH_FILE) ? JSON.parse(fs.readFileSync(ZH_FILE, 'utf-8')) : [];

      console.log(`\n📂 EN: ${enData.length} | VN: ${vnData.length} | ZH: ${zhData.length}`);

      const t0 = Date.now();

      const [vnStats, zhStats] = await Promise.all([
        processLanguage(enData, vnData, 'vi',    VN_FILE, 'Tiếng Việt'),
        processLanguage(enData, zhData, 'zh-TW', ZH_FILE, 'Tiếng Trung'),
      ]);

      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n✅ Hoàn thành trong ${sec}s`);
      console.log(`   VN: ${vnStats.translated} dịch, ${vnStats.unchanged} giữ nguyên`);
      console.log(`   ZH: ${zhStats.translated} dịch, ${zhStats.unchanged} giữ nguyên`);
    } catch (e) {
      console.error('❌ Lỗi:', e.message);
    }
  };

  // Chạy lần đầu
  await run();

  // Theo dõi file EN
  fs.watch(EN_FILE, { persistent: true }, async (eventType) => {
    if (eventType === 'change') {
      console.log('\n🔄 Phát hiện thay đổi ItemsData_en.json, chờ 2s để ghi hoàn tất...');
      await sleep(2000);
      await run();
    }
  });

  console.log('👁️  Đang theo dõi... (Ctrl+C để dừng)');
}

// ── Main ─────────────────────────────────────────
async function main() {
  const watch = process.argv.includes('--watch');
  const force = process.argv.includes('--force');

  if (watch) {
    await watchMode();
    return;
  }

  console.log('🚀 translate-data.js bắt đầu\n');

  if (!fs.existsSync(EN_FILE)) {
    console.error('❌ Không tìm thấy ItemsData_en.json'); process.exit(1);
  }

  const enData = JSON.parse(fs.readFileSync(EN_FILE, 'utf-8'));
  const vnData = fs.existsSync(VN_FILE) ? JSON.parse(fs.readFileSync(VN_FILE, 'utf-8')) : [];
  const zhData = fs.existsSync(ZH_FILE) ? JSON.parse(fs.readFileSync(ZH_FILE, 'utf-8')) : [];

  console.log(`📂 EN: ${enData.length} | VN: ${vnData.length} | ZH: ${zhData.length}`);
  if (force) console.log('⚠️  Chế độ --force: dịch lại TOÀN BỘ');

  const t0 = Date.now();

  const [vnStats, zhStats] = await Promise.all([
    processLanguage(enData, vnData, 'vi',    VN_FILE, 'Tiếng Việt', force),
    processLanguage(enData, zhData, 'zh-TW', ZH_FILE, 'Tiếng Trung', force),
  ]);

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ Hoàn thành trong ${sec}s`);
  console.log(`   VN: ${vnStats.translated} dịch, ${vnStats.unchanged} giữ nguyên`);
  console.log(`   ZH: ${zhStats.translated} dịch, ${zhStats.unchanged} giữ nguyên`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
