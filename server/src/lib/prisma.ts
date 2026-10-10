import { loadConnectionEnv, postgresTargetForClient, safePostgresUrl } from './postgres-url'

loadConnectionEnv(__dirname)
const target = postgresTargetForClient()
const safeUrl = safePostgresUrl(target)
process.env.DATABASE_URL = safeUrl
process.env.DIRECT_URL = safeUrl

const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg')
const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client')

const adapter = new PrismaPg({
  host: target.host,
  port: target.port,
  user: target.user,
  password: target.password,
  database: target.database,
  ssl: target.ssl,
  max: 5,
})

export const prisma = new PrismaClient({
  adapter,
  errorFormat: 'minimal',
})
