# PigPort v0.2.3 — Release Notes

> **PigPort** (by PigTinyLabs): Trình khởi chạy và chơi game iOS (IPA) & Android (APK / XAPK) mượt mà trên macOS và Windows với bàn phím và chuột.

---

## 🌟 Điểm nổi bật trong bản cập nhật (What's New)

### 1. 📦 Hỗ trợ định dạng XAPK (Split APKs + OBB Data)
- **Kéo thả và cài đặt 1 chạm:** Giờ đây bạn chỉ cần kéo thả file `.xapk` (như Liên Quân Mobile, Free Fire, PUBG, Genshin...) vào cửa sổ PigPort.
- **Tự động xử lý Split APKs:** Trích xuất và cài đặt đồng thời toàn bộ các gói split APK (`base.apk`, `config.arm64_v8a.apk`, `config.xxxhdpi.apk`,...) qua `adb install-multiple`.
- **Tự động chuyển OBB:** Tự động tạo thư mục `/sdcard/Android/obb/<bundleId>/` và sao chép đầy đủ các tệp dữ liệu đồ hoạ `.obb` vào thiết bị/máy ảo mà không cần can thiệp thủ công.
- **Badge nhận diện mới:** Bổ sung nhãn phân loại **XAPK** màu hổ phách chuyên nghiệp trong Thư viện Game.

### 2. 🛡️ Chống Crash & Bypass Anti-Cheat cho Game iOS (Apple Silicon)
- **Chặn lệnh thoát ứng dụng cưỡng bức:** Intercept các hàm hệ thống `exit()`, `abort()`, `pthread_kill()` mà các SDK bảo mật (như Tencent CrashSight, ACE Anti-cheat) thường kích hoạt khi phát hiện môi trường macOS.
- **Method Swizzling:** Vô hiệu hoá các hàm báo cáo lỗi và đóng ứng dụng của CrashSight runtime.
- **Mocking Keychain & Chống đệ quy:** Bổ sung cơ chế bảo vệ Keychain trong thư viện native `PlayBridgeInput.dylib`, ngăn chặn các lỗi crash do truy cập sai quyền Keychain hoặc deadlock đệ quy.

### 3. 🎨 Nâng cấp Giao diện Thư viện Game (Modern UI/UX)
- **Giao diện thẻ game hiện đại:** Thiết kế lại card game với avatar logo sắc nét, bo góc mềm mại, hiển thị rõ ràng Bundle ID, phiên bản và trạng thái cài đặt.
- **Thanh nút bấm gọn gàng & thông minh:** Các nút **Play**, **Install**, **Force Stop**, **Remove** được tinh chỉnh trực quan, có tooltip hướng dẫn và chỉ kích hoạt khi khả dụng.
- **Hiệu ứng kéo thả chuyên nghiệp:** Hiển thị overlay thông báo "Drop IPA / APK / XAPK to install" khi kéo tệp vào ứng dụng.

### 4. 🚀 Tối ưu hoá Hệ thống & Điều khiển
- Hỗ trợ gán phím linh hoạt (nhấn **⌘K** khi đang chơi game iOS để mở trình chỉnh sửa Keymap).
- Quản lý phiên streaming Scrcpy mượt mà với độ trễ siêu thấp cho Android.
- Tự động phát hiện và cấu hình môi trường Android SDK / ADB / AVD tích hợp.

---

## 📥 Tải xuống cài đặt (Download & Installation)

| Nền tảng | Tệp cài đặt | Ghi chú |
|---|---|---|
| **Mac Apple Silicon (M1/M2/M3/M4)** | `PigPort-0.2.3-mac-arm64.dmg` | Chơi được **cả game iOS (IPA)** và **game Android (APK/XAPK)** |
| **Mac Intel (x64)** | `PigPort-0.2.3-mac-x64.dmg` | Hỗ trợ chơi game Android (APK/XAPK) |
| **Windows (x64)** | `PigPort-0.2.3-win-x64.exe` hoặc `.zip` portable | Hỗ trợ chơi game Android (APK/XAPK) |

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
git tag v0.2.3
git push origin v0.2.3
```
GitHub Actions sẽ tự động biên dịch trên các runner macOS và Windows, sau đó đính kèm các file DMG/EXE vào trang Releases!
