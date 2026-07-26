// tests/auth/session.test.ts
import { describe, it, expect } from 'vitest'
import { signSession, verifySession, SESSION_MAX_AGE_SECONDS } from '../../src/auth/session.js'

describe('session', () => {
  it('rejects a session older than the max age even with a valid signature', () => {
    const secret = 'a-very-long-test-secret'
    const issuedAt = Date.now() - (SESSION_MAX_AGE_SECONDS * 1000 + 1000)
    const token = signSession({ username: 'bob', userId: 'u1', issuedAt }, secret)
    expect(verifySession(token, secret)).toBeNull()
  })
})
