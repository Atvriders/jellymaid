// tests/auth/session.test.ts
import { describe, it, expect } from 'vitest'
import { signSession, verifySession, SESSION_MAX_AGE_SECONDS, type SessionPayload } from '../../src/auth/session.js'

const SECRET = 'a-very-long-test-secret'
const payload = (over: Partial<SessionPayload> = {}): SessionPayload =>
  ({ username: 'bob', userId: 'u1', issuedAt: Date.now(), isAdministrator: true, ...over })

describe('session', () => {
  it('round-trips the signed payload including the admin flag', () => {
    const token = signSession(payload(), SECRET)
    expect(verifySession(token, SECRET)).toMatchObject({ username: 'bob', userId: 'u1', isAdministrator: true })
  })

  it('rejects a session older than the max age even with a valid signature', () => {
    const issuedAt = Date.now() - (SESSION_MAX_AGE_SECONDS * 1000 + 1000)
    const token = signSession(payload({ issuedAt }), SECRET)
    expect(verifySession(token, SECRET)).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const token = signSession(payload(), 'some-other-very-long-secret')
    expect(verifySession(token, SECRET)).toBeNull()
  })

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on mismatched buffer lengths, so this must be length-checked first.
    const body = signSession(payload(), SECRET).split('.')[0]!
    expect(() => verifySession(`${body}.short`, SECRET)).not.toThrow()
    expect(verifySession(`${body}.short`, SECRET)).toBeNull()
    expect(verifySession(`${body}.${'A'.repeat(200)}`, SECRET)).toBeNull()
  })

  it('rejects a token with extra trailing dot-segments', () => {
    // Ignoring anything past the second segment would let unbounded distinct cookies all verify
    // to the same session — one identity behind an unlimited number of credentials.
    const token = signSession(payload(), SECRET)
    expect(verifySession(`${token}.`, SECRET)).toBeNull()
    expect(verifySession(`${token}.junk`, SECRET)).toBeNull()
    expect(verifySession(`${token}.a.b.c`, SECRET)).toBeNull()
  })

  it('rejects a token with no signature segment at all', () => {
    const body = signSession(payload(), SECRET).split('.')[0]!
    expect(verifySession(body, SECRET)).toBeNull()
    expect(verifySession('', SECRET)).toBeNull()
  })

  it('rejects a validly signed token whose body is not JSON', () => {
    const junk = Buffer.from('not json at all').toString('base64url')
    const sig = signSession(payload(), SECRET).split('.')[1]!
    expect(verifySession(`${junk}.${sig}`, SECRET)).toBeNull()
  })
})
