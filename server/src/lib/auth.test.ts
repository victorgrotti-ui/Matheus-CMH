import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import jwt from 'jsonwebtoken'
import { clearCookieOptions, cookieOptions, readToken, signToken } from './auth'

const original = process.env.COOKIE_SECURE

afterEach(() => {
  if (original === undefined) delete process.env.COOKIE_SECURE
  else process.env.COOKIE_SECURE = original
})

describe('session cookie', () => {
  it('stays usable on an internal HTTP address unless HTTPS is requested', () => {
    delete process.env.COOKIE_SECURE
    delete process.env.VERCEL
    assert.equal(cookieOptions().secure, false)
    assert.equal(cookieOptions().httpOnly, true)
    assert.equal(clearCookieOptions().secure, false)
    process.env.COOKIE_SECURE = 'true'
    assert.equal(cookieOptions().secure, true)
    assert.equal(clearCookieOptions().secure, true)
  })

  it('uses a secure cookie on Vercel without changing the office setting', () => {
    delete process.env.COOKIE_SECURE
    process.env.VERCEL = '1'
    assert.equal(cookieOptions().secure, true)
    delete process.env.VERCEL
    assert.equal(cookieOptions().secure, false)
  })
})

describe('session version', () => {
  const previous = process.env.JWT_SECRET

  beforeEach(() => {
    process.env.JWT_SECRET = 'unit-test-secret-value-32chars'
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previous
  })

  it('keeps a session issued before account versions when the stored version is 0', () => {
    const legacy = jwt.sign({ sub: 'user-1', role: 'ADMIN' }, process.env.JWT_SECRET ?? '', { expiresIn: '1h' })
    const payload = readToken(legacy)
    assert.equal(payload?.sub, 'user-1')
    assert.equal(payload?.role, 'ADMIN')
    assert.equal(payload?.ver, 0)
  })

  it('records the current account version and rejects a tampered version', () => {
    const token = signToken({ id: 'user-1', role: 'MANAGER', tokenVersion: 3 })
    assert.equal(readToken(token)?.ver, 3)
    const fractional = jwt.sign({ sub: 'user-1', role: 'MANAGER', ver: 1.5 }, process.env.JWT_SECRET ?? '', { expiresIn: '1h' })
    assert.equal(readToken(fractional), null)
    const negative = jwt.sign({ sub: 'user-1', role: 'MANAGER', ver: -1 }, process.env.JWT_SECRET ?? '', { expiresIn: '1h' })
    assert.equal(readToken(negative), null)
  })
})
