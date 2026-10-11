import { Prisma } from '@prisma/client'
import { Router } from 'express'
import { asyncRoute } from '../lib/async'
import { dateOnlyToDate, isDateOnly, toDateKey } from '../lib/dates'
import { HttpError } from '../lib/errors'
import { prisma } from '../lib/prisma'
import { readExpenseCategory } from '../lib/query'
import { expenseSchema, type ExpenseInput } from '../lib/schemas'
import { serializeExpense } from '../lib/serialize'
import { validate } from '../middleware/validate'

export const expensesRouter = Router()

const include = {
  employee: { select: { fullName: true } },
  service: { select: { propertyAddress: true, serviceDate: true, employeeId: true } },
  paymentItems: { select: { id: true } },
} satisfies Prisma.ExpenseInclude

async function loadExpense(id: string) {
  const expense = await prisma.expense.findUnique({ where: { id }, include })
  if (!expense) throw new HttpError(404, 'Expense not found.')
  return expense
}

async function assertLinks(body: ExpenseInput) {
  if (body.reimbursable && !body.employeeId) {
    throw new HttpError(400, 'Choose the employee who should be reimbursed.', {
      details: { employeeId: 'Choose the employee who should be reimbursed.' },
    })
  }
  if (body.employeeId) {
    const employee = await prisma.employee.findUnique({ where: { id: body.employeeId } })
    if (!employee) {
      throw new HttpError(400, 'Choose an employee.', { details: { employeeId: 'Choose an employee.' } })
    }
  }
  if (body.serviceId) {
    const service = await prisma.service.findUnique({ where: { id: body.serviceId } })
    if (!service) {
      throw new HttpError(400, 'Choose a valid service.', { details: { serviceId: 'Choose a valid service.' } })
    }
  }
}

expensesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const where: Prisma.ExpenseWhereInput = {}
    if (typeof req.query.from === 'string' && req.query.from && typeof req.query.to === 'string' && req.query.to) {
      if (!isDateOnly(req.query.from) || !isDateOnly(req.query.to) || req.query.from > req.query.to) {
        throw new HttpError(400, 'Choose a valid date range.')
      }
      where.date = { gte: dateOnlyToDate(req.query.from), lte: dateOnlyToDate(req.query.to) }
    }
    const category = readExpenseCategory(req.query.category)
    if (category) where.category = category as Prisma.ExpenseWhereInput['category']
    if (typeof req.query.employeeId === 'string' && req.query.employeeId) where.employeeId = req.query.employeeId
    if (req.query.reimbursable === 'true') where.reimbursable = true
    if (req.query.reimbursable === 'false') where.reimbursable = false
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      where.description = { contains: req.query.search.trim(), mode: 'insensitive' }
    }
    const expenses = await prisma.expense.findMany({
      where,
      include,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    })
    res.json({ expenses: expenses.map(serializeExpense) })
  }),
)

expensesRouter.post(
  '/',
  validate(expenseSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as ExpenseInput
    await assertLinks(body)
    const expense = await prisma.expense.create({
      data: {
        date: dateOnlyToDate(body.date),
        category: body.category,
        description: body.description,
        amount: body.amount,
        employeeId: body.employeeId,
        serviceId: body.serviceId,
        reimbursable: body.reimbursable,
        origin: 'MANUAL',
        notes: body.notes,
      },
      include,
    })
    res.status(201).json({ expense: serializeExpense(expense) })
  }),
)

expensesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json({ expense: serializeExpense(await loadExpense(req.params.id)) })
  }),
)

expensesRouter.put(
  '/:id',
  validate(expenseSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as ExpenseInput
    const existing = await loadExpense(req.params.id)
    const settled = existing.paymentItems.length > 0

    if (existing.origin !== 'MANUAL') {
      if (
        body.amount !== existing.amount ||
        body.category !== existing.category ||
        toDateKey(existing.date) !== body.date ||
        body.serviceId !== existing.serviceId
      ) {
        throw new HttpError(400, 'This expense comes from a service. Change the amount on the service itself.')
      }
      if (settled && body.reimbursable !== existing.reimbursable) {
        throw new HttpError(400, 'This expense has already been reimbursed.')
      }
      const employeeId = body.reimbursable ? body.employeeId || existing.service?.employeeId || null : null
      if (body.reimbursable && !employeeId) {
        throw new HttpError(400, 'Choose the employee who should be reimbursed.', {
          details: { employeeId: 'Choose the employee who should be reimbursed.' },
        })
      }
      const expense = await prisma.expense.update({
        where: { id: existing.id },
        data: {
          description: body.description,
          notes: body.notes,
          reimbursable: body.reimbursable,
          employeeId,
        },
        include,
      })
      res.json({ expense: serializeExpense(expense) })
      return
    }

    if (settled) {
      const expense = await prisma.expense.update({
        where: { id: existing.id },
        data: { notes: body.notes },
        include,
      })
      res.json({ expense: serializeExpense(expense) })
      return
    }

    await assertLinks(body)
    const expense = await prisma.expense.update({
      where: { id: existing.id },
      data: {
        date: dateOnlyToDate(body.date),
        category: body.category,
        description: body.description,
        amount: body.amount,
        employeeId: body.employeeId,
        serviceId: body.serviceId,
        reimbursable: body.reimbursable,
        notes: body.notes,
      },
      include,
    })
    res.json({ expense: serializeExpense(expense) })
  }),
)

expensesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const existing = await loadExpense(req.params.id)
    if (existing.origin !== 'MANUAL') {
      throw new HttpError(400, 'This expense comes from a service. Edit or delete the service instead.')
    }
    if (existing.paymentItems.length > 0) {
      throw new HttpError(409, 'This expense is included in a payment and cannot be deleted.')
    }
    await prisma.expense.delete({ where: { id: existing.id } })
    res.json({ ok: true })
  }),
)
