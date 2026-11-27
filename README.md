# 🐷 PigPort

<p align="center">
  <img src="build/icon.png" width="128" alt="PigPort Logo">
  <br>
  <b>Play iOS & Android Games on Mac & Windows with Keyboard & Mouse</b>
  <br>
  <i>Crafted with ❤️ by PigTinyLabs</i>
  <br><br>
  <a href="https://pigtinylabs.github.io/PigPort/"><img src="https://img.shields.io/badge/Website-Official%20Site-f48fb1?style=flat&logo=safari&logoColor=white" alt="Official Website"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://paypal.me/pigtiny" target="_blank"><img src="https://img.shields.io/badge/Donate%20a%20coffee-PayPal-FFDD00.svg?logo=buy-me-a-coffee&logoColor=black" alt="Donate a coffee"></a>
</p>

<p align="center">
  <b>English</b> | <a href="README.vi.md">Tiếng Việt</a>
</p>

---

## 🎮 Introduction

**PigPort** is a modern, cross-platform mobile game launcher that brings your favorite **iOS (.ipa)** and **Android (.apk, .xapk)** games directly to your desktop. With low-latency hardware-accelerated rendering and an intuitive visual keymapping system, PigPort delivers a seamless, PC-grade gaming experience on both macOS and Windows.

---

## 📥 Downloads (v0.2.6)

| Platform | Recommended Installer | Alternative Portable | Supported Games |
|---|---|---|---|
| **macOS Apple Silicon (M1/M2/M3/M4)** | [⬇️ `PigPort-0.2.6-mac-arm64.dmg`](https://github.com/PigTinyLabs/PigPort/releases/download/v0.2.6/PigPort-0.2.6-mac-arm64.dmg) | [📦 `PigPort-0.2.6-mac-arm64.zip`](https://github.com/PigTinyLabs/PigPort/releases/download/v0.2.6/PigPort-0.2.6-mac-arm64.zip) | **Both iOS (.IPA)** and **Android (.APK / .XAPK)** |
| **macOS Intel (x64)** | [⬇️ `PigPort-0.2.6-mac-x64.dmg`](https://github.com/PigTinyLabs/PigPort/releases/download/v0.2.6/PigPort-0.2.6-mac-x64.dmg) | [📦 `PigPort-0.2.6-mac-x64.zip`](https://github.com/PigTinyLabs/PigPort/releases/download/v0.2.6/PigPort-0.2.6-mac-x64.zip) | Android (.APK / .XAPK) |
| **Windows 10/11 (x64)** | [⬇️ `PigPort-0.2.6-win-x64.exe`](https://github.com/PigTinyLabs/PigPort/releases/download/v0.2.6/PigPort-0.2.6-win-x64.exe) | [📦 `PigPort-0.2.6-win-x64.zip`](https://github.com/PigTinyLabs/PigPort/releases/download/v0.2.6/PigPort-0.2.6-win-x64.zip) | Android (.APK / .XAPK) + AirPlay Viewer |

> 💡 *Looking for all past builds or checksums? Check the official [GitHub Releases](https://github.com/PigTinyLabs/PigPort/releases) page.*

---

## ⚡ Highlights & Features

- 🎯 **One-Click Drag & Drop**: Drag and drop `.ipa`, `.apk`, or `.xapk` files straight into PigPort to install and organize games in your persistent library.
- 📦 **Full XAPK Support**: Automatically extracts Split APK bundles and copies graphical OBB expansion data without manual file management.
- ⌨️ **Visual Keymap Editor**:
  - Customize on-screen controls in real time (click the **🎮 Controls** button on any game card or press **⌘K** while playing).
  - Responsive **WASD Joystick** for fluid movement in MOBAs and RPGs.
  - **Mouse Look** with 360° camera rotation for FPS and Battle Royale games.
  - Support for single-key taps, mouse buttons (LMB/RMB/MMB), and customizable sensitivity.
- 🍎 **Native iOS Playback on Apple Silicon**: Run unencrypted iPhone & iPad (IPA) games directly on Mac with Apple Silicon (M1/M2/M3/M4) utilizing native GPU performance.
- 🤖 **Optimized Android Runtime**: Automatic setup and configuration of lightweight Android virtual environments for instant gameplay.
- 🖥️ **Pixel-Perfect Aspect Ratios**: Automatically fits the game's native render size without stretching or distortion, supporting crisp full-screen playback.

---

## 🖥️ Platform Support

| Feature | macOS (Apple Silicon M1/M2/M3/M4) | macOS (Intel x64) | Windows (x64) |
|---|:---:|:---:|:---:|
| **iOS Games (.ipa)** | ✅ Native & Smooth | ❌ Not supported | ❌ Not supported |
| **Android Games (.apk, .xapk)** | ✅ Supported | ✅ Supported | ✅ Supported |
| **Visual Controls Editor** | ✅ Available | ✅ Available | ✅ Available |
| **Drag & Drop Installer** | ✅ Available | ✅ Available | ✅ Available |

---

## 🕹️ Getting Started

### 1. Add Games to Library
- Launch **PigPort**.
- Drag and drop your `.ipa`, `.apk`, or `.xapk` game file into the app, or click **Install IPA / APK / XAPK**.
- The game will be installed and displayed with its official artwork and version details in your Library.

### 2. Start Playing
- Click **▶ Play** on the game card to launch.
- For an APK or XAPK installed on built-in Android, **Play** opens the game in a separate emulator window and skips video streaming. Use **Play with controls** to play inside PigPort with your keyboard and mouse mappings. On Apple Silicon, the automatic graphics mode tries hardware ANGLE first. Automatic resolution uses 800 × 500 on an M1 or an 8 GB Mac and 960 × 600 on other Apple Silicon Macs. You can change the resolution in Settings.
- **Hardware OpenGL** in Settings can resume a recent Quick Boot snapshot on Apple Silicon when the emulator saved one successfully. Close the emulator window normally to let it save. Some games using Vulkan require a cold boot.
- For games that sign in with Google, click **Set up Google Play** in Game library and review Google's license. PigPort creates a separate device and opens the Play Store so you can sign in. Select **Android with Google Play** and install the game on that device. Your original Android device keeps its installed games and local saves.

### 3. Customize Controls (Keymapping)
- Click the **🎮 Controls** button on the game card or press **⌘K** during gameplay to open the editor:
  - **+ Button**: Add an on-screen tap button (assign any keyboard key or mouse button).
  - **+ Joystick**: Place a 4-direction WASD movement joystick with adjustable radius.
  - **+ Mouse look**: Define a free-look camera zone (toggle mouse lock with the `` ` `` key).
- Drag bindings to match on-screen skills/buttons and click **Save** to apply immediately!

### 4. View an iPhone Screen (view only)
Open **iPhone & iPad → View iPhone screen**. On the iPhone (same Wi-Fi), open Control Center → **Screen Mirroring** and pick the name PigPort shows. No app is needed on the iPhone. iOS does not let another device control the phone, so this is for watching only; to play iOS games with keyboard and mouse, install the IPA on a Mac.
- **macOS:** uses the built-in AirPlay Receiver (System Settings → General → AirDrop & Handoff).
- **Windows:** click **Start receiver** and allow it on private networks if Windows asks. This uses [UxPlay](https://github.com/FDH2/UxPlay) (GPLv3), bundled as a separate program in `resources/airplay` together with its license and source notice; it is built in CI by `scripts/build-uxplay-windows.sh`.

### 5. Use an Android Phone over Wi-Fi (optional)
Android games run on the built-in Android device. To mirror and play on your own phone instead, put it on the same Wi-Fi and click **Connect a phone over Wi-Fi…** under Device. No app is needed on the phone:
- **Android 11+:** Settings → Developer options → **Wireless debugging** → **Pair device with pairing code**, then enter the address and 6-digit code in PigPort.
- **Android 10 and older:** connect by USB once, select the phone under Device, and click **Switch selected device to Wi-Fi**.

---

## 🛠️ Developer Setup (Build from Source)

Tauri and Rust manage the desktop window and Android screen mirroring. PigPort bundles a Node helper for package installation, IPA conversion, and storage. Installed builds include the helper and run without a separate Node installation.

### Prerequisites

- Node.js 26 or later and a current stable Rust toolchain.
- macOS 13.5 or later with Xcode Command Line Tools, or Windows x64 with the MSVC C++ build tools and WebView2. [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Installation
```bash
npm ci
npm run fetch:scrcpy-server
```

### Run Locally
```bash
npm start
```

### Run Tests
```bash
npm test
npm run build:desktop
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

### Packaging / Distribution

Run the command for your build machine’s operating system and architecture.

```bash
# Apple silicon Mac
npm run dist:mac -- --target aarch64-apple-darwin

# Intel Mac
npm run dist:mac -- --target x86_64-apple-darwin

# Windows x64
npm run dist:win -- --target x86_64-pc-windows-msvc
```

Tauri writes bundles under `src-tauri/target/<target>/release/bundle/`. To produce files named like the GitHub releases, run `node scripts/stage-release.mjs <target>` after building. Extract the full Windows portable ZIP before opening `PigPort.exe`, since the launcher needs the neighboring helper and resources.

---

## 📄 License
- Developed and maintained by **PigTinyLabs**.
- Released as open source under the [MIT License](LICENSE).
