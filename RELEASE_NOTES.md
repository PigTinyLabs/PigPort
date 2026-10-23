# PigPort v0.2.4 — Release Notes

> **PigPort** (by PigTinyLabs): Trình khởi chạy và chơi game iOS (IPA) & Android (APK / XAPK) mượt mà trên macOS và Windows với bàn phím và chuột.

---

## 🌟 Điểm nổi bật trong bản cập nhật v0.2.4 (What's New)

### 1. 🎮 Trình Chỉnh Sửa Phím Gán Trực Quan (Visual Controls Editor)
- **Cấu hình phím trước hoặc trong khi chơi:** Nút **Controls** mới trên từng thẻ game trong thư viện cho phép bạn tùy biến phím gán trước khi khởi chạy game (hỗ trợ cả IPA, APK và XAPK).
- **Trực quan hoá trên màn hình game:** Mở trình chỉnh sửa ngay trong phiên chơi Android kèm ảnh chụp khung hình game thực tế tại thời điểm mở để đặt phím chính xác từng pixel.
- **Đa dạng công cụ gán phím:**
  - Nút bấm đơn (Key Tap): Gán phím bất kỳ từ bàn phím hoặc chuột.
  - Cụm di chuyển WASD Joystick: Tuỳ biến bán kính, tâm di chuyển cho các tựa game MOBA / FPS.
  - Vùng lia chuột (Mouse Look): Điều chỉnh độ nhạy theo trục X/Y, khoá chuột khi chơi game bắn súng / sinh tồn.
- **Preset & Quản lý profile:** Cung cấp sẵn layout khởi tạo mẫu cho game MOBA / FPS; hỗ trợ sao lưu (Export) và nạp (Import) file cấu hình phím định dạng JSON.

### 2. ⚡ Nâng Cao Độ Ổn Định Môi Trường Android (Android Runtime & Architecture Guard)
- **Lọc kiến trúc APK thông minh:** Tự động kiểm tra và cảnh báo/từ chối các gói APK/XAPK có native ABI không tương thích với CPU của thiết bị hoặc máy ảo đang chạy.
- **Kiểm tra trạng thái khởi động an toàn:** Chờ đợi cả `sys.boot_completed` và dịch vụ Package Manager sẵn sàng thực sự trước khi tiến hành cài đặt hoặc stream game.
- **Khởi chạy ứng dụng chuẩn xác:** Sử dụng cơ chế resolve Launch Activity và giám sát tiến trình bằng `am start -W` thay thế cách kích hoạt ngẫu nhiên bằng Monkey, ghi nhận ngay lập tức nếu ứng dụng thoát đột ngột.
- **Thu thập chẩn đoán lỗi (Diagnostics):** Tích hợp công cụ chẩn đoán nhanh trên từng card game Android và tự động trích xuất thông tin crash gần nhất vào `diagnostics/android-latest.txt` khi game gặp sự cố.
- **Cấu hình đồ hoạ linh hoạt:** Bổ sung lựa chọn render Auto / Software graphics trong Cài đặt để giải quyết các trường hợp máy ảo bị lỗi GPU driver.

### 3. 🍎 Tối Ưu Hooking Native & Thoát Game Sạch Sẽ (iOS Input Clean Shutdown)
- **Clean Shutdown Guards:** Bổ sung cơ chế bảo vệ dọn dẹp tài nguyên và huỷ hook an toàn trong `PlayBridgeInput.dylib`, ngăn ngừa triệt để tình trạng crash hoặc treo ứng dụng khi người dùng tắt cửa sổ game iOS.
- **Bảo vệ môi trường chạy:** Duy trì và tinh chỉnh cơ chế giả lập Keychain an toàn và vô hiệu hoá lệnh abort cưỡng bức từ các crash handler của game.

### 4. 📦 Kế Thừa Trọn Vẹn Các Tính Năng Từ v0.2.3
- Cài đặt 1 chạm cho định dạng `.xapk` (Split APKs + Data OBB).
- Giao diện thẻ game hiện đại, hiển thị rõ Bundle ID và trạng thái cài đặt.
- Stream mượt mà với Scrcpy độ trễ thấp trên macOS và Windows.

---

## 📥 Tải xuống cài đặt (Download & Installation)

| Nền tảng | Tệp cài đặt | Ghi chú |
|---|---|---|
| **Mac Apple Silicon (M1/M2/M3/M4)** | `PigPort-0.2.4-mac-arm64.dmg` | Chơi được **cả game iOS (IPA)** và **game Android (APK/XAPK)** |
| **Mac Intel (x64)** | `PigPort-0.2.4-mac-x64.dmg` | Hỗ trợ chơi game Android (APK/XAPK) |
| **Windows (x64)** | `PigPort-0.2.4-win-x64.exe` hoặc `.zip` portable | Hỗ trợ chơi game Android (APK/XAPK) |

---

## ⚠️ Hướng dẫn mở ứng dụng lần đầu (Bypass Gatekeeper / SmartScreen)

Do ứng dụng chưa được đăng ký chứng chỉ thương mại trả phí từ Apple / Microsoft:

### Trên macOS:
1. Kéo `PigPort.app` vào thư mục `Applications`.
2. Mở app lần đầu, nếu macOS thông báo chặn:
   - Vào **System Settings (Cài đặt hệ thống)** → **Privacy & Security (Quyền riêng tư & Bảo mật)**.
   - Kéo xuống mục *Security*, bạn sẽ thấy thông báo về PigPort → Bấm **Open Anyway (Vẫn mở)**.
   - Hoặc chạy lệnh terminal: `xattr -cr /Applications/PigPort.app`.

### Trên Windows:
1. Mở file `.exe`, nếu Windows SmartScreen hiện thông báo *"Windows protected your PC"*:
   - Bấm vào chữ **More info (Thêm thông tin)**.
   - Bấm **Run anyway (Vẫn chạy)**.

---

## 🛠️ Hướng dẫn Release trên GitHub (Dành cho Maintainer)

Để kích hoạt GitHub Actions tự động build và xuất bản Release này:

```bash
git tag v0.2.4
git push origin v0.2.4
```
GitHub Actions sẽ tự động biên dịch trên các runner macOS và Windows, sau đó đính kèm các file DMG/EXE vào trang Releases!
