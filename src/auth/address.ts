// src/auth/address.ts

/**
 * True for loopback, the RFC1918/RFC4193 private ranges, RFC3927 link-local, and for an
 * empty/undefined address.
 *
 * Used to decide whether the per-IP login lockout dimension (see src/api/auth.ts) should key on
 * a request's address at all. Such an address is either a LAN client — low threat, and the
 * per-username lockout dimension still covers it — or, worse, a reverse proxy whose real clients
 * have all collapsed onto this one address (TRUST_PROXY set too low or unset; see
 * src/config/load.ts). In the second case, locking the address out is a self-inflicted denial of
 * service against every caller behind the proxy, not a defence against any of them.
 */
export function isPrivateAddress(ip: string | undefined | null): boolean {
  if (!ip) return true
  const addr = unwrapIPv4Mapped(ip)
  return addr.includes(':') ? isPrivateIPv6(addr) : isPrivateIPv4(addr)
}

/** `::ffff:10.0.0.1` (IPv4-mapped IPv6) → `10.0.0.1`, so the IPv4 ranges below apply to it too. */
function unwrapIPv4Mapped(ip: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  return match ? match[1]! : ip
}

function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  if (a === 127) return true // 127.0.0.0/8 — loopback
  if (a === 10) return true // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // 169.254.0.0/16 — link-local
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true // loopback
  const firstGroup = lower.split(':', 1)[0]
  if (!firstGroup) return false
  const value = Number.parseInt(firstGroup, 16)
  if (Number.isNaN(value)) return false
  const firstByte = (value >> 8) & 0xff
  return firstByte === 0xfc || firstByte === 0xfd // fc00::/7 — unique local
}
