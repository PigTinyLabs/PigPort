# PigPort

<img src="build/icon.png" width="128" alt="PigPort">

PigPort (trước đây là PlayBridge) là một sản phẩm của PigTinyLabs. Chơi game di động trên máy tính bằng bàn phím và chuột.

| Chức năng | macOS Apple Silicon | Windows x64 |
|---|---|---|
| Đọc IPA/APK, kéo thả, thư viện lưu lâu dài | Có | Có |
| Cài IPA trực tiếp bằng bộ chuyển đổi tích hợp | Thử nghiệm | Không có iOS runtime |
| Android runtime được app tải và tạo máy ảo | Đã triển khai; chưa kiểm thử tải/boot thật | Đã triển khai; chưa chạy trên Windows |
| Android keymap, stream game | Có trong mã | Có trong mã |
| Keymap trong game iOS (⌘K) | Thử nghiệm | Không áp dụng |

## Cài và chơi

Chạy app, kéo thả IPA/APK vào **Game library**, hoặc chọn **Install IPA / APK**. Game đã cài có **Uninstall**: app hỏi giữ dữ liệu game (bản vá đã tải, cài đặt, keymap) để cài lại nhanh hay xóa hết. Game iOS phải được tắt trước khi gỡ; game vẫn ở lại thư viện để cài lại. Bản mới không gửi IPA sang PlayCover và không mở trang Android Studio để yêu cầu tạo máy ảo.

### IPA trên Mac

Bộ cài tích hợp tự sao chép IPA vào thư mục tạm, kiểm tra archive, giải nén, chọn slice arm64, kiểm tra FairPlay, chuyển Mach-O sang Mac Catalyst, chuyển các đường dẫn framework hệ thống có bản iOSSupport, giữ cấu trúc bundle phẳng kiểu iOS (file thực thi và tài nguyên ở gốc `.app`), ký ad-hoc và kiểm tra chữ ký. Game được lưu trong thư mục dữ liệu riêng của app (`ios/Applications/<bundle-id>.app`). Chỉ thay thế bản game cũ sau khi bản mới đã chuyển đổi và ký xong. Bấm **Play** để mở; game tương thích sẽ tự mở sau cài.

Khi **Play**, app tạo bản clone APFS (tức thì, không tốn thêm dung lượng) của game trong thư mục cache người dùng (`/private/var/folders/…/C/io.playbridge.ios`) rồi mở bản đó. Lý do: nhiều engine iOS (ví dụ NeoX của NetEase) tự thêm tiền tố `/private` vào đường dẫn app và thư mục home vì trên iOS app nằm dưới `/var`. Dữ liệu game (Documents, Library, tmp) nằm ở `ios/Containers/<bundle-id>` và được đưa vào game qua `CFFIXED_USER_HOME`, nên game không ghi vào `~/Documents` của bạn. Game cài bằng bản cũ hơn 0.2.2 (cấu trúc `Contents/`) cần bấm **Reinstall**.

**Đây là bộ chuyển đổi thử nghiệm, chưa tương đương toàn bộ PlayCover.** Không cần cài PlayCover, Xcode hay Command Line Tools cho người dùng cuối; bộ cài dùng các công cụ hệ thống có sẵn của macOS. Mã chuyển đổi được viết độc lập, không nhúng PlayCover/PlayTools. Có ánh xạ phím/chuột → chạm riêng của PigPort (xem **Điều khiển**), nhưng chưa có các bản vá tương thích khác của PlayTools, keychain/container chuyên biệt hoặc xử lý anti-cheat. Vì thế nhiều game vẫn có thể lỗi hoặc thoát dù cài và ký thành công. IPA phải không mã hóa, có generic arm64. Không hỗ trợ IPA arm64e-only, ZIP64, symlink trong archive; không giải mã FairPlay. Bản hiện tại giới hạn giải nén 16 GiB.

### APK trên Mac/Windows

Nếu chưa có thiết bị/AVD, lần cài APK đầu tiên mở hộp thoại thiết lập Android tích hợp. App đọc danh mục tải chính thức của Google, hiển thị dung lượng và nguyên văn điều khoản; bạn phải tự chọn đồng ý rồi mới tải. App tải **emulator + platform-tools + Android 35 AOSP system image**, kiểm tra checksum/kích thước, giải nén vào thư mục riêng, tạo AVD PigPort và khởi động không cửa sổ. Không cần tự cài Android Studio, Java hay BlueStacks. Bộ tải có thể tải vài GiB; app kiểm tra dung lượng trống trước khi bắt đầu. Chưa hỗ trợ pause/resume tải.

APK được đọc package ID, cài bằng ADB, xác nhận package đã cài rồi mở và stream vào player với keymap. Nếu có nhiều thiết bị, chọn rõ thiết bị ở thanh bên. Vẫn hỗ trợ máy ảo/điện thoại có sẵn.

Runtime dùng arm64-v8a trên Apple Silicon, x86_64 trên Windows x64/Intel Mac. Không kèm dịch ARM→x86, Google Play Services hay Google Play Store. Game chỉ có ARM sẽ không chạy trên runtime Windows x86_64; game yêu cầu Play Services/anti-cheat có thể không tương thích. Máy cần hỗ trợ ảo hóa phần cứng; app không tự thay đổi BIOS, Hyper-V hay bảo mật hệ thống. Windows ARM chưa hỗ trợ tải runtime tích hợp.

### IPA trên Windows

Chỉ nhập và đọc metadata; không có runtime iOS cục bộ hoặc stream qua Mac. Nút cài/chơi IPA bị vô hiệu hóa.

## Mức kiểm chứng

- Unit tests kiểm tra metadata, chuyển Mach-O, từ chối FairPlay, an toàn archive, chọn gói Android và nguồn tải, cùng các bài kiểm tra input/stream hiện có.
- `npm run test:ipa-native`: biên dịch IPA UIKit arm64 thật có framework nhúng, cài bằng engine mới, kiểm chữ ký, chạy binary để nạp UIKit/framework, cài lại và xác nhận bản cũ còn nguyên khi cập nhật lỗi. Chỉ máy chạy bài kiểm tra này mới cần Xcode/iOS SDK.
- Đã cài và kiểm chữ ký thành công với Identity V `com.netease.idv`, phiên bản `26.251.1550` (IPA 3,3 GiB). Bản 0.2.1 sửa lỗi ký resource-only `NgWebViewSDK.bundle`: chỉ ký binary/bundle có executable; tài nguyên được niêm phong bởi bundle cha. Có regression fixture cho trường hợp này.
- Identity V `26.251.1550` khởi động qua **Play**, chạy ổn định và vào tới bước tải bản vá trong game. Chưa kiểm tra gameplay, điều khiển hay đăng nhập. Bài kiểm tra UIKit (`npm run test:ipa-native`) vẫn là headless.
- Lớp điều khiển iOS: chạm đơn, chạm đa điểm (joystick + nút cùng lúc), mouse look, trình sửa ⌘K (thêm, gán phím, kéo, lưu) đã kiểm tra trên app Catalyst thử nghiệm. Trong Identity V đã xác nhận dylib được nạp, game chạy ổn định và ⌘K mở trình sửa; chưa thử điều khiển trong trận.
- Chưa tải/boot Android runtime thật: mạng của phiên chạy công cụ không phân giải được `dl.google.com`/GitHub. Parser và downloader được kiểm tra riêng; cần xác nhận end-to-end ở máy có mạng.
- Chưa build hoặc chạy trên Windows.

## Cài đặt để phát triển

Cần Node.js 22 trở lên.

```bash
npm install
```

npm 11 chặn script cài đặt của Electron, nên cần tải binary Electron một lần:

```bash
npm run setup:electron
```

Tải scrcpy-server (chạy trên thiết bị Android, phiên bản 5.0.1):

```bash
npm run fetch:scrcpy-server
```

Chạy ứng dụng:

```bash
npm start
```

Chạy test:

```bash
npm test
```

## adb

Khi runtime tích hợp đã được cài, app ưu tiên ADB của runtime (trừ đường dẫn Settings). Với thiết bị ngoài, app tìm `adb` theo thứ tự: đường dẫn trong Settings → `resources/platform-tools/` → `ANDROID_HOME` / `ANDROID_SDK_ROOT` → thư mục SDK mặc định (`~/Library/Android/sdk`, `%LOCALAPPDATA%\Android\Sdk`) → `PATH`.

Để đóng gói kèm adb, chép thư mục `platform-tools` của Android SDK (đúng hệ điều hành đích) vào `resources/platform-tools/`.

Máy ảo mở adb qua mạng thì bấm **Connect** ở thanh bên. Cổng hay gặp: LDPlayer/BlueStacks `127.0.0.1:5555`, MuMu `127.0.0.1:7555` hoặc `127.0.0.1:16384`, Nox `127.0.0.1:62001`.

## Điều khiển

- **Play** mở game trên thiết bị và bắt đầu stream.
- **Edit controls** để đặt điều khiển lên màn hình game:
  - **+ Button**: một phím bấm (hoặc chuột trái/phải/giữa) chạm vào một điểm.
  - **+ Joystick**: 4 phím (mặc định WASD) kéo ngón tay ảo quanh tâm.
  - **+ Mouse look**: khi bật chế độ nhìn bằng chuột (mặc định phím `` ` ``), di chuột sẽ kéo vùng này để xoay camera.
- Kéo để di chuyển, chọn một ô phím rồi bấm phím cần gán, Delete để xóa, **Save** để lưu.
- Ngoài chế độ nhìn bằng chuột, click chuột trái lên màn hình là chạm trực tiếp.
- Mỗi game có keymap riêng, lưu ở thư mục dữ liệu của app (`keymaps/<package>.json`). Có thể Import/Export để chia sẻ.

### Game iOS

Khi bấm **Play**, PigPort nạp lớp điều khiển `PlayBridgeInput.dylib` vào game (qua `DYLD_INSERT_LIBRARIES`; không sửa binary game, không cần cài lại). Lớp này dùng cùng định dạng và cùng file keymap với Android.

- **⌘K** trong game mở trình sửa: **+ Button**, **+ Joystick**, **+ Mouse look**; kéo để di chuyển; click một nút (hoặc một hướng W/A/S/D của joystick) rồi bấm phím để gán, chuột phải/giữa hoặc **Left click** để gán nút chuột; **Bigger/Smaller**, **Sens ±**; **Look key** đổi phím bật mouse look. **⌘K** hoặc **Save** để lưu, **Esc** để hủy.
- Phím `` ` `` (mặc định) bật/tắt mouse look: con trỏ ẩn, di chuột kéo vùng camera, nút chuột dùng cho các nút đã gán. **Esc** để thoát.
- Ngoài mouse look, click trái là chạm trực tiếp. Phím chưa gán và tổ hợp ⌘ vẫn đi tới game; khi đang gõ vào ô chữ, phím không bị ánh xạ.
- Khung hình tự khớp theo game: lớp điều khiển đo bộ đệm vẽ thật của game (Metal drawable). Game vẽ cố định một kích thước thì cửa sổ khóa theo đúng tỉ lệ đó; game vẽ theo cửa sổ (Unity) thì cửa sổ khóa theo tỉ lệ màn hình thiết bị, đúng hướng game hỗ trợ. Kéo giãn hay bấm phóng to thì game phóng theo, không méo, không viền. Ở chế độ toàn màn hình trên máy có notch, tỉ lệ có thể lệch nhẹ.
- Game chỉ chơi ngang: Mac luôn báo giao diện dọc, nên PlayBridge báo hướng ngang cho code của game, báo `UIScreen.nativeBounds` theo chiều dọc như iOS, và gửi sự kiện xoay sang ngang như iPad làm lúc mở game (Unity cũ chỉ đổi hướng khi nhận sự kiện này; thiếu nó Arena of Valor vẽ khung dọc 831×1280 rồi kéo giãn, hình méo và mờ).
- **Giả lập môi trường iPad / iPhone**: Mặc định, nhiều engine và game iOS kiểm tra để chặn môi trường PC/Mac (Catalyst). Lớp điều khiển tự động giả lập định danh thiết bị iOS:
  - Báo `isMacCatalystApp = NO` và `isiOSAppOnMac = NO` cho code của game.
  - Báo `UIDevice.userInterfaceIdiom` là iPad (`UIUserInterfaceIdiomPad`), model `"iPad"`, hệ điều hành `"iPadOS"`. Với game chỉ dành riêng cho iPhone (`UIDeviceFamily = [1]`), app tự động chuyển sang cấu hình iPhone (`UIUserInterfaceIdiomPhone`, `"iPhone"`, `"iOS"`). Có thể ghi đè thủ công bằng biến môi trường `PLAYBRIDGE_DEVICE_TYPE=iphone` hoặc `ipad`.
  - Interpose các lệnh gọi cấp thấp: `sysctlbyname("hw.machine")`, `sysctlbyname("hw.model")`, `sysctl(CTL_HW)`, `uname` để báo mã máy thật (`iPad13,8` hoặc `iPhone14,2`), và chặn `MobileGestalt` (`MGCopyAnswer`).
  - Swizzle `NSBundle` để giấu cờ `CFBundleSupportedPlatforms = MacOSX` khi game đọc `Info.plist` trong bộ nhớ.
- Chẩn đoán: thông số hiển thị đo được ghi ở `ios/Containers/<bundle-id>/Library/Caches/PlayBridge-display.txt`; tạo file `PlayBridge-snapshot.request` cùng thư mục để nhận ảnh chụp `PlayBridge-snapshot.png`. Độ phân giải vẽ do game tự chọn; nếu file báo "upscaled", hãy tăng độ phân giải/đồ họa trong cài đặt của game.
- Game nạp code lạ có thể bị hệ thống chống gian lận phát hiện. Dùng trên tài khoản của bạn với rủi ro tự chịu.

## Đóng gói

```bash
npm run dist:mac
```

```bash
npm run dist:win
```

Bản Windows nên được build trên máy Windows. Kết quả nằm trong `release/`. `npm run build` tự biên dịch `resources/ios-input/PlayBridgeInput.dylib` trên Mac (cần Command Line Tools trên máy build; người dùng cuối không cần); `npm run build:ios-input` để biên dịch lại. Chạy `npm run fetch:scrcpy-server` trước khi đóng gói để scrcpy-server được đưa vào bản build.

### Đóng gói và ký

Cấu hình nằm ở `electron-builder.config.cjs`; cách ký được chọn tự động theo chứng chỉ có trên máy build.

| | Có chứng chỉ | Không có chứng chỉ |
|---|---|---|
| macOS | Ký Developer ID + hardened runtime (`build/entitlements.mac.plist`), notarize nếu có thông tin Apple → tải về mở bình thường | Ký ad-hoc toàn bộ app: chữ ký hợp lệ, nhưng lần đầu mở macOS vẫn chặn; người dùng vào **System Settings → Privacy & Security → Open Anyway** |
| Windows | Ký Authenticode | Không ký; SmartScreen hiện "Windows protected your PC" → **More info → Run anyway** |

Không có cách miễn phí nào để app tải từ Internet mở mà không bị cảnh báo: macOS cần chứng chỉ **Developer ID Application** (Apple Developer Program) và notarize; Windows cần chứng chỉ ký code (OV/EV hoặc Azure Trusted Signing).

Biến môi trường khi build tại máy:

- macOS: `CSC_LINK` (file `.p12`) + `CSC_KEY_PASSWORD`, hoặc chứng chỉ có sẵn trong Keychain; notarize với `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, hoặc `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
- Windows: `WIN_CSC_LINK` (file `.pfx`) + `WIN_CSC_KEY_PASSWORD`.

GitHub Actions:

- `nightly.yml`: mỗi lần push lên `main` (hoặc bấm chạy tay trong tab Actions) tự build và đăng bản **Nightly** (pre-release, phiên bản `<package.json>-nightly.<số lần chạy>`).
- `release.yml`: đẩy tag `v*` (ví dụ `git tag v0.2.3 && git push origin v0.2.3`) để build và tạo Release chính thức với phiên bản lấy từ tag.
- Cả hai dùng `build.yml`: xuất `PigPort-<phiên bản>-mac-arm64.dmg/.zip` (Mac chip Apple, chơi được IPA và APK), `PigPort-<phiên bản>-mac-x64.dmg/.zip` (Mac Intel, chỉ APK) và bản Windows `.exe` (cài đặt + portable).
- Secrets tùy chọn để ký: `MAC_CERTS` (base64 của `.p12`), `MAC_CERTS_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CERTS` (base64 của `.pfx`), `WIN_CERTS_PASSWORD`.

Kiểm tra bản macOS trước khi phát hành: `codesign --verify --deep --strict release/mac-arm64/PigPort.app` và `spctl -a -vv release/mac-arm64/PigPort.app` (chỉ báo `accepted` khi đã ký Developer ID và notarize).

Đổi tên từ PlayBridge: dữ liệu (thư viện, game đã cài, keymap) vẫn ở thư mục `PlayBridge` trong Application Support; các định danh nội bộ như `PlayBridgeInput.dylib`, `PLAYBRIDGE_*`, `io.playbridge.ios` được giữ để không làm hỏng game đã cài. Logo gốc: `build/icon.svg` (xuất `build/icon.png`, `build/icon.icns`).

## Cấu trúc

```
src/main/android/adb.ts      gọi adb: thiết bị, cài/gỡ APK, mở app
src/main/android/scrcpy.ts   giao thức scrcpy v5: stream video H.264, gửi chạm/phím
src/main/packages/          đọc cấu trúc IPA/APK và plist XML/binary
src/main/runtime/ipa.ts     bộ cài IPA trực tiếp và ký bundle macOS
src/main/runtime/macho.ts   chuyển binary iOS ARM64 sang Mac Catalyst
src/native/ios-input/        lớp điều khiển nạp vào game iOS: phím/chuột → chạm đa điểm, trình sửa ⌘K
src/main/runtime/managedAndroid.ts tải Android và tạo AVD riêng
src/main/mac/iosApps.ts      liệt kê app iPhone/iPad từ Mac App Store
src/main/main.ts             cửa sổ Electron và IPC
src/shared/keymap.ts         định dạng keymap + TouchMapper (phím/chuột → chạm)
src/renderer/                giao diện: thư viện game, player (WebCodecs), trình sửa keymap
```

scrcpy-server thuộc dự án [scrcpy](https://github.com/Genymobile/scrcpy) (Apache 2.0). Phiên bản client và server phải khớp nhau; muốn đổi phiên bản thì chạy `node scripts/fetch-scrcpy-server.mjs <version>` và kiểm tra lại giao thức trong `scrcpy.ts`.
