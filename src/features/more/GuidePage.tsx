import { Link } from 'react-router-dom'
import {
  ArrowRight, BarChart3, BookOpen, Camera, HandCoins, Landmark, ListChecks,
  LockKeyhole, ReceiptText, Target,
} from 'lucide-react'

const gettingStarted = [
  { title: 'Tạo ví', description: 'Thêm tiền mặt, tài khoản ngân hàng hoặc ví điện tử và nhập số dư hiện tại.', to: '/wallets', action: 'Mở Ví của tôi' },
  { title: 'Ghi khoản thu, chi hoặc chuyển tiền', description: 'Chọn đúng loại giao dịch và ví. Tiền chuyển giữa hai ví của bạn không tính là thu hay chi.', to: '/transactions?action=new', action: 'Ghi giao dịch' },
  { title: 'Theo dõi tổng quan', description: 'Xem số dư, thu chi và các khoản sắp đến hạn trên màn Tổng quan.', to: '/', action: 'Về Tổng quan' },
]

const topics = [
  {
    title: 'Ghi chép thu chi', icon: ReceiptText, to: '/transactions', action: 'Mở Giao dịch',
    details: [
      'Chọn Thu nhập hoặc Chi tiêu, nhập số tiền, ngày, ví và danh mục phù hợp.',
      'Khoản vay và trả nợ được ghi riêng để không nhầm tiền vay thành thu nhập hay tiền gốc thành chi tiêu thông thường.',
      'Bạn có thể sửa hoặc tìm giao dịch trong danh sách; số dư ví được tính từ các giao dịch đã ghi.',
    ],
  },
  {
    title: 'Chia tiền nhóm', icon: HandCoins, to: '/sharing', action: 'Mở Chia tiền',
    details: [
      'Kết nối với người cần chia sẻ, sau đó tạo khoản chi chung và thêm từng món.',
      'Chọn người chịu từng món. Mỗi người cần xác nhận phần của mình trước khi khoản chi được chốt.',
      'Chỉ ví của người thanh toán bị trừ. Phần chia tạo công nợ, không tạo thêm một khoản chi cá nhân cho người còn lại.',
      'Khi trả nợ cho nhau, gửi đề nghị thanh toán; số dư ví chỉ đổi khi người nhận xác nhận.',
    ],
  },
  {
    title: 'Chụp ảnh và quét hóa đơn', icon: Camera, to: '/receipts', action: 'Mở Hóa đơn & OCR',
    details: [
      'Chụp hoặc chọn ảnh hóa đơn để đọc nội dung. Bạn cần kiểm tra lại tên món, số lượng và tổng tiền trước khi lưu.',
      'OCR chỉ gợi ý thông tin; giao dịch chưa được ghi cho đến khi bạn xác nhận.',
      'Muốn ghi nhanh một khoản chi có ảnh, dùng Check-in chi tiêu trong mục Khác.',
    ],
  },
  {
    title: 'Ngân sách và khoản chi dự kiến', icon: Target, to: '/budgets', action: 'Mở Ngân sách',
    details: [
      'Đặt hạn mức theo danh mục hoặc cho toàn bộ chi tiêu tháng.',
      'Thêm khoản sắp phải trả vào Khoản chi dự kiến. Khoản này chưa trừ ví và chưa tính là chi thực tế.',
      'Khi đã thanh toán, chọn “Đã chi”, kiểm tra số tiền, ngày và ví rồi xác nhận để ghi một giao dịch thực tế.',
    ],
  },
  {
    title: 'Theo dõi khoản vay', icon: Landmark, to: '/loans', action: 'Mở Vay & Trả nợ',
    details: [
      'Ghi khoản vay và chọn có ảnh hưởng đến ví hay chỉ theo dõi dư nợ.',
      'Khi trả gốc, chọn đúng khoản vay để cập nhật phần còn nợ. Tiền trả gốc là một loại giao dịch riêng.',
      'Chia sẻ khoản vay là tùy chọn; ví và các giao dịch riêng của bạn vẫn được giữ riêng tư.',
    ],
  },
  {
    title: 'Báo cáo và danh mục', icon: BarChart3, to: '/reports', action: 'Mở Báo cáo',
    details: [
      'Báo cáo tổng hợp các giao dịch theo ngày và danh mục.',
      'Chuyển tiền giữa ví và khoản công nợ đã trả không được tính thành thu nhập hoặc chi tiêu mới.',
      'Bạn có thể thêm hoặc đổi danh mục trong mục Khác để phù hợp cách ghi chép của mình.',
    ],
  },
]

export function GuidePage() {
  return (
    <section className="guide-page" aria-labelledby="guide-title">
      <header className="guide-hero">
        <span className="guide-hero-icon"><BookOpen size={22} aria-hidden="true" /></span>
        <div>
          <p className="eyebrow">TRỢ GIÚP MONEYMATE</p>
          <h1 id="guide-title">Hướng dẫn sử dụng</h1>
          <p>Những bước cơ bản để ghi chép, chia tiền và theo dõi tài chính của bạn.</p>
        </div>
      </header>

      <section className="guide-start" aria-labelledby="guide-start-title">
        <header className="guide-section-heading">
          <span className="guide-section-icon"><ListChecks size={19} aria-hidden="true" /></span>
          <div><p className="eyebrow">BẮT ĐẦU</p><h2 id="guide-start-title">Thiết lập trong vài bước</h2></div>
        </header>
        <ol className="guide-start-list">
          {gettingStarted.map((step, index) => (
            <li key={step.title}>
              <span className="guide-step-number" aria-hidden="true">{index + 1}</span>
              <div><h3>{step.title}</h3><p>{step.description}</p><Link to={step.to} className="guide-text-link">{step.action}<ArrowRight size={15} aria-hidden="true" /></Link></div>
            </li>
          ))}
        </ol>
      </section>

      <section className="guide-topics" aria-label="Hướng dẫn các tính năng">
        {topics.map(({ title, icon: Icon, to, action, details }) => {
          const topicId = `guide-topic-${to.replace(/[^a-z0-9]+/gi, '-')}`
          return (
            <article className="guide-topic-card" key={title} aria-labelledby={topicId}>
              <header><span className="guide-topic-icon"><Icon size={19} aria-hidden="true" /></span><div><h2 id={topicId}>{title}</h2></div></header>
              <ul>{details.map(detail => <li key={detail}>{detail}</li>)}</ul>
              <Link to={to} className="guide-card-link">{action}<ArrowRight size={16} aria-hidden="true" /></Link>
            </article>
          )
        })}
      </section>

      <aside className="guide-privacy-note">
        <span><LockKeyhole size={18} aria-hidden="true" /></span>
        <p><strong>Riêng tư theo thiết kế.</strong> Ví và giao dịch cá nhân chỉ bạn xem. Khi chia tiền, người khác chỉ thấy những khoản bạn chủ động chia sẻ.</p>
        <Link to="/settings" className="guide-privacy-link">Cài đặt riêng tư<ArrowRight size={15} aria-hidden="true" /></Link>
      </aside>
    </section>
  )
}
