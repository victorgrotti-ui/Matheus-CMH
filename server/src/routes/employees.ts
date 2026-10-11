import { Prisma } from '@prisma/client'
import { Router } from 'express'
import { asyncRoute } from '../lib/async'
import { loadBooks } from '../lib/books'
import { HttpError } from '../lib/errors'
import { outstandingRows } from '../lib/finance'
import { prisma } from '../lib/prisma'
import { employeeSchema, type EmployeeInput } from '../lib/schemas'
import { serializeEmployeeBase, serializePayment, serializeService, serviceIncludeArgs } from '../lib/serialize'
import { validate } from '../middleware/validate'

export const employeesRouter = Router()

function uniqueMessage(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new HttpError(409, 'An employee with this email already exists.', {
      details: { email: 'An employee with this email already exists.' },
    })
  }
  throw error
}

employeesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    const status = req.query.status === 'ACTIVE' || req.query.status === 'INACTIVE' ? req.query.status : undefined
    const employees = await prisma.employee.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(search
          ? {
              OR: [
                { fullName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        services: { select: { employeePayment: true } },
        expenses: { select: { amount: true, reimbursable: true } },
      },
      orderBy: { fullName: 'asc' },
    })
    res.json({
      employees: employees.map((employee) =>
        serializeEmployeeBase({
          ...employee,
          serviceCount: employee.services.length,
          totalEarned:
            employee.services.reduce((total, service) => total + service.employeePayment, 0) +
            employee.expenses.filter((expense) => expense.reimbursable).reduce((total, expense) => total + expense.amount, 0),
        }),
      ),
    })
  }),
)

employeesRouter.post(
  '/',
  validate(employeeSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as EmployeeInput
    try {
      const employee = await prisma.employee.create({ data: body })
      res.status(201).json({
        employee: serializeEmployeeBase({ ...employee, serviceCount: 0, totalEarned: 0 }),
      })
    } catch (error) {
      uniqueMessage(error)
    }
  }),
)

employeesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const employee = await prisma.employee.findUnique({ where: { id: req.params.id } })
    if (!employee) throw new HttpError(404, 'Employee not found.')
    const [services, payments, books] = await Promise.all([
      prisma.service.findMany({
        where: { employeeId: employee.id },
        ...serviceIncludeArgs,
        orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.payment.findMany({
        where: { employeeId: employee.id },
        include: { employee: { select: { fullName: true } } },
        orderBy: { periodStart: 'desc' },
      }),
      loadBooks(),
    ])
    const outstanding = outstandingRows(
      books.services,
      books.expenses,
      books.employees,
    ).find((row) => row.employeeId === employee.id)
    const paidPayments = payments.filter((payment) => payment.status === 'PAID').reduce((total, payment) => total + payment.totalAmount, 0)
    const labor = books.services
      .filter((service) => service.employeeId === employee.id)
      .reduce((total, service) => total + service.employeePayment, 0)
    const reimbursable = books.expenses
      .filter((expense) => expense.reimbursable && expense.employeeId === employee.id)
      .reduce((total, expense) => total + expense.amount, 0)
    res.json({
      employee: serializeEmployeeBase({
        ...employee,
        serviceCount: services.length,
        totalEarned: labor + reimbursable,
      }),
      stats: {
        totalServices: services.length,
        totalEarned: labor + reimbursable,
        pendingPayments: outstanding?.totalDue ?? 0,
        paidPayments,
      },
      services: services.map(serializeService),
      payments: payments.map(serializePayment),
    })
  }),
)

employeesRouter.put(
  '/:id',
  validate(employeeSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as EmployeeInput
    const existing = await prisma.employee.findUnique({ where: { id: req.params.id } })
    if (!existing) throw new HttpError(404, 'Employee not found.')
    try {
      const employee = await prisma.employee.update({ where: { id: existing.id }, data: body })
      const counts = await prisma.employee.findUnique({
        where: { id: employee.id },
        include: {
          services: { select: { employeePayment: true } },
          expenses: { select: { amount: true, reimbursable: true } },
        },
      })
      res.json({
        employee: serializeEmployeeBase({
          ...employee,
          serviceCount: counts?.services.length ?? 0,
          totalEarned:
            (counts?.services.reduce((total, service) => total + service.employeePayment, 0) ?? 0) +
            (counts?.expenses.filter((expense) => expense.reimbursable).reduce((total, expense) => total + expense.amount, 0) ?? 0),
        }),
      })
    } catch (error) {
      uniqueMessage(error)
    }
  }),
)

employeesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const employee = await prisma.employee.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { services: true, expenses: true, payments: true } } },
    })
    if (!employee) throw new HttpError(404, 'Employee not found.')
    const linked = employee._count.services + employee._count.expenses + employee._count.payments
    if (linked > 0) {
      await prisma.employee.update({ where: { id: employee.id }, data: { status: 'INACTIVE' } })
      res.json({ disabled: true })
      return
    }
    await prisma.employee.delete({ where: { id: employee.id } })
    res.json({ deleted: true })
  }),
)
