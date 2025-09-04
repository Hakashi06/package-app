QR Packaging Recorder (Electron)

Tính năng
- Quét mã QR bằng máy scan (kiểu bàn phím) để Bắt đầu/Dừng ghi hình.
- Ghi hình từ Camera USB (getUserMedia) hoặc IP camera (RTSP) qua FFmpeg.
- Lưu video với tên theo Mã đơn + Tên nhân viên + thời gian, đuôi .mp4.
- Chọn thư mục lưu (có thể là ổ mạng/NAS đã mount vào hệ thống).
- Ghi log phiên làm việc và hiển thị thời gian đóng gói trung bình theo tháng.

Yêu cầu
- Node.js LTS.
- FFmpeg có sẵn trong PATH nếu dùng RTSP hoặc cần chuyển đổi WebM → MP4.
  - macOS: brew install ffmpeg
  - Windows: cài ffmpeg và thêm vào PATH
  - Linux: apt/yum install ffmpeg

Chạy dự án
1) Cài dependencies:
   npm install
2) Chạy app:
   npm run start

Sử dụng
- Nhập tên nhân viên, chọn chế độ camera (USB/RTSP), chọn thư mục lưu.
- Với USB: cấp quyền camera/mic; xem preview.
- Với RTSP: nhập URL RTSP đầy đủ. Nếu camera xuất H264/AAC có thể chọn Copy (nhanh). Nếu lỗi, bật Transcode.
- Dùng máy scan quét mã QR chứa mã đơn (ví dụ có dạng order=ABC123 hoặc chỉ chuỗi ABC123):
  - Lần 1: bắt đầu ghi.
  - Lần 2 (cùng mã): dừng ghi và lưu file .mp4 vào thư mục đã chọn.

Gợi ý RTSP cho Imou
- Nhiều thiết bị Imou dùng tài khoản/verification code làm mật khẩu RTSP. Ví dụ (tham khảo, có thể khác theo model):
  rtsp://admin:VERIFY_CODE@<ip>:554/cam/realmonitor?channel=1&subtype=0
- Hãy kiểm tra tài liệu của thiết bị để có URL chính xác.

Ghi chú kỹ thuật
- USB: MediaRecorder sẽ cố gắng ghi trực tiếp MP4. Nếu môi trường không hỗ trợ, app sẽ ghi WebM rồi dùng FFmpeg để chuyển sang MP4.
- RTSP: FFmpeg ghi trực tiếp ra MP4. Chế độ Copy yêu cầu camera xuất H264/AAC. Nếu không, dùng Transcode.
- Log phiên được lưu ở thư mục userData của Electron (config.json, sessions.json).

