const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'ItemsData_en.json');
const bannerPath = path.join(__dirname, 'CollectionBanner.json');
const iconsDir = path.join(__dirname, 'icons');

const advDataPath = path.join(__dirname, 'ItemsData_en_advance.json');
const advBannerPath = path.join(__dirname, 'CollectionBanner_advance.json');
const advIconsDir = path.join(__dirname, 'icons_advance');

const ignoreListPath = path.join(__dirname, 'ignore_list.json');
const CONCURRENCY_LIMIT = 40;
const FORCE_UPDATE = false;

// Icon chưa có thật trên CDN nhưng CDN vẫn trả về response 200 kèm 1 ảnh "placeholder"
// gần như toàn màu đen, thay vì báo lỗi 404. Placeholder đã quan sát được có nhiều
// kích thước byte khác nhau tuỳ kích thước ảnh (icon vuông nhỏ ~200-400B, ảnh nền
// chữ nhật ~3000B), nên KHÔNG dùng 1 ngưỡng byte cố định — thay vào đó so
// "byte trên mỗi pixel": ảnh gần như 1 màu nén cực nhỏ so với số pixel dù ảnh to hay nhỏ,
// còn icon thật có chi tiết nên tỉ lệ này cao hơn hẳn bất kể kích thước ảnh.
const PLACEHOLDER_BYTES_PER_PIXEL = 0.03;
// File nhỏ hơn mốc này thì luôn coi là placeholder dù không đọc được kích thước ảnh
// (ví dụ không phải PNG hợp lệ, hoặc response bị cắt ngang).
const PLACEHOLDER_ABSOLUTE_MIN_BYTES = 150;

// Đọc width/height từ header PNG (8 byte signature + chunk IHDR ngay sau đó).
// Trả về null nếu không phải PNG hợp lệ.
function parsePngSize(buffer) {
    if (!buffer || buffer.length < 24) return null;
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    if (!isPng) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height) return null;
    return { width, height };
}

// true nếu buffer nhiều khả năng là ảnh placeholder (gần như 1 màu), dựa trên
// tỉ lệ byte/pixel; false nếu không xác định được (coi như ảnh thật, không chặn nhầm).
function looksLikePlaceholder(buffer) {
    if (buffer.length < PLACEHOLDER_ABSOLUTE_MIN_BYTES) return true;
    const size = parsePngSize(buffer);
    if (!size) return false;
    const ratio = buffer.length / (size.width * size.height);
    return ratio < PLACEHOLDER_BYTES_PER_PIXEL;
}

// Garena phục vụ icon qua 2 domain khác nhau tuỳ loại mã:
//  - Icon dạng MÃ SỐ (item.Id, hoặc Icon toàn số)  -> dl.cdn.freefiremobile.com
//  - Icon dạng TÊN CHỮ (item.Icon kiểu Icon_face_xxx) -> freefiremobile-a.akamaihd.net
const CDN_NUMERIC = 'https://dl.cdn.freefiremobile.com/live/ABHotUpdates/IconCDN/other/';
// Icon dạng MÃ SỐ của bản ADVANCE (OB test server) nằm ở thư mục /advance/ riêng
const CDN_NUMERIC_ADV = 'https://dl.cdn.freefiremobile.com/advance/ABHotUpdates/IconCDN/other/';
const CDN_NAMED = 'https://freefiremobile-a.akamaihd.net/common/Local/PK/FF_UI_Icon/';
// Proxy dự phòng cuối cùng nếu cả 2 domain gốc đều fail
const ICON_API_FALLBACK = 'https://kog-ff-icons.vercel.app/api/icon/';

// ===== CACHE "MISS" =====
// Lưu những icon đã hỏi CDN mà CDN xác nhận KHÔNG có (404/403), để các lần chạy sau
// không hỏi lại từ đầu. File này phải được commit cùng repo (xem file_pattern trong workflow).
const missCachePath = path.join(__dirname, 'icon_miss_cache.json');
const MISS_TTL_MAIN_MS = 24 * 60 * 60 * 1000;       // icon chính: thử lại sau 1 ngày (icon mới có thể vừa lên CDN)
const MISS_TTL_UPDATE_MS = 7 * 24 * 60 * 60 * 1000; // icon _2: thử lại sau 7 ngày
const MISS_CACHE_SAVE_INTERVAL_MS = 2 * 60 * 1000;

let missCache = {};
if (fs.existsSync(missCachePath)) {
    try {
        missCache = JSON.parse(fs.readFileSync(missCachePath, 'utf8')) || {};
    } catch (error) {
        console.error('Error reading icon_miss_cache.json:', error.message);
        missCache = {};
    }
}

function missKey(dir, file) { return `${path.basename(dir)}/${file}`; }
function isKnownMiss(dir, file, ttl) {
    const t = missCache[missKey(dir, file)];
    return typeof t === 'number' && (Date.now() - t) < ttl;
}
function markMiss(dir, file) { missCache[missKey(dir, file)] = Date.now(); }
function clearMiss(dir, file) { delete missCache[missKey(dir, file)]; }
function saveMissCache() {
    try {
        const now = Date.now();
        const pruned = {};
        for (const [k, t] of Object.entries(missCache)) {
            if (typeof t === 'number' && (now - t) < MISS_TTL_UPDATE_MS) pruned[k] = t;
        }
        missCache = pruned;
        fs.writeFileSync(missCachePath, JSON.stringify(missCache));
    } catch (error) {
        console.error('Error saving icon_miss_cache.json:', error.message);
    }
}

function isNumericCode(id) { return /^\d+$/.test(String(id)); }
function cdnUrlFor(id, advance = false) {
    if (isNumericCode(id)) return `${advance ? CDN_NUMERIC_ADV : CDN_NUMERIC}${id}.png`;
    return `${CDN_NAMED}${id}.png`;
}
function isDefinitiveMiss(res) { return !!res && (res.status === 404 || res.status === 403); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ⏱ Time budget: dừng nhận task mới sau 45 phút để job LUÔN kết thúc gọn gàng
// và bước "git commit & push" phía sau còn chạy được.
const START_TIME = Date.now();
const TIME_BUDGET_MS = 45 * 60 * 1000;
function timeUp() { return Date.now() - START_TIME > TIME_BUDGET_MS; }

const stats = {
    downloaded: 0,
    skipped: 0,
    cachedMiss: 0,
    failed: 0,
    ignoredFull: 0,
    failedItems: [],
    timedOut: false
};

let ignoreData = { ignore_update: [], ignore_all: [] };
if (fs.existsSync(ignoreListPath)) {
    try {
        const rawIgnoreData = fs.readFileSync(ignoreListPath, 'utf8');
        const parsed = JSON.parse(rawIgnoreData);
        if (parsed.ignore_update) ignoreData.ignore_update = parsed.ignore_update.map(String);
        if (parsed.ignore_all) ignoreData.ignore_all = parsed.ignore_all.map(String);
    } catch (error) {
        console.error('Error reading ignore_list.json:', error.message);
    }
}

function ensureIconsDir(dir) {
    if (fs.existsSync(dir)) {
        if (FORCE_UPDATE) {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir);
            console.log(`Cleaned ${path.basename(dir)} folder.`);
        }
    } else {
        fs.mkdirSync(dir, { recursive: true });
    }
}

ensureIconsDir(iconsDir);
ensureIconsDir(advIconsDir);

// Dọn các icon đã lỡ lưu placeholder (đen) từ những lần chạy trước ngưỡng này chưa có.
// Xoá file để lượt chạy này tải lại đúng ảnh, hoặc bị đánh dấu miss nếu vẫn chưa có thật.
function cleanupPlaceholders(dir) {
    if (!fs.existsSync(dir)) return 0;
    let removed = 0;
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.png')) continue;
        const filePath = path.join(dir, file);
        try {
            const buffer = fs.readFileSync(filePath);
            if (looksLikePlaceholder(buffer)) {
                fs.rmSync(filePath);
                removed++;
            }
        } catch (error) {
            // bỏ qua nếu không đọc/xoá được
        }
    }
    return removed;
}

const removedPlaceholdersLive = cleanupPlaceholders(iconsDir);
const removedPlaceholdersAdv = cleanupPlaceholders(advIconsDir);
if (removedPlaceholdersLive || removedPlaceholdersAdv) {
    console.log(`Đã xoá icon placeholder cũ: Live ${removedPlaceholdersLive}, Advance ${removedPlaceholdersAdv}`);
}

// Trả về Response nếu ok hoặc 404; nếu hết lượt retry thì trả về response cuối (có .status)
// hoặc { ok:false, status:0 } khi lỗi mạng.
async function fetchWithRetry(url, maxRetries = 4) {
    let last = { ok: false, status: 0 };
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url);
            if (response.ok || response.status === 404) return response;
            last = response;
        } catch (error) {
            // Lỗi mạng tạm thời -> thử lại, không throw để tránh sập cả job
            last = { ok: false, status: 0 };
        }
        if (i < maxRetries - 1) await sleep(800);
    }
    return last;
}

// Đọc response thành buffer và kiểm tra có phải placeholder (quá nhỏ) hay không.
// Trả về { buffer, isPlaceholder } — buffer = null nếu response không ok.
async function readIfReal(res, debugLabel) {
    if (!res || !res.ok) return { buffer: null, isPlaceholder: false };
    const buffer = Buffer.from(await res.arrayBuffer());
    if (looksLikePlaceholder(buffer)) {
        const size = parsePngSize(buffer);
        const ratio = size ? (buffer.length / (size.width * size.height)).toFixed(4) : 'n/a';
        console.log(`Placeholder phát hiện: ${debugLabel} (${buffer.length}B, ${size ? `${size.width}x${size.height}` : '?'}, ratio=${ratio})`);
        return { buffer: null, isPlaceholder: true };
    }
    return { buffer, isPlaceholder: false };
}

// probe = true (dùng cho icon _2): chỉ thử nhanh 2 lần, KHÔNG gọi proxy dự phòng.
// Trả về { buffer, definitiveMiss }. definitiveMiss = true khi CDN xác nhận icon
// không tồn tại (404/403) HOẶC trả về ảnh placeholder rỗng.
// Mỗi thư mục chỉ dùng CDN của chính nó, KHÔNG chéo sang bên kia:
//  - icons_advance : CDN advance (/advance/...)
//  - icons (live)  : CDN live (/live/...), proxy dự phòng nếu CDN live lỗi
// probe = true (icon _2): thử nhanh, không proxy.
async function downloadOneIcon(id, { probe = false, advance = false } = {}) {
    const primary = await fetchWithRetry(cdnUrlFor(id, advance), probe ? 2 : 4);
    const { buffer: primaryBuf, isPlaceholder: primaryPlaceholder } = await readIfReal(primary, `${id}.png (CDN)`);
    if (primaryBuf) return { buffer: primaryBuf, definitiveMiss: false };

    const miss = isDefinitiveMiss(primary) || primaryPlaceholder;
    // Proxy chỉ dành cho bản Live (proxy không phục vụ icon của bản Advance)
    if (probe || advance) return { buffer: null, definitiveMiss: miss };

    const fallback = await fetchWithRetry(`${ICON_API_FALLBACK}${id}?no_fallback=true`);
    const { buffer: fallbackBuf, isPlaceholder: fallbackPlaceholder } = await readIfReal(fallback, `${id}.png (proxy)`);
    if (fallbackBuf) return { buffer: fallbackBuf, definitiveMiss: false };
    return { buffer: null, definitiveMiss: miss || isDefinitiveMiss(fallback) || fallbackPlaceholder };
}

// Tải 1 icon về targetDir. Trả về true nếu file đã có / tải xong.
async function tryDownload(id, targetDir, missTtl, probe = false) {
    const file = `${id}.png`;
    const filePath = path.join(targetDir, file);

    if (!FORCE_UPDATE && fs.existsSync(filePath)) {
        stats.skipped++;
        return true;
    }
    if (!FORCE_UPDATE && isKnownMiss(targetDir, file, missTtl)) {
        stats.cachedMiss++;
        return false;
    }

    const { buffer, definitiveMiss } = await downloadOneIcon(id, { probe, advance: targetDir === advIconsDir });
    if (buffer) {
        fs.writeFileSync(filePath, buffer);
        clearMiss(targetDir, file);
        stats.downloaded++;
        console.log(`Downloaded: ${file}`);
        return true;
    }
    if (definitiveMiss) markMiss(targetDir, file);
    return false;
}

// doMain   : tải icon chính (<Id>.png hoặc <Icon>.png)
// doUpdate : thăm dò icon cập nhật (<Id>_2.png)
async function downloadIcon(item, targetIconsDir, { doMain = true, doUpdate = true } = {}) {
    const itemID = String(item.Id);
    const iconName = item.Icon ? String(item.Icon) : null;

    const isAllIgnored = ignoreData.ignore_all.includes(itemID) || (iconName && ignoreData.ignore_all.includes(iconName));
    const isUpdateIgnored = ignoreData.ignore_update.includes(itemID) || (iconName && ignoreData.ignore_update.includes(iconName));

    if (isAllIgnored) {
        if (doMain) stats.ignoredFull++;
        return;
    }

    if (doMain) {
        let found = await tryDownload(itemID, targetIconsDir, MISS_TTL_MAIN_MS);
        if (!found && iconName) {
            found = await tryDownload(iconName, targetIconsDir, MISS_TTL_MAIN_MS);
        }
        if (!found) {
            stats.failed++;
            stats.failedItems.push(itemID);
        }
    }

    if (doUpdate && !isUpdateIgnored) {
        await tryDownload(`${itemID}_2`, targetIconsDir, MISS_TTL_UPDATE_MS, true);
    }
}

async function downloadBanner(bannerItem, targetIconsDir) {
    const iconVal = bannerItem.icon;
    if (!iconVal || String(iconVal).trim() === "") return;

    const iconName = String(iconVal).toLowerCase();
    if (ignoreData.ignore_all.includes(iconName)) {
        stats.ignoredFull++;
        return;
    }

    const found = await tryDownload(iconName, targetIconsDir, MISS_TTL_MAIN_MS);
    if (!found) {
        stats.failed++;
        stats.failedItems.push(`Banner: ${iconName}`);
    }
}

function writeUpdatedIcons(targetIconsDir, outputFileName) {
    if (!fs.existsSync(targetIconsDir)) return;
    const allFiles = fs.readdirSync(targetIconsDir);
    const updatedIcons = allFiles
        .filter(file => file.endsWith('_2.png'))
        .map(file => file.replace('_2.png', ''))
        .filter(id => !ignoreData.ignore_update.includes(id) && !ignoreData.ignore_all.includes(id));

    fs.writeFileSync(path.join(__dirname, outputFileName), JSON.stringify(updatedIcons));
    return updatedIcons.length;
}

function loadArray(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(raw) ? raw : Object.values(raw);
}

function validItemsOf(filePath) {
    return loadArray(filePath).filter(item => !(item.HideInIndex === true || !item.Icon || String(item.Icon).trim() === ""));
}

async function start() {
    // Pha 1: icon chính (Live -> Banner -> Advance). Pha 2: thăm dò icon _2.
    // Tách pha để phần Advance không bị chặn phía sau hàng chục nghìn lần thăm dò _2.
    const mainTasks = [];
    const updateTasks = [];

    // ===== LIVE =====
    if (fs.existsSync(dataPath)) {
        validItemsOf(dataPath).forEach(item => {
            mainTasks.push(() => downloadIcon(item, iconsDir, { doMain: true, doUpdate: false }));
            updateTasks.push(() => downloadIcon(item, iconsDir, { doMain: false, doUpdate: true }));
        });
    }
    if (fs.existsSync(bannerPath)) {
        loadArray(bannerPath).forEach(banner => {
            mainTasks.push(() => downloadBanner(banner, iconsDir));
        });
    }

    // ===== ADVANCE (OB test server) =====
    if (fs.existsSync(advDataPath)) {
        validItemsOf(advDataPath).forEach(item => {
            mainTasks.push(() => downloadIcon(item, advIconsDir, { doMain: true, doUpdate: false }));
            updateTasks.push(() => downloadIcon(item, advIconsDir, { doMain: false, doUpdate: true }));
        });
    }
    if (fs.existsSync(advBannerPath)) {
        loadArray(advBannerPath).forEach(banner => {
            mainTasks.push(() => downloadBanner(banner, advIconsDir));
        });
    }

    const tasks = mainTasks.concat(updateTasks);
    console.log(`Tasks: ${mainTasks.length} main + ${updateTasks.length} update-probe = ${tasks.length}`);

    const saveTimer = setInterval(saveMissCache, MISS_CACHE_SAVE_INTERVAL_MS);
    saveTimer.unref();

    let currentIndex = 0;

    async function worker() {
        while (currentIndex < tasks.length) {
            if (timeUp()) { stats.timedOut = true; return; }
            const task = tasks[currentIndex++];
            try {
                await task();
            } catch (error) {
                console.error('Task error:', error.message);
            }
        }
    }

    const workers = [];
    for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
        workers.push(worker());
    }

    await Promise.all(workers);
    clearInterval(saveTimer);
    saveMissCache();

    const remaining = tasks.length - currentIndex;

    const updatedCountLive = writeUpdatedIcons(iconsDir, 'updated_icons.json') || 0;
    const updatedCountAdv = writeUpdatedIcons(advIconsDir, 'updated_icons_advance.json') || 0;

    console.log('\n====================================');
    console.log('         DOWNLOAD SUMMARY           ');
    console.log('====================================');
    if (stats.timedOut) {
        console.log(`⏱ HẾT NGÂN SÁCH THỜI GIAN (${TIME_BUDGET_MS / 60000} phút) — dừng sớm để kịp commit.`);
        console.log(`   Còn ${remaining}/${tasks.length} task chưa xử lý, sẽ tiếp tục ở lần chạy sau.`);
    }
    console.log(`Total Processed : ${tasks.length - remaining} / ${tasks.length}`);
    console.log(`Fully Ignored   : ${stats.ignoredFull}`);
    console.log(`Skipped (Exists): ${stats.skipped}`);
    console.log(`Skipped (Cached miss): ${stats.cachedMiss}`);
    console.log(`Placeholder (đen) cũ đã xoá lúc khởi động (Live/Advance): ${removedPlaceholdersLive}/${removedPlaceholdersAdv}`);
    console.log(`Downloaded New  : ${stats.downloaded}`);
    console.log(`Failed          : ${stats.failed}`);
    console.log(`Miss cache size : ${Object.keys(missCache).length}`);
    console.log(`Updated Icons Detected & Saved (Live)    : ${updatedCountLive}`);
    console.log(`Updated Icons Detected & Saved (Advance) : ${updatedCountAdv}`);

    if (stats.failedItems.length > 0 && stats.failedItems.length <= 50) {
        console.log('------------------------------------');
        console.log('Failed Items IDs / Banners:');
        console.log(stats.failedItems.join(', '));
    }
    console.log('====================================\n');
}

start();
