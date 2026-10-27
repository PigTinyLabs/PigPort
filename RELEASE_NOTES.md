# PigPort v0.2.6 — Release Notes

> **PigPort** (by PigTinyLabs): A smooth, high-performance launcher to play iOS (IPA) and Android (APK / XAPK) games on macOS and Windows with keyboard and mouse.

<p align="center">
  <b>English</b> | <a href="#-tiếng-việt-ghi-chú-phát-hành">Tiếng Việt</a>
</p>

---

## 🌟 What's New in v0.2.6

### 1. 🪟 Windows Clean Shutdown & Background Resource Cleanup
- **No More Orphaned Emulator Processes**: Ensures the Android emulator (`qemu-system-*`) and ADB server are cleanly terminated whenever the application window is closed on Windows.
- **Disk Space Overflow Prevention**: Prevents background emulator processes from remaining active after quitting, resolving uncontrolled log file growth (`pigport-stderr.log`) that could fill up disk drives.

### 2. ⌨️ Key Binding & Capture Fix in Controls Editor
- **Global Key Capture in Rebind Modal**: Fixed an issue in the visual Controls Editor where pressing a key or clicking a mouse button inside the "Set Key" dialog failed to register or bind the key. Events are now reliably captured during the event capture phase.
- **Enhanced Keyboard & Mouse Binding**: Smoothly bind any key on the keyboard, Numpad, and mouse buttons (LMB, RMB, MMB) to controls widgets without interference from background editor listeners.

### 3. 🚀 Android Launch Crash Detection Improvements
- **Startup Grace Period**: Added a 4-second grace period and direct `pidof` verification during Android activity launches.
- **No More False Positive Crash Alerts**: Fixes false-positive "process exited immediately" warnings on apps that fork or switch activities quickly during initialization.

### 4. 📖 Updated Controls & Setup Documentation
- **Controls & Keymapping Guide**: Added comprehensive visual and text guides for WASD, Numpad, Mouse Look, and Gamepad controller mappings in the official docs in English and Vietnamese.

---

## 🌟 What's New in v0.2.5

### 1. 🎮 Gamepad & Controller Support
- **Full Controller Compatibility**: Play using Xbox, PlayStation (DualShock / DualSense), Nintendo Switch Pro, or MFi controllers via USB or Bluetooth.
- **Dual Stick Analog Control**:
  - **Left Stick**: Drives on-screen movement joystick proportionally with adjustable dead zone.
  - **Right Stick**: Smoothly controls camera/mouse look area with configurable speed multiplier.
- **Controller Button Mapping**: Map any controller button (Pad A, B, X, Y, LB, RB, LT, RT, D-pad, L3, R3, Menu, View) directly to touches or actions.
- **Unified Across Platforms**: Works seamlessly in both the desktop player (scrcpy) and the native iOS runner (`PlayBridgeInput.dylib`).

### 2. 🔢 Numpad & Quick Joystick Presets
- **Full Numpad Support**: Support for all Numpad keys (Num 0-9, Num ., Num *, Num +, Num -, Num /, Num Enter, Num Clear).
- **One-Tap Directional Layouts**: Switch joystick controls instantly between **WASD**, **Numpad (8/4/2/6)**, **Arrow Keys (↑/←/↓/→)**, and **D-pad** in both desktop and ⌘K in-game editors.

### 3. 📱 Wireless Phone Connections & AirPlay
- **Wireless Android Debugging (Wi-Fi ADB)**: Automatically discover and pair physical Android phones on the local network via mDNS without USB cables.
- **iPhone / iPad AirPlay Screen Mirroring**: View iOS device screens wirelessly on your Mac or Windows PC (native receiver on macOS, bundled UxPlay on Windows).

### 4. 🌐 Official Landing Page & Typography
- **Modern Landing Page**: Launched at [pigtinylabs.github.io/PigPort/](https://pigtinylabs.github.io/PigPort/) featuring Genshin Impact, Identity V, and Honkai: Star Rail.
- **Be Vietnam Pro Typography**: Crystal-clear Vietnamese typography with native diacritics support.

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
| **Mac Apple Silicon (M1/M2/M3/M4)** | `PigPort-0.2.6-mac-arm64.dmg` | **Both iOS (IPA)** and **Android (APK/XAPK)** |
| **Mac Intel (x64)** | `PigPort-0.2.6-mac-x64.dmg` | Android (APK/XAPK) |
| **Windows (x64)** | `PigPort-0.2.6-win-x64.exe` or portable `.zip` | Android (APK/XAPK) |

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

## 🌟 Điểm nổi bật trong bản cập nhật v0.2.6

### 1. 🪟 Tắt Sạch Máy Ảo Trên Windows & Ngăn Tràn Dung Lượng Ổ Đĩa
- **Dọn dẹp triệt để tiến trình chạy ngầm**: Tự động tắt sạch máy ảo Android (`qemu-system-*`) và ADB server ngay khi người dùng đóng cửa sổ PigPort trên Windows.
- **Khắc phục lỗi đầy ổ cứng do log**: Chấm dứt tình trạng tiến trình giả lập tiếp tục chạy ngầm vô hạn sau khi thoát app, gây ghi tràn file log (`pigport-stderr.log`) chiếm dụng hàng chục gigabyte ổ đĩa.

### 2. ⌨️ Sửa Lỗi Gán Phím (Key Binding) Trong Trình Chỉnh Sửa Phím
- **Bắt phím chuẩn xác trong hộp thoại Set Key**: Khắc phục lỗi bấm phím bàn phím hoặc click chuột mà không gán được phím khi cấu hình Controls Editor. Sử dụng capture phase ở cấp độ window giúp nhận diện tức thì mọi phím bấm và nút chuột.
- **Hỗ trợ đầy đủ phím bấm**: Gán mượt mà mọi phím chữ, phím số Numpad, chuột trái/phải/giữa mà không bị xung đột với các sự kiện nền.

### 3. 🚀 Cải Tiến Nhận Diện Khởi Động Game Android
- **Thời gian chờ khởi động (Grace Period)**: Bổ sung 4 giây theo dõi và kiểm tra trực tiếp qua `pidof` khi khởi chạy package Android.
- **Loại bỏ cảnh báo crash sai**: Khắc phục hoàn toàn tình trạng báo lỗi "game thoát ngay sau khi mở" đối với các tựa game phân tách tiến trình (fork/splash screen) khi khởi động.

### 4. 📖 Bổ Sung Hướng Dẫn Điều Khiển & Phím Tắt
- **Tài liệu hướng dẫn trực quan**: Bổ sung chi tiết hướng dẫn gán phím di chuyển WASD, Numpad, lia góc nhìn chuột 360° và kết nối tay cầm Gamepad trên trang tài liệu [pigtinylabs.github.io/PigPort/](https://pigtinylabs.github.io/PigPort/) (song ngữ Anh - Việt).

---

## 🌟 Điểm nổi bật trong bản cập nhật v0.2.5

### 1. 🎮 Hỗ Trợ Tay Cầm Chơi Game (Gamepad / Controller)
- **Hỗ trợ đa dạng tay cầm:** Chơi mượt mà với tay cầm Xbox, PlayStation (DualShock / DualSense), Nintendo Switch Pro hoặc MFi qua Bluetooth / USB.
- **Cần gạt Analog 2 bên (Dual Stick):**
  - **Cần trái (Left stick):** Điều hướng cụm joystick di chuyển mượt mà theo tỷ lệ góc và lực đẩy, có thể chỉnh vùng chết (deadzone).
  - **Cần phải (Right stick):** Xoay góc nhìn camera / chuột 360° với hệ số tốc độ tùy chỉnh.
- **Gán nút tay cầm toàn diện:** Gán nút A, B, X, Y, LB, RB, LT, RT, D-pad, L3, R3, Menu, View trực tiếp vào các điểm chạm trên màn hình hoặc hướng di chuyển.
- **Hoạt động đồng bộ:** Hỗ trợ cả trên player Android (scrcpy) lẫn runner native iOS (`PlayBridgeInput.dylib`).

### 2. 🔢 Hỗ Trợ Bàn Phím Số (Numpad) & Preset Joystick Nhanh
- **Đầy đủ phím Numpad:** Nhận diện toàn bộ phím số (Num 0-9, Num ., Num *, Num +, Num -, Num /, Num Enter, Num Clear).
- **Chuyển đổi layout 1 chạm:** Chuyển đổi nhanh 4 hướng joystick giữa **WASD**, **Numpad (8/4/2/6)**, **Phím mũi tên (↑/←/↓/→)**, và **D-pad tay cầm** trong cả trình chỉnh sửa desktop và overlay ⌘K trên iOS.

### 3. 📱 Kết Nối Điện Thoại Không Dây & AirPlay
- **Ghép nối Android qua Wi-Fi (Wireless ADB):** Tự động dò tìm và ghép nối điện thoại Android qua mạng nội bộ bằng mDNS không cần cắm cáp USB.
- **Xem màn hình iPhone / iPad qua AirPlay:** Chiếu màn hình thiết bị Apple lên máy tính Mac hoặc Windows qua AirPlay không dây.

### 4. 🌐 Trang Landing Page Chính Thức & Font Chữ Chuẩn
- **Trang chủ mới:** Trải nghiệm tại [pigtinylabs.github.io/PigPort/](https://pigtinylabs.github.io/PigPort/) với các tựa game Genshin Impact, Identity V, Honkai: Star Rail.
- **Font Be Vietnam Pro:** Khắc phục triệt để lỗi vỡ chữ tiếng Việt, hiển thị sắc nét trên mọi màn hình Retina.

---

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
