import fs from 'fs'
import path from 'path'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { errorHandler } from './middleware/error'
import { requireAdmin, requireAuth } from './middleware/auth'
import { authRouter } from './routes/auth'
import { dashboardRouter } from './routes/dashboard'
import { employeesRouter } from './routes/employees'
import { expensesRouter } from './routes/expenses'
import { paymentsRouter } from './routes/payments'
import { reportsRouter } from './routes/reports'
import { servicesRouter } from './routes/services'
import { settingsRouter } from './routes/settings'
import { usersRouter } from './routes/users'
import './types'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: false, strictTransportSecurity: false }))
  app.use(
    cors({
      origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'CMH Cleaning Management System' })
  })

  app.use('/api/auth', authRouter)
  app.use('/api/employees', requireAuth, employeesRouter)
  app.use('/api/services', requireAuth, servicesRouter)
  app.use('/api/expenses', requireAuth, expensesRouter)
  app.use('/api/payments', requireAuth, paymentsRouter)
  app.use('/api/dashboard', requireAuth, dashboardRouter)
  app.use('/api/reports', requireAuth, reportsRouter)
  app.use('/api/settings', requireAuth, settingsRouter)
  app.use('/api/users', requireAuth, requireAdmin, usersRouter)

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' })
  })

  const clientDist = path.resolve(__dirname, '../../client/dist')
  const indexFile = path.join(clientDist, 'index.html')
  if (fs.existsSync(indexFile)) {
    app.use(express.static(clientDist))
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next()
        return
      }
      if (req.path.startsWith('/api')) {
        next()
        return
      }
      res.sendFile(indexFile)
    })
  }

  app.use(errorHandler)
  return app
}
