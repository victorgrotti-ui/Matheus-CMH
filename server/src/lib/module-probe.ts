import http from 'node:http'
import type { Express } from 'express'
import { COOKIE_NAME, signToken } from './auth'
import { prisma } from './prisma'
import { redactConnectionStrings } from './postgres-url'

const RANGE = 'from=2026-10-05&to=2026-10-11'

type Counts = {
  employees: number
  services: number
  payments: number
  expenses: number
  users: number
  settings: number
}

export type ModuleProbeReport = {
  ok: boolean
  writes: false
  countsUnchanged: boolean
  transaction: 'ok' | 'failed'
  transactionDetail?: string
  modules: Record<string, { status: number; count?: number; currencyGbp?: boolean; csv?: boolean }>
}

async function counts(): Promise<Counts> {
  const [employees, services, payments, expenses, users, settings] = await Promise.all([
    prisma.employee.count(),
    prisma.service.count(),
    prisma.payment.count(),
    prisma.expense.count(),
    prisma.user.count(),
    prisma.companySettings.count(),
  ])
  return { employees, services, payments, expenses, users, settings }
}

function sameCounts(left: Counts, right: Counts): boolean {
  return (Object.keys(left) as Array<keyof Counts>).every((key) => left[key] === right[key])
}

function listen(app: Express): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(app)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('The read-only audit could not listen locally.'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

async function call(port: number, path: string, cookie: string | null) {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = `${COOKIE_NAME}=${cookie}`
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'GET', headers })
  const text = await response.text()
  return { status: response.status, text, contentType: response.headers.get('content-type') ?? '' }
}

function listCount(text: string, key: string): number | undefined {
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const value = body[key]
    return Array.isArray(value) ? value.length : undefined
  } catch {
    return undefined
  }
}

/** Authenticated read of each module. It does not create, edit, or delete rows. */
export async function readOnlyModuleReport(app: Express): Promise<ModuleProbeReport> {
  const before = await counts()
  let transaction: ModuleProbeReport['transaction'] = 'failed'
  let transactionDetail: string | undefined
  try {
    await prisma.$transaction(async (tx) => {
      await tx.employee.count()
      await tx.service.count()
      await tx.payment.count()
      await tx.expense.count()
      await tx.companySettings.findUnique({ where: { id: 'default' }, select: { id: true, currency: true } })
    })
    transaction = 'ok'
  } catch (error) {
    transactionDetail = redactConnectionStrings(error instanceof Error ? error.message : 'transaction failed').slice(0, 180)
  }

  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', active: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, tokenVersion: true },
  })
  if (!admin) {
    const afterMissing = await counts()
    return {
      ok: false,
      writes: false,
      countsUnchanged: sameCounts(before, afterMissing),
      transaction,
      ...(transactionDetail ? { transactionDetail } : {}),
      modules: {},
    }
  }

  const token = signToken(admin)
  const { server, port } = await listen(app)
  try {
    const [employees, employeeSearch, services, serviceSearch, expenses, expenseSearch, payments, period, reports, csv, settings, dashboard, anonymous] =
      await Promise.all([
        call(port, '/api/employees', token),
        call(port, '/api/employees?search=a', token),
        call(port, '/api/services', token),
        call(port, '/api/services?client=a&search=a', token),
        call(port, '/api/expenses', token),
        call(port, '/api/expenses?search=a', token),
        call(port, '/api/payments', token),
        call(port, `/api/payments/period?${RANGE}`, token),
        call(port, `/api/reports?${RANGE}`, token),
        call(port, `/api/reports/export?${RANGE}`, token),
        call(port, '/api/settings', token),
        call(port, `/api/dashboard?${RANGE}`, token),
        call(port, '/api/employees', null),
      ])

    let currencyGbp = false
    let settingsCount: number | undefined
    try {
      const body = JSON.parse(settings.text) as { settings?: { currency?: string; companyName?: string } }
      currencyGbp = body.settings?.currency === 'GBP'
      settingsCount = typeof body.settings?.companyName === 'string' && body.settings.companyName.length > 0 ? 1 : 0
    } catch {
      currencyGbp = false
    }

    let reportCount: number | undefined
    try {
      const body = JSON.parse(reports.text) as { summary?: { serviceCount?: number } }
      reportCount = body.summary?.serviceCount
    } catch {
      reportCount = undefined
    }

    const modules: ModuleProbeReport['modules'] = {
      employees: { status: employees.status, count: listCount(employees.text, 'employees') },
      employeeSearch: { status: employeeSearch.status, count: listCount(employeeSearch.text, 'employees') },
      services: { status: services.status, count: listCount(services.text, 'services') },
      serviceSearch: { status: serviceSearch.status, count: listCount(serviceSearch.text, 'services') },
      expenses: { status: expenses.status, count: listCount(expenses.text, 'expenses') },
      expenseSearch: { status: expenseSearch.status, count: listCount(expenseSearch.text, 'expenses') },
      payments: { status: payments.status, count: listCount(payments.text, 'payments') },
      paymentsPeriod: { status: period.status, count: listCount(period.text, 'rows') },
      reports: { status: reports.status, count: reportCount },
      reportsExport: { status: csv.status, csv: csv.contentType.includes('text/csv') },
      settings: { status: settings.status, currencyGbp, count: settingsCount },
      dashboard: { status: dashboard.status },
      anonymousEmployees: { status: anonymous.status },
    }

    const after = await counts()
    const countsUnchanged = sameCounts(before, after)
    const ok =
      countsUnchanged &&
      transaction === 'ok' &&
      anonymous.status === 401 &&
      Object.entries(modules)
        .filter(([name]) => name !== 'anonymousEmployees')
        .every(([, item]) => item.status === 200)
    return { ok, writes: false, countsUnchanged, transaction, ...(transactionDetail ? { transactionDetail } : {}), modules }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
