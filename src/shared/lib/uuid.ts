/**
 * Creates an RFC 4122 v4 UUID using the browser's cryptographically secure
 * random source. getRandomValues is available on plain HTTP LAN origins where
 * crypto.randomUUID is intentionally unavailable.
 */
export function createUuid(): string {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) {
    throw new Error('Trình duyệt này không hỗ trợ tạo mã bảo mật cần thiết.')
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}
