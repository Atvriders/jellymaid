import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SessionPayload {
  username: string
  userId: string
  issuedAt: number
  /**
   * Recorded at login so later routes can re-assert the role from the signed payload instead of
   * trusting that login checked it once. There is no server-side session store, so this is the
   * only thing a route can hold the cookie to.
   */
  isAdministrator: boolean
}

export const SESSION_COOKIE = 'jellymaid_session'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifySession(token: string, secret: string, now = Date.now()): SessionPayload | null {
  // EXACTLY two segments. Ignoring trailing segments would let `body.sig`, `body.sig.x`,
  // `body.sig.y`, … all verify to the same session — unbounded distinct cookies, one identity.
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  if (!body || !sig) return null
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload
    if (now - payload.issuedAt > MAX_AGE_MS) return null
    return payload
  } catch {
    return null
  }
}

export const SESSION_MAX_AGE_SECONDS = MAX_AGE_MS / 1000
