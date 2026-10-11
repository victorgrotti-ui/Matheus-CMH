import { execSync } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(__dirname, '../..')
const databaseUrl = process.env.CMH_TEST_DATABASE_URL ?? 'postgresql://cmh:cmh-local-test@127.0.0.1:5432/cmh_integration'
if (/supabase|pooler\.supabase/i.test(databaseUrl)) {
  throw new Error('The write proof must use the isolated local database when run as a test.')
}
process.env.DATABASE_URL = databaseUrl
process.env.DIRECT_URL = databaseUrl
process.env.JWT_SECRET = 'write-proof-secret-key-123'
process.env.NODE_ENV = 'test'
delete process.env.VERCEL

execSync(`psql "${databaseUrl}" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"`, {
  stdio: 'inherit',
})
execSync('npx prisma migrate deploy', { cwd: root, stdio: 'inherit', env: process.env })

async function main() {
  const { prisma } = await import('./lib/prisma')
  const { proveRolledBackWrites } = await import('./lib/write-proof')
  await prisma.companySettings.create({
    data: { id: 'default', companyName: 'CMH Cleaning', currency: 'GBP', defaultPaymentDay: 'SATURDAY' },
  })
  await prisma.user.create({
    data: { email: 'audit-admin@cmhcleaning.test', name: 'Audit Admin', passwordHash: 'hash-must-stay', role: 'ADMIN' },
  })
  const report = await proveRolledBackWrites()
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.persisted, false)
  assert.equal(report.rolledBack, true)
  assert.equal(report.countsUnchanged, true)
  assert.equal(report.settingsUnchanged, true)
  assert.equal(report.accountsUnchanged, true)
  assert.equal(report.profitPence, 10400)
  assert.equal(report.currencyGbp, true)
  assert.equal(await prisma.employee.count(), 0)
  assert.equal(await prisma.service.count(), 0)
  assert.equal(await prisma.payment.count(), 0)
  assert.equal(await prisma.expense.count(), 0)
  const settings = await prisma.companySettings.findUnique({ where: { id: 'default' } })
  assert.equal(settings?.companyName, 'CMH Cleaning')
  assert.equal(settings?.currency, 'GBP')
  const admin = await prisma.user.findUnique({ where: { email: 'audit-admin@cmhcleaning.test' } })
  assert.equal(admin?.passwordHash, 'hash-must-stay')
  assert.equal(admin?.tokenVersion, 0)
  console.log('Rolled-back write proof passed.')
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
