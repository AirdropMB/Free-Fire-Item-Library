/**
 * resolve-loc.js
 *
 * Một số item trong ItemsData (Live lẫn Advance) có field Name/Desc
 * là loc-key chưa resolve, ví dụ: "TXT_CHARACTER_EVA_NAME" thay vì "Eva".
 *
 * Script này dùng file LocId (map key -> Row) + file loc_en.txt (text theo
 * từng dòng, Row 1-indexed) để thay các key TXT_... trong ItemsData bằng
 * text thật, ghi đè lại file gốc.
 *
 * Usage:
 *   node resolve-loc.js <itemsFile> <locIdFile> <locTextFile>
 *
 * Ví dụ:
 *   node resolve-loc.js ItemsData_en.json FF_LocId.json loc_en.txt
 *   node resolve-loc.js ItemsData_en_advance.json FFAdv_LocId.json loc_en_advance.txt
 */
const fs = require('fs');
const path = require('path');

const [, , itemsFileArg, locIdFileArg, locTextFileArg] = process.argv;

if (!itemsFileArg || !locIdFileArg || !locTextFileArg) {
    console.error('Usage: node resolve-loc.js <itemsFile> <locIdFile> <locTextFile>');
    process.exit(1);
}

const itemsPath = path.join(__dirname, itemsFileArg);
const locIdPath = path.join(__dirname, locIdFileArg);
const locTextPath = path.join(__dirname, locTextFileArg);

if (!fs.existsSync(itemsPath)) {
    console.log(`[resolve-loc] Bỏ qua: không tìm thấy ${itemsFileArg}`);
    process.exit(0);
}
if (!fs.existsSync(locIdPath) || !fs.existsSync(locTextPath)) {
    console.log(`[resolve-loc] Bỏ qua: thiếu ${locIdFileArg} hoặc ${locTextFileArg}`);
    process.exit(0);
}

// Placeholder nội bộ của game cho content chưa release chính thức -> coi như "chưa resolve"
const PLACEHOLDER_VALUES = new Set(['nulla', 'null', 'none', '']);

function loadLocMap() {
    const raw = JSON.parse(fs.readFileSync(locIdPath, 'utf8'));
    const arr = Array.isArray(raw) ? raw : Object.values(raw);
    const map = new Map();
    arr.forEach(entry => {
        if (entry && entry.Id !== undefined && entry.Row !== undefined) {
            map.set(String(entry.Id), Number(entry.Row));
        }
    });
    return map;
}

function loadLocLines() {
    const raw = fs.readFileSync(locTextPath, 'utf8');
    // File dùng \r\n giữa các dòng
    return raw.split(/\r\n/);
}

// Nhận diện 1 chuỗi có phải "loc-key" (chưa resolve) hay không: dựa vào việc
// nó CÓ TỒN TẠI trong bảng FF_LocId.json — không đoán theo tiền tố (TXT_,
// T_NN_...) vì nguồn có thể đổi kiểu đặt tên key bất cứ lúc nào (đã từng đổi
// từ TXT_ sang T_NN_ mà không báo trước). Chỉ coi là "có khả năng là key" nếu
// dạng chữ hoa/số/gạch dưới, không có khoảng trắng — để không đụng vào tên
// thật (vốn có khoảng trắng, chữ thường).
function looksLikeLocKey(str) {
    return /^[A-Z0-9_]+$/.test(str);
}

function resolveKey(key, locMap, lines) {
    if (typeof key !== 'string' || !key) return key;
    if (!looksLikeLocKey(key)) return key; // không giống key (có thể đã là text thật) -> giữ nguyên
    const row = locMap.get(key);
    if (row === undefined) return key; // không tìm thấy key -> giữ nguyên
    const idx = row - 1;
    if (idx < 0 || idx >= lines.length) return key;
    const text = lines[idx];
    if (text === undefined) return key;
    const trimmed = text.trim();
    if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return ''; // placeholder nội bộ -> để trống thay vì hiển thị rác
    return trimmed;
}

function start() {
    const locMap = loadLocMap();
    const lines = loadLocLines();

    const rawItems = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
    const items = Array.isArray(rawItems) ? rawItems : Object.values(rawItems);

    let resolvedName = 0, resolvedDesc = 0, placeholderName = 0, placeholderDesc = 0, unresolvedName = 0, unresolvedDesc = 0;

    items.forEach(item => {
        if (typeof item.Name === 'string' && looksLikeLocKey(item.Name)) {
            const before = item.Name;
            const after = resolveKey(before, locMap, lines);
            if (after !== before) {
                item.Name = after;
                if (after === '') placeholderName++; else resolvedName++;
            } else {
                unresolvedName++;
            }
        }
        if (typeof item.Desc === 'string' && looksLikeLocKey(item.Desc)) {
            const before = item.Desc;
            const after = resolveKey(before, locMap, lines);
            if (after !== before) {
                item.Desc = after;
                if (after === '') placeholderDesc++; else resolvedDesc++;
            } else {
                unresolvedDesc++;
            }
        }
    });

    fs.writeFileSync(itemsPath, JSON.stringify(items, null, 4));

    console.log(`[resolve-loc] ${itemsFileArg}`);
    console.log(`  Name  -> resolved: ${resolvedName}, placeholder(blanked): ${placeholderName}, still unresolved: ${unresolvedName}`);
    console.log(`  Desc  -> resolved: ${resolvedDesc}, placeholder(blanked): ${placeholderDesc}, still unresolved: ${unresolvedDesc}`);
}

start();
