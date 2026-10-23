# PigPort v0.2.4 — Release Notes

> **PigPort** (by PigTinyLabs): A smooth, high-performance launcher to play iOS (IPA) and Android (APK / XAPK) games on macOS and Windows with keyboard and mouse.

<p align="center">
  <b>English</b> | <a href="#-tiếng-việt-ghi-chú-phát-hành">Tiếng Việt</a>
</p>

---

## 🌟 What's New in v0.2.4

### 1. 🎮 Visual Controls & Keymap Editor
- **Configure Before or In-Game**: A dedicated **Controls** button is now available on every game card in your library (supporting IPA, APK, and XAPK).
- **In-Game Visual Overlay**: Open the keymap editor while playing Android games with a live snapshot of your game frame for pixel-perfect binding placement.
- **Versatile Input Widgets**:
  - **Key Tap**: Assign any keyboard key or mouse button (LMB, RMB, MMB).
  - **WASD Movement Joystick**: Customizable center position, radius, and smooth multi-touch mapping for MOBAs and RPGs.
  - **Mouse Look**: 360° free camera control with configurable sensitivity for FPS and Battle Royale games. Toggle mouse lock anytime using the `` ` `` key.
- **Profiles & Presets**: Includes starter presets for MOBA and FPS games; easily export and import keymap profiles in JSON format.

### 2. ⚡ Android Runtime Stability & Architecture Guard
- **Smart Architecture Filter**: Automatically inspects APK/XAPK native ABIs and prevents installing packages incompatible with the host or emulator CPU.
- **Boot Verification**: Ensures both `sys.boot_completed` and the Android Package Manager service are fully responsive before initiating gameplay or streaming.
- **Launch Monitoring**: Replaced legacy random runner with precise `am start -W` activity resolution and main-process health monitoring to catch early crashes instantly.
- **One-Click Diagnostics**: Built-in diagnostics extraction on every game card; automatically dumps crash buffers into `diagnostics/android-latest.txt` for fast troubleshooting.
- **Graphics Fallback**: Added Auto and Software graphics rendering options in Settings for systems with GPU driver issues.

### 3. 🍎 iOS Native Input & Clean Shutdown
- **Clean Shutdown Guards**: Added resource cleanup and hook release guards in `PlayBridgeInput.dylib` to prevent crashes or freezes when closing iOS game windows.
- **Runtime Environment Protection**: Maintained and refined Keychain mocking and disabled forced abort calls from game crash-handlers.

### 4. 🎨 UI & Icon Enhancements
- **Modern 2-Tier Card Layout**: Clean separation between primary game actions (Play, Controls) and utility tools (Diagnostics, Reinstall, Uninstall).
- **Full APK & XAPK Game Icons**: Automatic extraction and rendering of high-resolution `.webp`, `.png`, and `.jpg` launcher icons from game archives and inner APKs.

---

## 📥 Downloads

| Platform | Installer File | Supported Games |
|---|---|---|
| **Mac Apple Silicon (M1/M2/M3/M4)** | `PigPort-0.2.4-mac-arm64.dmg` | **Both iOS (IPA)** and **Android (APK/XAPK)** |
| **Mac Intel (x64)** | `PigPort-0.2.4-mac-x64.dmg` | Android (APK/XAPK) |
| **Windows (x64)** | `PigPort-0.2.4-win-x64.exe` or portable `.zip` | Android (APK/XAPK) |

---

## ⚠️ First-time Launch Instructions

Because the application is not signed with paid commercial certificates from Apple / Microsoft:

### On macOS:
1. Drag `PigPort.app` into your `Applications` folder.
2. Open the app. If macOS displays a security warning:
   - Go to **System Settings → Privacy & Security**.
   - Scroll down to the *Security* section, find PigPort, and click **Open Anyway**.
   - Or run in Terminal: `xattr -cr /Applications/PigPort.app`.

### On Windows:
1. Open the `.exe` installer. If Windows SmartScreen displays *"Windows protected your PC"*:
   - Click **More info**.
   - Click **Run anyway**.

---

<br>

# 🇻🇳 Tiếng Việt: Ghi Chú Phát Hành

## 🌟 Điểm nổi bật trong bản cập nhật v0.2.4

### 1. 🎮 Trình Chỉnh Sửa Phím Gán Trực Quan (Visual Controls Editor)
- **Cấu hình phím trước hoặc trong khi chơi:** Nút **Controls** mới trên từng thẻ game cho phép tùy biến phím gán trước khi khởi chạy game (hỗ trợ cả IPA, APK và XAPK).
- **Trực quan hoá trên màn hình game:** Mở trình chỉnh sửa ngay trong phiên chơi Android kèm ảnh chụp khung hình game thực tế.
- **Đa dạng công cụ gán phím:** Nút bấm đơn (Key Tap), cụm di chuyển WASD Joystick, vùng lia chuột (Mouse Look) xoay góc nhìn 360°.
- **Preset & Quản lý profile:** Starter preset cho game MOBA / FPS; hỗ trợ Export / Import file cấu hình JSON.

### 2. ⚡ Nâng Cao Độ Ổn Định Android
- **Lọc kiến trúc APK thông minh:** Kiểm tra và từ chối các gói APK/XAPK không tương thích với CPU của thiết bị hoặc máy ảo.
- **Kiểm tra trạng thái an toàn:** Chờ Package Manager sẵn sàng thực sự trước khi tiến hành cài đặt hoặc stream.
- **Chẩn đoán lỗi nhanh:** Tích hợp nút Diagnostics trích xuất nhật ký crash tự động khi game gặp sự cố.

### 3. 🍎 Tối Ưu Hooking Native iOS
- **Clean Shutdown Guards:** Dọn dẹp tài nguyên và unhook an toàn khi đóng cửa sổ game iOS, ngăn ngừa crash khi thoát app.

### 4. 🎨 Nâng cấp Giao diện & Hiển thị Icon
- **Bố cục thẻ game 2 tầng:** Cân đối, không bị tràn viền hay đè chữ.
- **Tải logo game thực tế:** Trích xuất tự động icon `.webp` / `.png` từ file APK và XAPK.
