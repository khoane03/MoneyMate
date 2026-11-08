# MoneyMate

MoneyMate là ứng dụng quản lý tài chính cá nhân và chi tiêu nhóm, xây dựng theo hướng ưu tiên tiếng Việt, VND và thiết bị di động. Ứng dụng chạy dưới dạng Progressive Web App (PWA), có thể cài trên trình duyệt được hỗ trợ.

## Công nghệ

- **Giao diện:** React 19, TypeScript strict, Vite, React Router, Tailwind CSS, Lucide.
- **Biểu mẫu và trạng thái:** React Hook Form, Zod và Zustand.
- **Dữ liệu trên thiết bị:** Dexie và IndexedDB; service worker hỗ trợ trải nghiệm PWA.
- **Backend:** Supabase Auth, PostgreSQL, Row Level Security (RLS), Storage và Edge Functions.
- **Hóa đơn và báo cáo:** Tesseract.js cho OCR tiếng Việt chạy trên thiết bị; Recharts cho biểu đồ.

## Tính năng

- Quản lý ví tiền mặt, ngân hàng và ví điện tử; ghi thu, chi, chuyển ví và xem số dư.
- Theo dõi khoản vay và trả nợ theo từng khoản, có thể chia sẻ thông tin khoản vay với thành viên đã kết nối.
- Lập ngân sách, xem báo cáo thu chi và xuất dữ liệu giao dịch CSV.
- Tạo không gian chia sẻ, lập đề xuất chia hóa đơn theo thành viên, theo dõi xác nhận và quyết toán.
- Gửi yêu cầu thanh toán và nhận thông báo trong ứng dụng.
- Chụp hóa đơn hoặc chọn ảnh để nhận diện nội dung bằng OCR. Kết quả nhận diện là gợi ý để người dùng xem lại trước khi lưu.
- Ghi Check-in chi tiêu kèm ảnh; có thể chủ động chia sẻ với nhóm và xem các Check-in đã chia sẻ trong bảng tin dạng thẻ.
- Xem ảnh hóa đơn và ảnh minh chứng ngay trong ứng dụng.
- Giao diện đáp ứng từ điện thoại đến máy tính, có giao diện sáng/tối và hỗ trợ cài đặt PWA.

> Quyền truy cập dữ liệu riêng tư và dữ liệu nhóm được kiểm soát bằng RLS. Chỉ dùng khóa Supabase công khai ở phía trình duyệt; tuyệt đối không đưa service-role key hoặc bí mật dịch vụ vào biến `VITE_*`.

## Chạy trên máy cá nhân

Yêu cầu Node.js 22 và npm.

1. Cài dependency:

   ```sh
   npm ci
   ```

2. Tạo file `.env.local` từ `.env.example`, sau đó khai báo `VITE_SUPABASE_URL` và `VITE_SUPABASE_PUBLISHABLE_KEY`. Có thể dùng Supabase local hoặc project đã cấu hình.

3. Nếu dùng Supabase local, khởi động Docker rồi chạy:

   ```sh
   npx supabase start
   npx supabase db reset
   ```

   Lệnh `db reset` tạo lại database local và áp dụng các migration trong `supabase/migrations`.

4. Khởi động ứng dụng:

   ```sh
   npm run dev
   ```

## Lệnh thường dùng

```sh
npm run dev        # Chạy máy chủ phát triển
npm run typecheck  # Kiểm tra kiểu TypeScript
npm run lint       # Kiểm tra quy tắc mã nguồn
npm run build      # Tạo bản build production trong dist/
```

## Deploy lên Vercel

Repository đã có `vercel.json` để build bằng Node.js 22, xuất bản thư mục `dist/`, xử lý deep link của React Router và thêm một số HTTP security headers. Có thể kết nối repository với Vercel để tạo Preview Deployment từ các nhánh và Production Deployment từ nhánh production.

Trong Vercel Project Settings, khai báo `VITE_SUPABASE_URL` và `VITE_SUPABASE_PUBLISHABLE_KEY` cho môi trường tương ứng. Nên trỏ Preview vào Supabase project riêng để tránh thao tác thử trên dữ liệu tài chính production. Sau khi có URL production, đặt URL đó làm Supabase Auth `Site URL` và thêm các redirect URL cần thiết; kiểm tra lại xác nhận email và khôi phục mật khẩu.

GitHub Actions chạy typecheck, lint và build trên push/PR. Cấu hình branch protection cho nhánh production để yêu cầu CI thành công trước khi merge. Khi kết nối repository với Vercel, chọn đúng nhánh production; các nhánh khác có thể dùng làm Preview.

Vercel cung cấp HTTPS cho domain của deployment. Với domain riêng, thêm domain vào project và hoàn tất DNS; Vercel cấp chứng chỉ SSL sau khi xác minh DNS thành công. Không cần đưa chứng chỉ hoặc private key SSL vào repository.

## Cấu hình ảnh và camera

Ảnh hóa đơn dùng Supabase Storage riêng tư. OCR chạy trong trình duyệt; lần đầu sử dụng cần tải engine và dữ liệu ngôn ngữ. Camera yêu cầu HTTPS hoặc `localhost`. Khi mở ứng dụng từ điện thoại trong mạng nội bộ, hãy phục vụ ứng dụng qua HTTPS với chứng chỉ được thiết bị tin cậy.
