/**
 * translate-data.js
 * Tự động dịch ItemsData_en.json → ItemsData_vn.json & ItemsData_zh.json
 * - Tự động bổ sung item mới, giữ nguyên 100% bản dịch cũ
 * - Chạy `node translate-data.js --watch` để tự động cập nhật khi có item mới
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── Config ──────────────────────────────────────
const EN_FILE   = path.join(__dirname, 'ItemsData_en.json');
const VN_FILE   = path.join(__dirname, 'ItemsData_vn.json');
const ZH_FILE   = path.join(__dirname, 'ItemsData_zh.json');
const NEW_ITEMS_FILE = path.join(__dirname, 'new_items.json');

const CONCURRENCY = 16;
const RETRY_MAX   = 4;
const RETRY_BASE  = 400;

const GLOSSARY_EN = {
  vi: {
    'Top': '__TOP__', 'Bottom': '__BOTTOM__', 'Shoes': '__SHOES__',
    'Head': '__HEAD__', 'Facepaint': '__FACEPAINT__', 'Mask': '__MASK__',
  },
  'zh-TW': {
    'Top': '__TOP__', 'Bottom': '__BOTTOM__', 'Shoes': '__SHOES__',
    'Head': '__HEAD__', 'Facepaint': '__FACEPAINT__', 'Mask': '__MASK__',
  }
};

const GLOSSARY_TRANSLATIONS = {
  vi: {
    '__TOP__': 'Áo', '__BOTTOM__': 'Quần', '__SHOES__': 'Giày',
    '__HEAD__': 'Tóc', '__FACEPAINT__': 'Vẽ Mặt', '__MASK__': 'Mặt Nạ',
  },
  'zh-TW': {
    '__TOP__': '上衣', '__BOTTOM__': '裤子', '__SHOES__': '鞋子',
    '__HEAD__': '頭髮', '__FACEPAINT__': '面部彩繪', '__MASK__': '面具',
  }
};

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

async function processLanguage(enData, existingData, targetLang, outputFile, label, force = false) {
  console.log(`\n🌐 ${label} (${targetLang})`);

  const existingMap = new Map(existingData.map(i => [i.Id, i]));
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
      const nameChanged = ex._enName ? (en.Name !== sourceName) : false;
      const descChanged = ex._enDesc ? (en.Desc !== sourceDesc) : false;
      if (nameChanged || descChanged) {
        toProcess.push({ en, ex, needName: nameChanged, needDesc: descChanged, isNew: false });
      }
    }
  }

  const toTranslate = toProcess.filter(t => t.needName || t.needDesc);
  const newItems = toProcess.filter(t => t.isNew).length;
  const updatedItems = toProcess.filter(t => !t.isNew).length;
  const unchanged = enData.length - toProcess.length;

  console.log(`   Mới: ${newItems} | Cập nhật: ${updatedItems} | Giữ nguyên: ${unchanged}`);

  let done = 0;
  const translated = new Map();

  function commonFields(en) {
    return {
      Id: en.Id, Type: en.Type, CollectionType: en.CollectionType,
      Icon: en.Icon, Rare: en.Rare, IsUnique: en.IsUnique, IconInAB: en.IconInAB,
      Category: en.Category ?? '', Tag: en.Tag ?? '',
    };
  }

  function buildResult() {
    return enData.map(en => {
      const ex = existingMap.get(en.Id);
      const tr = translated.get(en.Id);
      if (tr) {
        return { ...commonFields(en), Name: tr.Name, Desc: tr.Desc, _enName: en.Name, _enDesc: en.Desc };
      }
      if (ex) {
        return {
          ...commonFields(en),
          Name: ex.Name ?? '',
          Desc: ex.Desc ?? '',
          _enName: ex._enName ?? en.Name,
          _enDesc: ex._enDesc ?? en.Desc
        };
      }
      return { ...commonFields(en), Name: en.Name, Desc: en.Desc, _enName: en.Name, _enDesc: en.Desc };
    });
  }

  const tasks = toTranslate.map(({ en, ex, needName, needDesc }) => async () => {
    const result = { Name: ex?.Name ?? '', Desc: ex?.Desc ?? '' };
    if (needName)  result.Name = restoreGlossary(await translate(applyGlossary(en.Name, targetLang), targetLang), targetLang);
    if (needDesc)  result.Desc = restoreGlossary(await translate(applyGlossary(en.Desc, targetLang), targetLang), targetLang);

    translated.set(en.Id, result);
    done++;
    if (done % 200 === 0 || done === toTranslate.length) {
      console.log(`   [${targetLang}] Đã dịch: ${done}/${toTranslate.length}`);
    }
  });

  if (tasks.length > 0) {
    await pool(tasks, CONCURRENCY);
  }

  const result = buildResult();
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`   ✅ Ghi ${result.length} items → ${path.basename(outputFile)}`);
  return { total: result.length, translated: toTranslate.length, unchanged };
}

function writeNewItemsFile(enData, vnData) {
  try {
    const existingIds = new Set(vnData.map(i => i.Id.toString()));
    const newIds = enData.filter(en => !existingIds.has(en.Id.toString())).map(en => en.Id.toString());
    fs.writeFileSync(NEW_ITEMS_FILE, JSON.stringify(newIds), 'utf-8');
    console.log(`   🆕 ${newIds.length} vật phẩm mới → ${path.basename(NEW_ITEMS_FILE)}`);
  } catch (e) {}
}

async function runTask(force = false) {
  if (!fs.existsSync(EN_FILE)) {
    console.error('❌ Không tìm thấy ItemsData_en.json'); return;
  }

  const enData = JSON.parse(fs.readFileSync(EN_FILE, 'utf-8'));
  const vnData = fs.existsSync(VN_FILE) ? JSON.parse(fs.readFileSync(VN_FILE, 'utf-8')) : [];
  const zhData = fs.existsSync(ZH_FILE) ? JSON.parse(fs.readFileSync(ZH_FILE, 'utf-8')) : [];

  console.log(`\n📂 EN: ${enData.length} | VN: ${vnData.length} | ZH: ${zhData.length}`);
  writeNewItemsFile(enData, vnData);

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

async function watchMode() {
  console.log('👁️  Watch mode: theo dõi ItemsData_en.json...');

  await runTask();

  fs.watch(EN_FILE, { persistent: true }, async (eventType) => {
    if (eventType === 'change') {
      console.log('\n🔄 Phát hiện thay đổi ItemsData_en.json, chờ 2s để ghi hoàn tất...');
      await sleep(2000);
      await runTask();
    }
  });

  console.log('👁️  Đang theo dõi... (Nhấn Ctrl+C để dừng)');
}

async function main() {
  const watch = process.argv.includes('--watch');
  const force = process.argv.includes('--force');

  console.log('🚀 translate-data.js bắt đầu\n');

  if (watch) {
    await watchMode();
  } else {
    await runTask(force);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });