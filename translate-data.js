/**
 * translate-data.js
 * Tự động dịch ItemsData_en.json → ItemsData_vn.json & ItemsData_zh.json
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isOB55Item(item) {
  const tag = String(item.Tag || '').toUpperCase();
  const category = String(item.Category || '').toUpperCase();
  const name = String(item.Name || '').toUpperCase();
  return tag.includes('OB55') || category.includes('OB55') || name.includes('OB55');
}

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

// ── Google Translate ─────
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
          resolve(out || null);
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
      const res = await translateText(text, lang);
      if (res !== null) return res;
    } catch (e) {
      if (i < RETRY_MAX - 1) await sleep(RETRY_BASE * Math.pow(2, i));
    }
  }
  return null; // Trả về null nếu lỗi để đánh dấu dịch thất bại
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

// ── Xử lý một ngôn ngữ ──────────────────────────
async function processLanguage(enData, existingData, targetLang, outputFile, label, force = false) {
  console.log(`\n🌐 ${label} (${targetLang})`);

  const existingMap = new Map(existingData.map(i => [i.Id, i]));
  const PENDING = '\u0000__PENDING__\u0000';

  // File "meta" riêng, chỉ chứa _enName/_enDesc để so sánh thay đổi - KHÔNG gửi cho web
  // (giúp ItemsData_vn.json/ItemsData_zh.json nhẹ bằng đúng bản EN, không bị nhân đôi dung lượng)
  const metaFile = outputFile.replace(/\.json$/, '.meta.json');
  let existingMetaArr = [];
  if (fs.existsSync(metaFile)) {
    try { existingMetaArr = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch { existingMetaArr = []; }
  }
  const existingMeta = new Map(existingMetaArr.map(m => [m.Id, m]));
  // Tự động chuyển dữ liệu cũ (bản trước có _enName/_enDesc nhúng thẳng trong item) sang file meta riêng
  if (existingMeta.size === 0) {
    for (const item of existingData) {
      if ('_enName' in item) existingMeta.set(item.Id, { Id: item.Id, _enName: item._enName, _enDesc: item._enDesc });
    }
  }

  const toProcess = [];

  for (const en of enData) {
    const ex = existingMap.get(en.Id);
    if (!ex) {
      toProcess.push({ en, ex: null, needName: !!en.Name?.trim(), needDesc: !!en.Desc?.trim(), isNew: true });
    } else if (force) {
      toProcess.push({ en, ex, needName: !!en.Name?.trim(), needDesc: !!en.Desc?.trim(), isNew: false });
    } else {
      const exMeta = existingMeta.get(en.Id);
      const sourceName = exMeta?._enName ?? PENDING;
      const sourceDesc = exMeta?._enDesc ?? PENDING;

      // Tự động phát hiện nếu bị kẹt Tiếng Anh hoặc chưa được dịch
      const isNameUntranslated = !!en.Name?.trim() && (!ex.Name?.trim() || ex.Name === en.Name || sourceName === PENDING);
      const isDescUntranslated = !!en.Desc?.trim() && (!ex.Desc?.trim() || ex.Desc === en.Desc || sourceDesc === PENDING);

      const nameChanged = en.Name !== sourceName;
      const descChanged = en.Desc !== sourceDesc;

      const needName = isNameUntranslated || nameChanged;
      const needDesc = isDescUntranslated || descChanged;

      if (needName || needDesc) {
        toProcess.push({ en, ex, needName, needDesc, isNew: false });
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

  // Trả về 2 phần tách biệt: publicItems (ghi ra file web tải) và metaItems (chỉ để theo dõi nội bộ)
  function buildResult() {
    const publicItems = [];
    const metaItems = [];
    for (const en of enData) {
      const ex = existingMap.get(en.Id);
      const tr = translated.get(en.Id);
      let Name, Desc, enNameOut, enDescOut;
      if (tr) {
        Name = tr.Name; Desc = tr.Desc;
        enNameOut = tr.successName ? en.Name : PENDING;
        enDescOut = tr.successDesc ? en.Desc : PENDING;
      } else if (ex) {
        Name = ex.Name ?? ''; Desc = ex.Desc ?? '';
        const exMeta = existingMeta.get(en.Id);
        enNameOut = exMeta?._enName ?? PENDING;
        enDescOut = exMeta?._enDesc ?? PENDING;
      } else {
        Name = ''; Desc = ''; enNameOut = PENDING; enDescOut = PENDING;
      }
      publicItems.push({ ...commonFields(en), Name, Desc });
      metaItems.push({ Id: en.Id, _enName: enNameOut, _enDesc: enDescOut });
    }
    return { publicItems, metaItems };
  }

  let lastCheckpoint = Date.now();
  function checkpointSave(force = false) {
    const now = Date.now();
    if (!force && now - lastCheckpoint < 20000) return;
    lastCheckpoint = now;
    try {
      const { publicItems, metaItems } = buildResult();
      fs.writeFileSync(outputFile, JSON.stringify(publicItems, null, 2), 'utf-8');
      fs.writeFileSync(metaFile, JSON.stringify(metaItems), 'utf-8');
    } catch (e) {}
  }

  const tasks = toTranslate.map(({ en, ex, needName, needDesc }) => async () => {
    const result = {
      Name: ex?.Name ?? '',
      Desc: ex?.Desc ?? '',
      successName: !needName,
      successDesc: !needDesc
    };

    if (needName) {
      const res = await translate(applyGlossary(en.Name, targetLang), targetLang);
      if (res) {
        result.Name = restoreGlossary(res, targetLang);
        result.successName = true;
      }
    }

    if (needDesc) {
      const res = await translate(applyGlossary(en.Desc, targetLang), targetLang);
      if (res) {
        result.Desc = restoreGlossary(res, targetLang);
        result.successDesc = true;
      }
    }

    translated.set(en.Id, result);
    done++;
    if (done % 200 === 0 || done === toTranslate.length) {
      console.log(`   [${targetLang}] Đã dịch: ${done}/${toTranslate.length}`);
    }
    checkpointSave();
  });

  if (tasks.length > 0) {
    await pool(tasks, CONCURRENCY);
  }

  const { publicItems, metaItems } = buildResult();
  fs.writeFileSync(outputFile, JSON.stringify(publicItems, null, 2), 'utf-8');
  fs.writeFileSync(metaFile, JSON.stringify(metaItems), 'utf-8');
  console.log(`   ✅ Ghi ${publicItems.length} items → ${path.basename(outputFile)} (+ ${path.basename(metaFile)} nội bộ)`);
  return { total: publicItems.length, translated: toTranslate.length, unchanged };
}

function writeNewItemsFile(enData, vnData) {
  try {
    const existingIds = new Set(vnData.map(i => i.Id.toString()));
    const newIds = enData.filter(en => !existingIds.has(en.Id.toString())).map(en => en.Id.toString());
    fs.writeFileSync(NEW_ITEMS_FILE, JSON.stringify(newIds), 'utf-8');
    console.log(`   🆕 ${newIds.length} vật phẩm mới → ${path.basename(NEW_ITEMS_FILE)}`);
  } catch (e) {}
}

async function watchMode() {
  console.log('👁️  Watch mode: theo dõi ItemsData_en.json...');

  const run = async () => {
    try {
      if (!fs.existsSync(EN_FILE)) return;

      const rawEnData = JSON.parse(fs.readFileSync(EN_FILE, 'utf-8'));
      const enData = rawEnData.filter(item => !isOB55Item(item));
      const hiddenCount = rawEnData.length - enData.length;
      if (hiddenCount > 0) console.log(`🙈 Đã tạm ẩn ${hiddenCount} vật phẩm thuộc OB55.`);

      const vnData = fs.existsSync(VN_FILE) ? JSON.parse(fs.readFileSync(VN_FILE, 'utf-8')) : [];
      const zhData = fs.existsSync(ZH_FILE) ? JSON.parse(fs.readFileSync(ZH_FILE, 'utf-8')) : [];

      console.log(`\n📂 EN: ${enData.length} | VN: ${vnData.length} | ZH: ${zhData.length}`);
      writeNewItemsFile(enData, vnData);

      const t0 = Date.now();
      const vnStats = await processLanguage(enData, vnData, 'vi',    VN_FILE, 'Tiếng Việt');
      const zhStats = await processLanguage(enData, zhData, 'zh-TW', ZH_FILE, 'Tiếng Trung');

      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n✅ Hoàn thành trong ${sec}s`);
      console.log(`   VN: ${vnStats.translated} dịch, ${vnStats.unchanged} giữ nguyên`);
      console.log(`   ZH: ${zhStats.translated} dịch, ${zhStats.unchanged} giữ nguyên`);
    } catch (e) {
      console.error('❌ Lỗi:', e.message);
    }
  };

  await run();

  fs.watch(EN_FILE, { persistent: true }, async (eventType) => {
    if (eventType === 'change') {
      console.log('\n🔄 Phát hiện thay đổi ItemsData_en.json, chờ 2s...');
      await sleep(2000);
      await run();
    }
  });
}

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

  const rawEnData = JSON.parse(fs.readFileSync(EN_FILE, 'utf-8'));
  const enData = rawEnData.filter(item => !isOB55Item(item));
  const hiddenCount = rawEnData.length - enData.length;
  if (hiddenCount > 0) console.log(`🙈 Đã tạm ẩn ${hiddenCount} vật phẩm thuộc OB55.`);

  const vnData = fs.existsSync(VN_FILE) ? JSON.parse(fs.readFileSync(VN_FILE, 'utf-8')) : [];
  const zhData = fs.existsSync(ZH_FILE) ? JSON.parse(fs.readFileSync(ZH_FILE, 'utf-8')) : [];

  console.log(`📂 EN: ${enData.length} | VN: ${vnData.length} | ZH: ${zhData.length}`);
  writeNewItemsFile(enData, vnData);

  const t0 = Date.now();
  const vnStats = await processLanguage(enData, vnData, 'vi',    VN_FILE, 'Tiếng Việt', force);
  const zhStats = await processLanguage(enData, zhData, 'zh-TW', ZH_FILE, 'Tiếng Trung', force);

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ Hoàn thành trong ${sec}s`);
  console.log(`   VN: ${vnStats.translated} dịch/sửa, ${vnStats.unchanged} giữ nguyên`);
  console.log(`   ZH: ${zhStats.translated} dịch/sửa, ${zhStats.unchanged} giữ nguyên`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
