# 🐷 PigPort

<p align="center">
  <img src="build/icon.png" width="128" alt="PigPort Logo">
  <br>
  <b>Chơi game iOS và Android mượt mà trên Mac & Windows bằng Bàn phím & Chuột</b>
  <br>
  <i>Một sản phẩm của PigTinyLabs</i>
</p>

---

## 🎮 Giới thiệu

**PigPort** là trình khởi chạy và chơi game di động đa nền tảng, cho phép bạn mang trọn vẹn trải nghiệm game **iOS (file .ipa)** và **Android (file .apk, .xapk)** lên máy tính cá nhân. Với hệ thống gán phím thông minh và công nghệ tối ưu hoá đồ hoạ độ trễ thấp, bạn có thể điều khiển mọi tựa game di động yêu thích dễ dàng và chuẩn xác như một game PC thực thụ!

---

## ⚡ Tính năng nổi bật cho game thủ

- 🎯 **Kéo & Thả Cài Đặt 1 Chạm**: Kéo thả trực tiếp file `.ipa`, `.apk` hoặc `.xapk` vào PigPort để cài đặt và tự động cập nhật vào Thư viện Game.
- 📦 **Hỗ trợ định dạng XAPK**: Tự động trích xuất các gói Split APKs và sao chép toàn bộ dữ liệu đồ hoạ OBB vào game mà không cần thao tác thủ công.
- ⌨️ **Trình Gán Phím Trực Quan (Visual Keymap Editor)**:
  - Tùy biến phím bấm trực quan ngay trên khung hình game (nhấn nút **🎮 Controls** trên card hoặc phím tắt **⌘K** khi đang chơi).
  - Cụm di chuyển **WASD Joystick** mượt mà cho các game MOBA (Liên Quân Mobile, Tốc Chiến) và Nhập vai sinh tồn.
  - Chế độ **Lia chuột (Mouse Look)** xoay camera 360° tự do dành riêng cho game bắn súng FPS và Battle Royale (PUBG, Free Fire).
  - Hỗ trợ gán phím chuột trái, chuột phải, chuột giữa và tùy chỉnh độ nhạy mượt mà.
- 🍎 **Chơi Game iOS Mượt Mà trên Mac Apple Silicon**: Chạy trực tiếp các tựa game iPhone & iPad (IPA) trên chip Apple M1/M2/M3/M4 với hiệu năng đồ hoạ gốc cực cao.
- 🤖 **Môi trường Android Tối Ưu**: Tự động cấu hình môi trường máy ảo và công cụ Android tối ưu cho game mà không cần cài đặt rườm rà.
- 🖥️ **Tự động khớp khung hình chuẩn tỉ lệ**: Tự động đo đạc và khóa đúng tỷ lệ khung hình thật của game, không bị méo hay vỡ hạt, hỗ trợ hiển thị toàn màn hình sắc nét.

---

## 🖥️ Hỗ trợ nền tảng

| Tính năng | macOS (Apple Silicon M1/M2/M3/M4) | macOS (Intel x64) | Windows (x64) |
|---|:---:|:---:|:---:|
| **Game iOS (.ipa)** | ✅ Cực mượt | ❌ Không hỗ trợ | ❌ Không hỗ trợ |
| **Game Android (.apk, .xapk)** | ✅ Có | ✅ Có | ✅ Có |
| **Trình chỉnh sửa phím Controls** | ✅ Có | ✅ Có | ✅ Có |
| **Kéo thả cài đặt tự động** | ✅ Có | ✅ Có | ✅ Có |

---

## 🕹️ Hướng dẫn chơi game

### 1. Cài đặt game vào Thư viện
- Mở **PigPort**.
- Kéo thả file game (`.ipa`, `.apk`, hoặc `.xapk`) vào cửa sổ ứng dụng, hoặc bấm nút **Install IPA / APK / XAPK**.
- Game sẽ được tự động cài đặt và hiển thị thẻ game với avatar/logo sắc nét trong Thư viện.

### 2. Bắt đầu chơi
- Bấm **▶ Play** trên thẻ game để khởi chạy và bắt đầu chiến game.
- Điều khiển game bằng bàn phím và chuột đã được thiết lập sẵn.

### 3. Tùy chỉnh phím điều khiển (Controls)
- Bấm nút **🎮 Controls** trên thẻ game hoặc nhấn phím tắt **⌘K** trong khi đang chơi để mở giao diện gán phím:
  - **+ Button**: Thêm nút bấm đơn (gán bất kỳ phím nào trên bàn phím hoặc chuột).
  - **+ Joystick**: Thêm cụm phím di chuyển 4 hướng WASD (có thể kéo chỉnh bán kính và vị trí tâm).
  - **+ Mouse look**: Tạo vùng lia góc nhìn bằng chuột (nhấn phím `` ` `` để bật/tắt khoá chuột).
- Kéo thả các nút đến đúng vị trí kỹ năng trên màn hình rồi bấm **Save** để áp dụng ngay lập tức!

---

## 🛠️ Cài đặt & Khởi chạy từ mã nguồn

Dành cho các bạn lập trình viên muốn tự build hoặc đóng góp phát triển:

### Yêu cầu
- [Node.js](https://nodejs.org/) phiên bản 22 trở lên.

### Cài đặt
```bash
# Cài đặt các thư viện phụ thuộc
npm install

# Thiết lập Electron binary
npm run setup:electron

# Tải scrcpy-server cho Android stream
npm run fetch:scrcpy-server
```

### Khởi chạy ứng dụng
```bash
npm start
```

### Đóng gói ứng dụng
```bash
# Build bộ cài đặt cho macOS (.dmg)
npm run dist:mac

# Build bộ cài đặt cho Windows (.exe)
npm run dist:win
```

---

## 📄 Giấy phép
- Phát hành bởi **PigTinyLabs**.
- Dự án mã nguồn mở theo giấy phép [MIT](LICENSE).
