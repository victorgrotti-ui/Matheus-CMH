import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { describe, it } from 'node:test'
import { adminAuthReport } from './admin-auth-report'

describe('production administrator check', () => {
  it('checks Matheus without returning the password or email', async () => {
    const password = 'correct-horse-1'
    const hash = await bcrypt.hash(password, 4)
    const report = await adminAuthReport(
      {
        VERCEL: '1',
        ADMIN_NAME: 'Matheus',
        ADMIN_EMAIL: 'matheus@example.com',
        ADMIN_PASSWORD: password,
        JWT_SECRET: 'unit-test-secret-value-32chars',
      },
      async () => [
        {
          id: 'user-matheus',
          email: 'matheus@example.com',
          name: 'Matheus',
          role: 'ADMIN',
          active: true,
          tokenVersion: 0,
          passwordHash: hash,
        },
      ],
    )
    const text = JSON.stringify(report)
    assert.equal(text.includes(password), false)
    assert.equal(text.includes('matheus@example.com'), false)
    assert.equal(text.includes(hash), false)
    assert.equal(report.configuredNameIsMatheus, true)
    assert.equal(report.adminEmailValid, true)
    assert.equal(report.adminPasswordLengthOk, true)
    assert.equal(report.jwtConfigured, true)
    assert.equal(report.cookie.secure, true)
    assert.equal(report.cookie.httpOnly, true)
    assert.equal(report.matheus.exists, true)
    assert.equal(report.matheus.roleAdmin, true)
    assert.equal(report.matheus.passwordMatches, true)
    assert.equal(report.matheus.sessionRoundTrip, true)
  })
})
