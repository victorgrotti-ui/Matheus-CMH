import { createRequire } from 'node:module'
import { PrismaClient } from '@prisma/client'
import { loadConnectionEnv, postgresTargetForClient, safePostgresUrl } from './postgres-url'

const nodeRequire = createRequire(__filename)

let client: PrismaClient | undefined

function createClient(): PrismaClient {
  loadConnectionEnv(__dirname)
  const target = postgresTargetForClient()
  const safeUrl = safePostgresUrl(target)
  process.env.DATABASE_URL = safeUrl
  process.env.DIRECT_URL = safeUrl
  const { PrismaPg } = nodeRequire('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg')
  const adapter = new PrismaPg({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    ssl: target.ssl,
    max: process.env.VERCEL === '1' ? 1 : 5,
  })
  return new PrismaClient({ adapter, errorFormat: 'minimal' })
}

function getClient(): PrismaClient {
  client ??= createClient()
  return client
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(getClient(), property, receiver) as unknown
    return typeof value === 'function' ? value.bind(getClient()) : value
  },
})
