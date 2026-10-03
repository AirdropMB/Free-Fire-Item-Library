/**
 * fetch-wishlist.js
 *
 * Tải dữ liệu wishlist / like / xếp hạng / ngày ra mắt & xuất hiện gần nhất của
 * TOÀN BỘ vật phẩm (không chỉ súng) từ API nội bộ wiki.ff.garena.vn
 * (POST /api/app/item?lang=vi, phân trang bằng cursor — giống fetch-guns.js),
 * rồi lưu gọn vào WishlistData.json (key = Item ID). Số liệu không phụ thuộc
 * ngôn ngữ nên chỉ cần 1 file.
 *
 * LƯU Ý: API không chính thức, có thể bị Garena đổi/chặn bất cứ lúc nào.
 *
 * Cách lấy dữ liệu:
 *  1) Thử không filter (lấy tất cả danh mục) — nếu server từ chối thì
 *  2) fallback: lặp qua từng category 1..CATEGORY_MAX.
 *
 * Usage: node fetch-wishlist.js
 */
const fs = require('fs');
const path = require('path');

const API_URL = 'https://wiki.ff.garena.vn/api/app/item';
const LANG = 'vi';
const PAGE_LIMIT = 100;
const MAX_PAGES = 1000;
const CATEGORY_MAX = 20;
const OUT_FILE = path.join(__dirname, 'WishlistData.json');

async function fetchPage(filter, cursor) {
    const body = { limit: PAGE_LIMIT };
    if (filter) body.filter = filter;
    if (cursor !== undefined && cursor !== null) body.cursor = cursor;
    const res = await fetch(`${API_URL}?lang=${LANG}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Referer': 'https://wiki.ff.garena.vn/',
            'Origin': 'https://wiki.ff.garena.vn',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} (cursor=${cursor})`);
    return res.json();
}

async function fetchAll(filter, label, out) {
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
        const json = await fetchPage(filter, cursor);
        const data = Array.isArray(json.data) ? json.data : [];
        for (const x of data) {
            if (x.id == null) continue;
            out[String(x.id)] = {
                w: x.wishlist, l: x.like, d: x.dislike,
                c: x.category, g: x.genre, r: x.rank, cr: x.categoryRank, gr: x.genreRank,
                fi: x.firstAppearedIn, fa: x.firstAppearedAt,
                li: x.lastAppearedIn, la: x.lastAppearedAt,
            };
        }
        if (page % 10 === 0) console.log(`[${label}] trang ${page + 1}: tổng ${Object.keys(out).length}`);
        if (data.length < PAGE_LIMIT || json.cursor === undefined || json.cursor === null || json.cursor === cursor) break;
        cursor = json.cursor;
    }
}

async function start() {
    const out = {};
    try {
        await fetchAll(null, 'all', out);
    } catch (e) {
        console.warn(`[fetch-wishlist] Không filter bị lỗi (${e.message}) -> thử theo từng category`);
        for (let c = 1; c <= CATEGORY_MAX; c++) {
            try { await fetchAll({ category: [c] }, `cat ${c}`, out); }
            catch (err) { console.warn(`[fetch-wishlist] category ${c}: ${err.message}`); }
        }
    }
    const n = Object.keys(out).length;
    if (n === 0) {
        console.warn('[fetch-wishlist] CẢNH BÁO: 0 vật phẩm — có thể API đã đổi, KHÔNG ghi đè file cũ.');
        process.exitCode = 1;
        return;
    }
    // Không có dữ liệu mới hơn thì giữ lại mục cũ (tránh mất khi API trả thiếu)
    let old = {};
    try { old = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch (_) {}
    const merged = { ...old, ...out };
    fs.writeFileSync(OUT_FILE, JSON.stringify(merged));
    console.log(`[fetch-wishlist] Đã lưu ${Object.keys(merged).length} vật phẩm (mới/cập nhật: ${n}) -> WishlistData.json`);
}
start();
