import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

/** Remove a copied connection string from an error before it is printed. */
export function redactConnectionStrings(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
}

function projectRootFrom(start: string): string {
  let dir = start
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

/** Load the project `.env` without replacing connection strings already set in the process. */
export function loadConnectionEnv(startDir: string): void {
  const envPath = path.join(projectRootFrom(startDir), '.env')
  if (!fs.existsSync(envPath)) return
  dotenv.config({ path: envPath })
}

function encodeUserInfo(part: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(part))
  } catch {
    return encodeURIComponent(part)
  }
}

function hasPlaceholder(value: string): boolean {
  return /\[[A-Za-z][A-Za-z0-9_-]*\]/.test(value)
}

/**
 * Rebuild a PostgreSQL URL so characters in the password stay in the password.
 * An unencoded `@` or `#` otherwise becomes part of the host and Prisma reports P1013.
 * The returned string is for the driver only. Callers must not print it.
 */
export function normalizePostgresUrl(raw: string, name: string): string {
  let value = raw.trim().replace(/^\uFEFF/, '')
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim()
  }
  value = value.replace(/[\r\n\t]/g, '')
  const schemeMatch = /^(postgres(?:ql)?):\/\//i.exec(value)
  if (!schemeMatch) throw new Error(`${name} must start with postgresql://. The value was not printed.`)
  const rest = value.slice(schemeMatch[0].length)
  const at = rest.lastIndexOf('@')
  if (at <= 0) throw new Error(`${name} is missing a host. The value was not printed.`)
  const userinfo = rest.slice(0, at)
  const hostAndPath = rest.slice(at + 1)
  const colon = userinfo.indexOf(':')
  if (colon <= 0) throw new Error(`${name} is missing a password separator. The value was not printed.`)
  const user = userinfo.slice(0, colon)
  const password = userinfo.slice(colon + 1)
  if (!password) throw new Error(`${name} is missing a password. The value was not printed.`)
  const pathStart = hostAndPath.indexOf('/')
  const hostPort = pathStart === -1 ? hostAndPath.split('?')[0] : hostAndPath.slice(0, pathStart)
  const host = hostPort.replace(/:\d+$/, '')
  const ipv6 = /^\[[0-9a-fA-F:]+\]$/.test(host)
  if (!host || (!ipv6 && (host.includes('[') || host.includes(']') || host.includes(' ') || hasPlaceholder(host) || hasPlaceholder(user)))) {
    throw new Error(`${name} still contains a placeholder or an invalid host character. The value was not printed.`)
  }
  return `${schemeMatch[1].toLowerCase()}://${encodeUserInfo(user)}:${encodeUserInfo(password)}@${hostAndPath}`
}

/**
 * Connection used by the office server and by prisma/seed.ts.
 * Migrations already succeeded with DIRECT_URL. The seed was opening DATABASE_URL,
 * which is the pooler string Prisma rejects when the password breaks the host.
 */
export function connectionUrlForClient(env: NodeJS.ProcessEnv = process.env): string {
  let direct: string | undefined
  let database: string | undefined
  const errors: string[] = []
  if (env.DIRECT_URL) {
    try {
      direct = normalizePostgresUrl(env.DIRECT_URL, 'DIRECT_URL')
      env.DIRECT_URL = direct
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'DIRECT_URL is invalid.')
    }
  }
  if (env.DATABASE_URL) {
    try {
      database = normalizePostgresUrl(env.DATABASE_URL, 'DATABASE_URL')
      env.DATABASE_URL = database
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'DATABASE_URL is invalid.')
    }
  }
  const chosen = direct ?? database
  if (!chosen) {
    throw new Error(errors[0] ?? 'Set DATABASE_URL and DIRECT_URL in .env. The values were not printed.')
  }
  if (!database) env.DATABASE_URL = chosen
  if (!direct) env.DIRECT_URL = chosen
  return chosen
}
