import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isDevelopmentDatabaseFile, isPostgresUrl } from './database-file'
import { postgresTargetForClient, postgresTargetFromUrl, redactConnectionStrings, safePostgresUrl } from './postgres-url'

describe('database file', () => {
  it('recognises the development database and not the office database', () => {
    assert.equal(isDevelopmentDatabaseFile('/office/prisma/dev.db'), true)
    assert.equal(isDevelopmentDatabaseFile('/office/prisma/DEV.DB'), true)
    assert.equal(isDevelopmentDatabaseFile('/office/prisma/production.db'), false)
    assert.equal(isDevelopmentDatabaseFile('/office/prisma/production.db-wal'), false)
  })

  it('recognises a Supabase PostgreSQL URL and rejects a SQLite file URL', () => {
    assert.equal(isPostgresUrl('postgresql://postgres.example:secret@aws-0-eu-west-1.pooler.supabase.com:6543/postgres'), true)
    assert.equal(isPostgresUrl('postgres://localhost:5432/cmh'), true)
    assert.equal(isPostgresUrl('file:./production.db'), false)
  })
})

describe('postgres connection string', () => {
  it('keeps a password character out of the host', () => {
    const target = postgresTargetFromUrl(
      'postgresql://postgres.example:p@ss#word@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
      'DATABASE_URL',
    )
    assert.equal(target.user, 'postgres.example')
    assert.equal(target.password, 'p@ss#word')
    assert.equal(target.host, 'aws-0-eu-west-1.pooler.supabase.com')
    assert.equal(target.port, 6543)
    assert.equal(target.database, 'postgres')
    const safe = safePostgresUrl(target)
    assert.equal(safe.includes('p@ss'), false)
    assert.equal(safe.includes('#'), false)
    assert.match(safe, /aws-0-eu-west-1\.pooler\.supabase\.com:6543\/postgres/)
  })

  it('decodes a password that is already encoded', () => {
    const target = postgresTargetFromUrl(
      'postgresql://postgres.example:p%40ss@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
      'DIRECT_URL',
    )
    assert.equal(target.password, 'p@ss')
    assert.equal(target.host, 'aws-0-eu-west-1.pooler.supabase.com')
  })

  it('rejects a placeholder host without returning the password', () => {
    assert.throws(
      () => postgresTargetFromUrl(
        'postgresql://postgres.example:super-secret-value@aws-0-[region].pooler.supabase.com:6543/postgres',
        'DATABASE_URL',
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message.includes('super-secret-value'), false)
        assert.match(error.message, /placeholder or an invalid host character/)
        return true
      },
    )
  })

  it('uses the direct URL when the pooler URL cannot be parsed', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://postgres.example:super-secret-value@aws-0-[region].pooler.supabase.com:6543/postgres',
      DIRECT_URL: 'postgresql://postgres.example:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    }
    const chosen = postgresTargetForClient(env)
    assert.equal(chosen.host, 'aws-0-eu-west-1.pooler.supabase.com')
    assert.equal(chosen.port, 5432)
    assert.equal(chosen.password, 'secret')
    assert.equal(safePostgresUrl(chosen).includes('super-secret-value'), false)
  })

  it('removes a connection string from a log message', () => {
    const message = redactConnectionStrings('P1013 invalid domain character postgresql://postgres.example:secret@host:5432/postgres')
    assert.equal(message.includes('secret'), false)
    assert.match(message, /postgresql:\/\/\[redacted\]/)
  })
})
