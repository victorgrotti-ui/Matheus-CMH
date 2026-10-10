import { PrismaClient } from '@prisma/client'
import { connectionUrlForClient, loadConnectionEnv } from './postgres-url'

loadConnectionEnv(__dirname)
const datasourceUrl = connectionUrlForClient()

export const prisma = new PrismaClient({
  datasourceUrl,
  errorFormat: 'minimal',
})
