# CyberVerse — Free Fire Items Library

Thư viện web toàn diện để khám phá và duyệt tất cả vật phẩm trong game Free Fire — bao gồm icon, ID, độ hiếm và mô tả chi tiết. Giao diện hiện đại, tốc độ cao, tương thích mọi thiết bị.

---

## ✨ Tính Năng

- **Duyệt 25.000+ vật phẩm** với icon đầy đủ, background độ hiếm
- **Tìm kiếm nhanh** theo tên, Icon ID hoặc Item ID
- **Lọc đa chiều** theo OB (Tag), Loại vật phẩm, Độ hiếm
- **Đa ngôn ngữ** — Tiếng Việt & English
- **Chia sẻ vật phẩm** qua link `?item=ID`
- **Tải icon** — tải riêng lẻ hoặc theo batch, có/không có nền độ hiếm
- **Developer Mode** — chọn nhiều vật phẩm, sao chép ID hàng loạt
- **PWA Ready** — cài đặt như ứng dụng trên điện thoại
- **Tự động đồng bộ** dữ liệu và icon mỗi 12 tiếng qua GitHub Actions

---

## 🗂️ Cấu Trúc Dự Án

```
├── index.html              # Giao diện chính
├── ItemsData_en.json       # Dữ liệu vật phẩm (tiếng Anh)
├── CollectionBanner.json   # Dữ liệu banner bộ sưu tập
├── updated_icons.json      # Danh sách icon đã cập nhật (_2.png)
├── ignore_list.json        # Vật phẩm loại trừ khỏi fetch
├── fetch-icons.js          # Script tải icon tự động
├── icons/                  # Thư mục chứa toàn bộ icon (.png)
├── background/             # Ảnh nền theo độ hiếm
└── .github/workflows/
    ├── update-icons.yml    # Tải icon khi data thay đổi
    └── sync-data.yml       # Đồng bộ data từ nguồn mỗi 12h
```

---

## ⚙️ Tự Động Hóa (GitHub Actions)

### `sync-data.yml` — Chạy mỗi 12 tiếng
Tự động kéo dữ liệu mới nhất từ [Free-Fire-Item-Library](https://github.com/KingofGames02/Free-Fire-Items-Library) về repo này:
- Cập nhật `ItemsData_en.json`, `CollectionBanner.json`, `ignore_list.json`
- Chạy `fetch-icons.js` để tải icon mới
- Tự commit & push nếu có thay đổi

### `update-icons.yml` — Chạy khi push
Kích hoạt khi `ItemsData_en.json`, `CollectionBanner.json` hoặc `ignore_list.json` thay đổi:
- Tải icon còn thiếu từ API
- Cập nhật `updated_icons.json`
- 150 worker song song để tối đa tốc độ

---

## � Chạy Cục Bộ

Không cần build tool hay server. Chỉ cần mở `index.html` trong trình duyệt hoặc dùng Live Server:

```bash
# Dùng VS Code Live Server hoặc bất kỳ HTTP server nào
npx serve .
```

---

## 🎨 Độ Hiếm Vật Phẩm

| Độ hiếm | Màu |
|---|---|
| ARTIFACT | 🟥 Đỏ |
| MYTHIC++ | 🟡 Vàng đậm |
| MYTHIC | 🟨 Vàng |
| EPIC++ | 🟣 Tím đậm |
| EPIC | 🟪 Tím |
| RARE | 🟦 Xanh dương |
| UNCOMMON | 🟩 Xanh lá |
| COMMON | ⬜ Trắng |

---

## 📬 Liên Hệ

- **Facebook**: [cyberverse.vn](https://www.facebook.com/cyberverse.vn)
- **Gmail**: cyberverse.vn@gmail.com
