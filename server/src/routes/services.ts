import { Prisma } from '@prisma/client'
import { Router } from 'express'
import { asyncRoute } from '../lib/async'
import { dateOnlyToDate, isDateOnly } from '../lib/dates'
import { SERVICE_TYPES } from '../lib/labels'
import { HttpError } from '../lib/errors'
import { prisma } from '../lib/prisma'
import { serviceSchema, type ServiceInput } from '../lib/schemas'
import { serializeService, serviceIncludeArgs } from '../lib/serialize'
import { syncServiceExpenses } from '../lib/sync-service-expenses'
import { validate } from '../middleware/validate'

export const servicesRouter = Router()

async function assertActiveEmployee(employeeId: string, allowInactiveId?: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } })
  if (!employee) throw new HttpError(400, 'Choose an employee.', { details: { employeeId: 'Choose an employee.' } })
  if (employee.status !== 'ACTIVE' && employee.id !== allowInactiveId) {
    throw new HttpError(400, 'This employee is inactive. Choose an active employee or enable them first.', {
      details: { employeeId: 'This employee is inactive.' },
    })
  }
  return employee
}

async function loadService(id: string) {
  const service = await prisma.service.findUnique({ where: { id }, ...serviceIncludeArgs })
  if (!service) throw new HttpError(404, 'Service not found.')
  return service
}

servicesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const where: Prisma.ServiceWhereInput = {}
    if (typeof req.query.from === 'string' && req.query.from && typeof req.query.to === 'string' && req.query.to) {
      if (!isDateOnly(req.query.from) || !isDateOnly(req.query.to) || req.query.from > req.query.to) {
        throw new HttpError(400, 'Choose a valid date range.')
      }
      where.serviceDate = { gte: dateOnlyToDate(req.query.from), lte: dateOnlyToDate(req.query.to) }
    }
    if (typeof req.query.employeeId === 'string' && req.query.employeeId) where.employeeId = req.query.employeeId
    if (typeof req.query.serviceType === 'string' && req.query.serviceType) {
      if (!(SERVICE_TYPES as readonly string[]).includes(req.query.serviceType)) {
        throw new HttpError(400, 'Choose a valid service type.')
      }
      where.serviceType = req.query.serviceType as Prisma.ServiceWhereInput['serviceType']
    }
    if (typeof req.query.client === 'string' && req.query.client.trim()) {
      where.clientName = { contains: req.query.client.trim(), mode: 'insensitive' }
    }
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      where.propertyAddress = { contains: req.query.search.trim(), mode: 'insensitive' }
    }

    const services = await prisma.service.findMany({
      where,
      ...serviceIncludeArgs,
      orderBy: [{ serviceDate: 'desc' }, { createdAt: 'desc' }],
    })
    const rows = services.map(serializeService)
    const paymentStatus = req.query.paymentStatus === 'PAID' || req.query.paymentStatus === 'PENDING' ? req.query.paymentStatus : ''
    res.json({ services: paymentStatus ? rows.filter((row) => row.paymentStatus === paymentStatus) : rows })
  }),
)

servicesRouter.post(
  '/',
  validate(serviceSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as ServiceInput
    await assertActiveEmployee(body.employeeId)
    const created = await prisma.$transaction(async (tx) => {
      const service = await tx.service.create({
        data: {
          serviceDate: dateOnlyToDate(body.serviceDate),
          propertyAddress: body.propertyAddress,
          serviceType: body.serviceType,
          clientName: body.clientName,
          employeeId: body.employeeId,
          revenue: body.revenue,
          employeePayment: body.employeePayment,
          cleaningProductsCost: body.cleaningProductsCost,
          otherExpenses: body.otherExpenses,
          notes: body.notes,
        },
      })
      await syncServiceExpenses(tx, service, {
        productsReimbursable: body.productsReimbursable,
        otherReimbursable: body.otherReimbursable,
      })
      return service.id
    })
    res.status(201).json({ service: serializeService(await loadService(created)) })
  }),
)

servicesRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    res.json({ service: serializeService(await loadService(req.params.id)) })
  }),
)

servicesRouter.put(
  '/:id',
  validate(serviceSchema),
  asyncRoute(async (req, res) => {
    const body = req.body as ServiceInput
    const existing = await loadService(req.params.id)
    await assertActiveEmployee(body.employeeId, existing.employeeId)
    const locked =
      existing.paymentItems.length > 0 || existing.expenses.some((expense) => expense.paymentItems.length > 0)
    const productsReimbursable = existing.expenses.some(
      (expense) => expense.origin === 'SERVICE_PRODUCTS' && expense.reimbursable,
    )
    const otherReimbursable = existing.expenses.some(
      (expense) => expense.origin === 'SERVICE_OTHER' && expense.reimbursable,
    )
    const financialChange =
      existing.revenue !== body.revenue ||
      existing.employeePayment !== body.employeePayment ||
      existing.cleaningProductsCost !== body.cleaningProductsCost ||
      existing.otherExpenses !== body.otherExpenses ||
      existing.employeeId !== body.employeeId ||
      existing.serviceDate.toISOString().slice(0, 10) !== body.serviceDate ||
      productsReimbursable !== body.productsReimbursable ||
      otherReimbursable !== body.otherReimbursable
    if (locked && financialChange) {
      throw new HttpError(
        400,
        'This service is already included in a payment. Financial details cannot be changed. Add an adjustment expense if a correction is needed.',
      )
    }

    await prisma.$transaction(async (tx) => {
      const service = await tx.service.update({
        where: { id: existing.id },
        data: {
          serviceDate: dateOnlyToDate(body.serviceDate),
          propertyAddress: body.propertyAddress,
          serviceType: body.serviceType,
          clientName: body.clientName,
          employeeId: body.employeeId,
          revenue: body.revenue,
          employeePayment: body.employeePayment,
          cleaningProductsCost: body.cleaningProductsCost,
          otherExpenses: body.otherExpenses,
          notes: body.notes,
        },
      })
      await syncServiceExpenses(tx, service, {
        productsReimbursable: body.productsReimbursable,
        otherReimbursable: body.otherReimbursable,
      })
    })
    res.json({ service: serializeService(await loadService(existing.id)) })
  }),
)

servicesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const existing = await loadService(req.params.id)
    if (existing.paymentItems.length > 0 || existing.expenses.some((expense) => expense.paymentItems.length > 0)) {
      throw new HttpError(409, 'This service is included in a payment and cannot be deleted.')
    }
    if (existing.expenses.some((expense) => expense.origin === 'MANUAL')) {
      throw new HttpError(409, 'This service has other expenses linked to it. Delete or unlink those expenses first.')
    }
    await prisma.$transaction(async (tx) => {
      await tx.expense.deleteMany({
        where: { serviceId: existing.id, origin: { in: ['SERVICE_PRODUCTS', 'SERVICE_OTHER'] } },
      })
      await tx.service.delete({ where: { id: existing.id } })
    })
    res.json({ ok: true })
  }),
)
