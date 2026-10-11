import { Prisma } from '@prisma/client'
import { dateOnlyToDate } from './dates'
import { prisma } from './prisma'
import { redactConnectionStrings } from './postgres-url'
import { syncServiceExpenses } from './sync-service-expenses'

const MARKER_EMAIL = 'cmh-write-proof@invalid.test'

export type WriteProofReport = {
  ok: boolean
  persisted: false
  rolledBack: boolean
  countsUnchanged: boolean
  settingsUnchanged: boolean
  accountsUnchanged: boolean
  createdInTransaction: boolean
  editedInTransaction: boolean
  searchedInTransaction: boolean
  duplicateBlocked: boolean
  profitPence: number | null
  currencyGbp: boolean
  detail?: string
}

type SettingsRow = {
  companyName: string
  currency: string
  defaultPaymentDay: string
  email: string | null
  phone: string | null
  address: string | null
  updatedAt: Date
}

type AccountRow = {
  id: string
  email: string
  name: string
  role: string
  active: boolean
  tokenVersion: number
  passwordHash: string
}

class RolledBackProof extends Error {
  readonly rolledBackProof = true
  constructor(
    readonly facts: {
      createdInTransaction: boolean
      editedInTransaction: boolean
      searchedInTransaction: boolean
      duplicateBlocked: boolean
      profitPence: number
    },
  ) {
    super('ROLLBACK_WRITE_PROOF')
  }
}

function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The write check failed.'
  return redactConnectionStrings(message)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .slice(0, 180)
}

async function snapshotCounts() {
  const [employees, services, payments, expenses, paymentItems, users, settings] = await Promise.all([
    prisma.employee.count(),
    prisma.service.count(),
    prisma.payment.count(),
    prisma.expense.count(),
    prisma.paymentItem.count(),
    prisma.user.count(),
    prisma.companySettings.count(),
  ])
  return { employees, services, payments, expenses, paymentItems, users, settings }
}

function sameCounts(left: Awaited<ReturnType<typeof snapshotCounts>>, right: Awaited<ReturnType<typeof snapshotCounts>>) {
  return (Object.keys(left) as Array<keyof typeof left>).every((key) => left[key] === right[key])
}

function settingsStamp(row: SettingsRow | null): string {
  if (!row) return 'missing'
  return JSON.stringify({
    companyName: row.companyName,
    currency: row.currency,
    defaultPaymentDay: row.defaultPaymentDay,
    email: row.email,
    phone: row.phone,
    address: row.address,
    updatedAt: row.updatedAt.toISOString(),
  })
}

function accountsStamp(rows: AccountRow[]): string {
  return JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      active: row.active,
      tokenVersion: row.tokenVersion,
      passwordHash: row.passwordHash,
    })),
  )
}

async function removeMarker(): Promise<void> {
  const employee = await prisma.employee.findUnique({ where: { email: MARKER_EMAIL }, select: { id: true } })
  if (!employee) return
  await prisma.paymentItem.deleteMany({ where: { OR: [{ payment: { employeeId: employee.id } }, { service: { employeeId: employee.id } }, { expense: { employeeId: employee.id } }] } })
  await prisma.payment.deleteMany({ where: { employeeId: employee.id } })
  await prisma.expense.deleteMany({ where: { employeeId: employee.id } })
  await prisma.service.deleteMany({ where: { employeeId: employee.id } })
  await prisma.employee.delete({ where: { id: employee.id } })
}

/**
 * Inserts, edits and reads one sample of each company record inside a transaction,
 * then rolls it back. Nothing is committed.
 */
export async function proveRolledBackWrites(): Promise<WriteProofReport> {
  const beforeCounts = await snapshotCounts()
  const beforeSettings = await prisma.companySettings.findUnique({ where: { id: 'default' } })
  const beforeAccounts = await prisma.user.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, email: true, name: true, role: true, active: true, tokenVersion: true, passwordHash: true },
  })
  const beforeSettingsStamp = settingsStamp(beforeSettings)
  const beforeAccountsStamp = accountsStamp(beforeAccounts)

  let facts: RolledBackProof['facts'] | null = null
  let rolledBack = false
  let detail: string | undefined

  try {
    await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
        data: {
          fullName: 'CMH Write Proof',
          email: MARKER_EMAIL,
          phone: '020 7946 0991',
          defaultRate: 11000,
          status: 'ACTIVE',
          notes: 'rolled back',
        },
      })
      const edited = await tx.employee.update({
        where: { id: employee.id },
        data: { phone: '020 7946 0000', notes: 'edited inside the transaction' },
      })
      const found = await tx.employee.findMany({
        where: { fullName: { contains: 'write proof', mode: 'insensitive' }, email: MARKER_EMAIL },
      })
      const service = await tx.service.create({
        data: {
          serviceDate: dateOnlyToDate('2026-10-06'),
          propertyAddress: '10 Write Proof Street',
          serviceType: 'REGULAR_CLEANING',
          clientName: 'Write Proof Client',
          employeeId: employee.id,
          revenue: 25000,
          employeePayment: 11000,
          cleaningProductsCost: 2000,
          otherExpenses: 0,
          notes: 'rolled back',
        },
      })
      await syncServiceExpenses(tx, service, { productsReimbursable: true, otherReimbursable: false })
      await tx.service.update({ where: { id: service.id }, data: { notes: 'address confirmed' } })
      const expense = await tx.expense.create({
        data: {
          date: dateOnlyToDate('2026-10-06'),
          category: 'TRANSPORTATION',
          description: 'Write proof travel',
          amount: 1500,
          employeeId: employee.id,
          reimbursable: true,
          origin: 'MANUAL',
        },
      })
      await tx.expense.update({ where: { id: expense.id }, data: { description: 'Write proof travel revised', amount: 1600 } })
      const payment = await tx.payment.create({
        data: {
          employeeId: employee.id,
          periodStart: dateOnlyToDate('2026-10-05'),
          periodEnd: dateOnlyToDate('2026-10-11'),
          installment: 1,
          serviceCount: 1,
          workEarnings: 11000,
          reimbursements: 3600,
          totalAmount: 14600,
          status: 'PAID',
          paymentDate: dateOnlyToDate('2026-10-11'),
          items: {
            create: [
              { serviceId: service.id, kind: 'WORK', amount: 11000 },
              { expenseId: expense.id, kind: 'REIMBURSEMENT', amount: 1600 },
            ],
          },
        },
      })
      const storedService = await tx.service.findUnique({ where: { id: service.id } })
      const storedExpense = await tx.expense.findUnique({ where: { id: expense.id } })
      const product = await tx.expense.findFirst({ where: { serviceId: service.id, origin: 'SERVICE_PRODUCTS' } })
      const profit = (storedService?.revenue ?? 0) - (storedService?.employeePayment ?? 0) - (product?.amount ?? 0) - (storedExpense?.amount ?? 0)
      await tx.$executeRaw(Prisma.sql`SAVEPOINT write_proof_duplicate`)
      let duplicateBlocked = false
      try {
        await tx.payment.create({
          data: {
            employeeId: employee.id,
            periodStart: dateOnlyToDate('2026-10-05'),
            periodEnd: dateOnlyToDate('2026-10-11'),
            installment: 1,
            serviceCount: 1,
            workEarnings: 11000,
            reimbursements: 0,
            totalAmount: 11000,
            status: 'PAID',
            paymentDate: dateOnlyToDate('2026-10-11'),
          },
        })
      } catch (error) {
        duplicateBlocked = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
        await tx.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT write_proof_duplicate`)
      }
      const readBack = await tx.payment.findUnique({ where: { id: payment.id }, select: { totalAmount: true } })
      if (!readBack || readBack.totalAmount !== 14600) throw new Error('The payment could not be read back inside the transaction.')
      throw new RolledBackProof({
        createdInTransaction: true,
        editedInTransaction: edited.phone === '020 7946 0000' && edited.notes === 'edited inside the transaction',
        searchedInTransaction: found.length === 1,
        duplicateBlocked,
        profitPence: profit,
      })
    })
  } catch (error) {
    if (error instanceof RolledBackProof) {
      facts = error.facts
      rolledBack = true
    } else {
      detail = redact(error)
    }
  }

  let markerRemained = false
  try {
    markerRemained = (await prisma.employee.findUnique({ where: { email: MARKER_EMAIL }, select: { id: true } })) != null
    if (markerRemained) await removeMarker()
  } catch (error) {
    detail = detail ?? redact(error)
  }

  const afterCounts = await snapshotCounts()
  const afterSettings = await prisma.companySettings.findUnique({ where: { id: 'default' } })
  const afterAccounts = await prisma.user.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, email: true, name: true, role: true, active: true, tokenVersion: true, passwordHash: true },
  })
  const countsUnchanged = sameCounts(beforeCounts, afterCounts) && !markerRemained
  const settingsUnchanged = settingsStamp(afterSettings) === beforeSettingsStamp
  const accountsUnchanged = accountsStamp(afterAccounts) === beforeAccountsStamp
  const ok = Boolean(
    facts &&
      rolledBack &&
      countsUnchanged &&
      settingsUnchanged &&
      accountsUnchanged &&
      facts.createdInTransaction &&
      facts.editedInTransaction &&
      facts.searchedInTransaction &&
      facts.duplicateBlocked &&
      facts.profitPence === 10400 &&
      afterSettings?.currency === 'GBP',
  )

  return {
    ok,
    persisted: false,
    rolledBack,
    countsUnchanged,
    settingsUnchanged,
    accountsUnchanged,
    createdInTransaction: facts?.createdInTransaction ?? false,
    editedInTransaction: facts?.editedInTransaction ?? false,
    searchedInTransaction: facts?.searchedInTransaction ?? false,
    duplicateBlocked: facts?.duplicateBlocked ?? false,
    profitPence: facts?.profitPence ?? null,
    currencyGbp: afterSettings?.currency === 'GBP',
    ...(detail ? { detail } : {}),
  }
}
