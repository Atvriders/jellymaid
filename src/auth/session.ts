import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'

export interface SessionPayload { username: string; userId: string; issuedAt: number }

export const SESSION_COOKIE = 'jellymaid_session'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifySession(token: string, secret: string, now = Date.now()): SessionPayload | null {
  const [body, sig] = token.split('.')
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

export const newSessionId = () => randomUUID()
export const SESSION_MAX_AGE_SECONDS = MAX_AGE_MS / 1000
