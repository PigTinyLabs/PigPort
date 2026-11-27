# PigPort IPA

PigPort IPA mở các gói iOS arm64 chưa mã hóa trên Mac Apple Silicon chạy macOS 13.5 trở lên. Thư viện và dữ liệu game nằm trong thư mục riêng của PigPort IPA.

1. Kéo tệp `.ipa` vào cửa sổ hoặc chọn tệp.
2. Xem kiến trúc và trạng thái tương thích. Với gói hợp lệ, bấm **Cài đặt**.
3. Bấm **Mở** trong thư viện để chạy ứng dụng. **Finder** mở vị trí bản cài.

PigPort IPA kiểm tra mã hóa FairPlay trước khi cài và giữ nguyên tệp IPA gốc. Khả năng chạy còn phụ thuộc vào framework, dịch vụ và tính năng iOS mà từng ứng dụng sử dụng.

## Tải tệp từ App Store

Mở mục **App Store** và đăng nhập Apple trong Terminal. Trở về PigPort IPA để kiểm tra đăng nhập, tìm ứng dụng và chọn nơi lưu tệp IPA. Tài khoản Apple cần có quyền tải ứng dụng đã chọn. Tệp giữ nguyên dữ liệu Apple cung cấp, có thể bao gồm mã hóa FairPlay và địa chỉ email gắn với tài khoản tải. [IPATool](https://github.com/majd/ipatool/tree/v2.8.1)

## Build

Chạy từ thư mục gốc của kho mã trên Mac Apple Silicon với Node 26 và Rust.

```sh
npm ci
npm run dist:ipa
```

Bản build nằm tại `ipa-launcher/src-tauri/target/release/bundle/macos/PigPort IPA.app`. App đóng gói sẵn trình xử lý IPA và có thể mở trực tiếp trên máy build.
