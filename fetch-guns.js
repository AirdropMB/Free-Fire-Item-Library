/**
 * fetch-guns.js
 *
 * Tải toàn bộ danh sách súng (category=10) từ API nội bộ của trang
 * wiki.ff.garena.vn, dùng đúng request mà trang https://wiki.ff.garena.vn/guns
 * tự gọi (POST /api/app/item?lang=<lang>, filter theo category + powerType,
 * phân trang bằng cursor), rồi lưu ra GunsData_<lang>.json cho từng ngôn ngữ.
 *
 * LƯU Ý: Đây KHÔNG phải API chính thức/công khai — suy ra được từ tab Network
 * của DevTools khi mở trang /guns. Garena có thể đổi, chặn hoặc yêu cầu thêm
 * điều kiện (Cloudflare, token...) bất cứ lúc nào mà không báo trước. Nếu
 * script này đột nhiên lỗi hàng loạt, nhiều khả năng là do phía đó thay đổi,
 * cần mở lại DevTools kiểm tra request thực tế và cập nhật lại.
 *
 * Usage:
 *   node fetch-guns.js [danh_sách_lang_cach_nhau_dau_phay]
 *   node fetch-guns.js vi,en
 */
const fs = require('fs');
const path = require('path');

const API_URL = 'https://wiki.ff.garena.vn/api/app/item';

// Giữ nguyên filter như trang gốc /guns đang dùng cho danh mục "Súng":
// category:10 = súng, powerType:1 = theo đúng web gốc (chưa rõ ý nghĩa chính
// xác, giữ nguyên cho an toàn thay vì đoán bỏ đi).
const FILTER = { category: [10], powerType: 1 };

const PAGE_LIMIT = 100; // lớn hơn 20 mà trang web dùng, để giảm số request
const MAX_PAGES = 500; // chốt an toàn, tránh vòng lặp vô hạn nếu logic cursor đoán sai

const LANGS = (process.argv[2] || 'vi,en').split(',').map(s => s.trim()).filter(Boolean);

async function fetchPage(lang, cursor) {
    const body = { filter: FILTER, limit: PAGE_LIMIT };
    if (cursor !== undefined && cursor !== null) body.cursor = cursor;

    const res = await fetch(`${API_URL}?lang=${encodeURIComponent(lang)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': '*/*',
            // Một số API kiểu này chặn request không có Referer/Origin hợp lệ
            // (giống trình duyệt thật) -> giả lập cho giống nhất có thể.
            'Referer': 'https://wiki.ff.garena.vn/guns',
            'Origin': 'https://wiki.ff.garena.vn',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} khi gọi trang (cursor=${cursor})`);
    }
    return res.json();
}

async function fetchAllGuns(lang) {
    const all = [];
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
        const json = await fetchPage(lang, cursor);
        const data = Array.isArray(json.data) ? json.data : [];
        all.push(...data);

        console.log(`[${lang}] Trang ${page + 1}: +${data.length} súng (tổng ${all.length})`);

        // Hết dữ liệu khi trang trả về ít hơn limit, hoặc server không còn trả cursor.
        if (data.length < PAGE_LIMIT || json.cursor === undefined || json.cursor === null) {
            break;
        }
        cursor = json.cursor;
    }
    return all;
}

async function start() {
    let hadError = false;
    for (const lang of LANGS) {
        try {
            const guns = await fetchAllGuns(lang);
            if (guns.length === 0) {
                console.warn(`[fetch-guns] CẢNH BÁO: "${lang}" trả về 0 súng — có thể API đã đổi, KHÔNG ghi đè file cũ.`);
                hadError = true;
                continue;
            }
            const outFile = path.join(__dirname, `GunsData_${lang}.json`);
            fs.writeFileSync(outFile, JSON.stringify(guns, null, 2));
            console.log(`[fetch-guns] Đã lưu ${guns.length} súng -> GunsData_${lang}.json`);
        } catch (error) {
            console.error(`[fetch-guns] Lỗi khi tải dữ liệu ngôn ngữ "${lang}":`, error.message);
            hadError = true;
        }
    }
    if (hadError) process.exitCode = 1; // GitHub Actions thấy job lỗi (vàng/đỏ) nhưng không chặn các bước sau
}

start();
