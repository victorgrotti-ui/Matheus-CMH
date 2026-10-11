import { execSync } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(__dirname, '../..')
const databaseUrl = process.env.CMH_TEST_DATABASE_URL ?? 'postgresql://cmh:cmh-local-test@127.0.0.1:5432/cmh_integration'
if (/supabase|pooler\.supabase/i.test(databaseUrl)) {
  throw new Error('The module audit must use the isolated local database.')
}
process.env.DATABASE_URL = databaseUrl
process.env.DIRECT_URL = databaseUrl
process.env.JWT_SECRET = 'module-audit-secret-key-123'
process.env.CLIENT_ORIGIN = 'http://localhost:5173'
process.env.NODE_ENV = 'test'
delete process.env.VERCEL

execSync(`psql "${databaseUrl}" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"`, {
  stdio: 'inherit',
})
execSync('npx prisma migrate deploy', {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

async function main() {
  const { createApp } = await import('./app')
  const { prisma } = await import('./lib/prisma')
  const { hashPassword } = await import('./lib/auth')
  const request = (await import('supertest')).default
  const app = createApp()
  const agent = request.agent(app)

  await prisma.user.create({
    data: {
      email: 'audit-admin@cmhcleaning.test',
      name: 'Audit Admin',
      passwordHash: await hashPassword('audit-pass-88'),
      role: 'ADMIN',
    },
  })

  const modules = ['/api/employees', '/api/services', '/api/expenses', '/api/payments', '/api/reports', '/api/settings']
  for (const pathName of modules) {
    const denied = await request(app).get(pathName)
    assert.equal(denied.status, 401, pathName)
  }

  const login = await agent.post('/api/auth/login').send({ email: 'audit-admin@cmhcleaning.test', password: 'audit-pass-88' })
  assert.equal(login.status, 200)

  const settingsFirst = await agent.get('/api/settings')
  assert.equal(settingsFirst.status, 200)
  assert.equal(settingsFirst.body.settings.companyName, 'CMH Cleaning')
  assert.equal(settingsFirst.body.settings.currency, 'GBP')
  assert.equal(settingsFirst.body.settings.defaultPaymentDay, 'SATURDAY')
  const settingsStamp = settingsFirst.body.settings.updatedAt as string

  const settingsReread = await agent.get('/api/settings')
  assert.equal(settingsReread.status, 200)
  assert.equal(settingsReread.body.settings.updatedAt, settingsStamp, 'reading settings must not rewrite the saved row')
  assert.equal(settingsReread.body.settings.companyName, 'CMH Cleaning')

  const settingsSaved = await agent.put('/api/settings').send({
    companyName: 'CMH Cleaning Audit',
    phone: '020 7946 0991',
    email: 'office@cmhcleaning.test',
    address: '12 Audit Lane',
    defaultPaymentDay: 'FRIDAY',
  })
  assert.equal(settingsSaved.status, 200, JSON.stringify(settingsSaved.body))
  assert.equal(settingsSaved.body.settings.companyName, 'CMH Cleaning Audit')
  assert.equal(settingsSaved.body.settings.phone, '020 7946 0991')
  assert.equal(settingsSaved.body.settings.email, 'office@cmhcleaning.test')
  assert.equal(settingsSaved.body.settings.address, '12 Audit Lane')
  assert.equal(settingsSaved.body.settings.defaultPaymentDay, 'FRIDAY')
  assert.equal(settingsSaved.body.settings.currency, 'GBP')

  const settingsAgain = await agent.get('/api/settings')
  assert.equal(settingsAgain.body.settings.companyName, 'CMH Cleaning Audit')
  assert.equal(settingsAgain.body.settings.defaultPaymentDay, 'FRIDAY')
  assert.equal(settingsAgain.body.settings.currency, 'GBP')

  const employee = await agent.post('/api/employees').send({
    fullName: 'John Smith',
    phone: '07123 456789',
    email: 'john@example.com',
    defaultRate: '110',
    status: 'ACTIVE',
    notes: 'Audit team',
  })
  assert.equal(employee.status, 201, JSON.stringify(employee.body))
  const employeeId = employee.body.employee.id as string

  const byLowerName = await agent.get('/api/employees').query({ search: 'john smith' })
  assert.equal(byLowerName.status, 200)
  assert.equal(byLowerName.body.employees.length, 1, 'employee search must ignore letter case')
  const byStatus = await agent.get('/api/employees').query({ status: 'ACTIVE' })
  assert.equal(byStatus.body.employees.length, 1)

  const service = await agent.post('/api/services').send({
    serviceDate: '2026-10-01',
    propertyAddress: '10 High Street',
    serviceType: 'REGULAR_CLEANING',
    clientName: 'Acme Lettings',
    employeeId,
    revenue: '250',
    employeePayment: '110',
    cleaningProductsCost: '20',
    otherExpenses: '0',
    productsReimbursable: true,
    otherReimbursable: false,
    notes: 'First visit',
  })
  assert.equal(service.status, 201, JSON.stringify(service.body))
  const serviceId = service.body.service.id as string

  const editedService = await agent.put(`/api/services/${serviceId}`).send({
    serviceDate: '2026-10-01',
    propertyAddress: '10 High Street, Flat 2',
    serviceType: 'DEEP_CLEANING',
    clientName: 'Acme Lettings',
    employeeId,
    revenue: '250',
    employeePayment: '110',
    cleaningProductsCost: '20',
    otherExpenses: '0',
    productsReimbursable: true,
    otherReimbursable: false,
    notes: 'Address corrected',
  })
  assert.equal(editedService.status, 200, JSON.stringify(editedService.body))
  assert.equal(editedService.body.service.propertyAddress, '10 High Street, Flat 2')
  assert.equal(editedService.body.service.serviceType, 'DEEP_CLEANING')
  assert.equal(editedService.body.service.notes, 'Address corrected')
  assert.equal(editedService.body.service.profit, 12000)

  const loadedService = await agent.get(`/api/services/${serviceId}`)
  assert.equal(loadedService.status, 200)
  assert.equal(loadedService.body.service.propertyAddress, '10 High Street, Flat 2')

  const byClient = await agent.get('/api/services').query({ client: 'acme' })
  assert.equal(byClient.status, 200)
  assert.equal(byClient.body.services.length, 1, 'service client search must ignore letter case')
  const byAddress = await agent.get('/api/services').query({ search: 'high street' })
  assert.equal(byAddress.body.services.length, 1, 'service address search must ignore letter case')

  const expense = await agent.post('/api/expenses').send({
    date: '2026-10-03',
    category: 'TRANSPORTATION',
    description: 'Travel to King Street',
    amount: '15.50',
    employeeId,
    reimbursable: true,
    notes: 'Receipt kept',
  })
  assert.equal(expense.status, 201, JSON.stringify(expense.body))
  const expenseId = expense.body.expense.id as string
  assert.equal(expense.body.expense.amount, 1550)

  const editedExpense = await agent.put(`/api/expenses/${expenseId}`).send({
    date: '2026-10-03',
    category: 'TRANSPORTATION',
    description: 'Travel to King Street revised',
    amount: '16',
    employeeId,
    reimbursable: true,
    notes: 'Receipt updated',
  })
  assert.equal(editedExpense.status, 200, JSON.stringify(editedExpense.body))
  assert.equal(editedExpense.body.expense.description, 'Travel to King Street revised')
  assert.equal(editedExpense.body.expense.amount, 1600)

  const loadedExpense = await agent.get(`/api/expenses/${expenseId}`)
  assert.equal(loadedExpense.status, 200)
  assert.equal(loadedExpense.body.expense.amount, 1600)
  const expenseSearch = await agent.get('/api/expenses').query({ search: 'king street' })
  assert.equal(expenseSearch.status, 200)
  assert.equal(expenseSearch.body.expenses.length, 1, 'expense search must ignore letter case')

  const reports = await agent.get('/api/reports').query({ from: '2026-10-01', to: '2026-10-03' })
  assert.equal(reports.status, 200)
  assert.equal(reports.body.summary.serviceCount, 1)
  assert.equal(reports.body.summary.revenue, 25000)
  assert.equal(reports.body.summary.expenses, 3600)
  assert.equal(reports.body.summary.profit, 10400)

  const csv = await agent.get('/api/reports/export').query({ from: '2026-10-01', to: '2026-10-03', lang: 'pt-BR' })
  assert.equal(csv.status, 200)
  assert.match(csv.headers['content-type'], /text\/csv/)
  assert.match(csv.text, /10 High Street, Flat 2/)
  assert.match(csv.text, /Lucro líquido/)

  const emptyCsv = await agent.get('/api/reports/export').query({ from: '2020-01-01', to: '2020-01-02' })
  assert.equal(emptyCsv.status, 200, JSON.stringify(emptyCsv.body))
  assert.match(emptyCsv.text, /Number of services,0/)

  const period = await agent.get('/api/payments/period').query({ from: '2026-09-28', to: '2026-10-04' })
  assert.equal(period.status, 200)
  assert.equal(period.body.rows.length, 1)
  assert.equal(period.body.rows[0].status, 'PENDING')

  const history = await agent.get('/api/payments')
  assert.equal(history.status, 200)
  assert.equal(history.body.payments.length, 0)

  const paid = await agent.post('/api/payments/mark-paid').send({
    employeeId,
    periodStart: '2026-09-28',
    periodEnd: '2026-10-04',
    paymentDate: '2026-10-04',
  })
  assert.equal(paid.status, 201, JSON.stringify(paid.body))
  const savedPayments = await agent.get('/api/payments').query({ employeeId })
  assert.equal(savedPayments.status, 200)
  assert.equal(savedPayments.body.payments.length, 1)
  assert.equal(savedPayments.body.payments[0].status, 'PAID')

  const locked = await agent.put(`/api/services/${serviceId}`).send({
    serviceDate: '2026-10-01',
    propertyAddress: '10 High Street, Flat 2',
    serviceType: 'DEEP_CLEANING',
    clientName: 'Acme Lettings',
    employeeId,
    revenue: '999',
    employeePayment: '110',
    cleaningProductsCost: '20',
    otherExpenses: '0',
    productsReimbursable: true,
    otherReimbursable: false,
    notes: 'Address corrected',
  })
  assert.equal(locked.status, 400)

  const noteOnly = await agent.put(`/api/services/${serviceId}`).send({
    serviceDate: '2026-10-01',
    propertyAddress: '10 High Street, Flat 2',
    serviceType: 'DEEP_CLEANING',
    clientName: 'Acme Lettings',
    employeeId,
    revenue: '250',
    employeePayment: '110',
    cleaningProductsCost: '20',
    otherExpenses: '0',
    productsReimbursable: true,
    otherReimbursable: false,
    notes: 'Note after payment',
  })
  assert.equal(noteOnly.status, 200, JSON.stringify(noteOnly.body))
  assert.equal(noteOnly.body.service.notes, 'Note after payment')
  assert.equal(noteOnly.body.service.revenue, 25000)

  console.log('Module audit passed.')
  await prisma.$disconnect()
}

main().catch(async (error) => {
  console.error(error)
  process.exitCode = 1
})
