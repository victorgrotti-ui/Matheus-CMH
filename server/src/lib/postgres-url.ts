import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

export interface PostgresTarget {
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl: false | { rejectUnauthorized: false }
}

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

function decodeUserInfo(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

function hasPlaceholder(value: string): boolean {
  return /\[[A-Za-z][A-Za-z0-9_-]*\]/.test(value)
}

function cleanConnectionString(raw: string, name: string): string {
  let value = raw.trim().replace(/^\uFEFF/, '')
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim()
  }
  value = value.replace(/[\r\n\t]/g, '')
  if (!/^postgres(?:ql)?:\/\//i.test(value)) {
    throw new Error(`${name} must start with postgresql://. The value was not printed.`)
  }
  return value
}

/**
 * Split a PostgreSQL URL into host, user and password.
 * Prisma reports P1013 when a password character is left inside the host.
 * Callers pass these fields to the driver separately and must not print them.
 */
export function postgresTargetFromUrl(raw: string, name: string): PostgresTarget {
  const value = cleanConnectionString(raw, name)
  const schemeEnd = value.indexOf('://')
  const rest = value.slice(schemeEnd + 3)
  const at = rest.lastIndexOf('@')
  if (at <= 0) throw new Error(`${name} is missing a host. The value was not printed.`)
  const userinfo = rest.slice(0, at)
  let hostAndPath = rest.slice(at + 1)
  const fragment = hostAndPath.indexOf('#')
  if (fragment !== -1) hostAndPath = hostAndPath.slice(0, fragment)
  const colon = userinfo.indexOf(':')
  if (colon <= 0) throw new Error(`${name} is missing a password separator. The value was not printed.`)
  const user = decodeUserInfo(userinfo.slice(0, colon))
  const password = decodeUserInfo(userinfo.slice(colon + 1))
  if (!password) throw new Error(`${name} is missing a password. The value was not printed.`)
  const queryStart = hostAndPath.indexOf('?')
  const pathAndHost = queryStart === -1 ? hostAndPath : hostAndPath.slice(0, queryStart)
  const query = queryStart === -1 ? '' : hostAndPath.slice(queryStart + 1)
  const slash = pathAndHost.indexOf('/')
  const hostPort = slash === -1 ? pathAndHost : pathAndHost.slice(0, slash)
  const database = decodeURIComponent((slash === -1 ? 'postgres' : pathAndHost.slice(slash + 1)) || 'postgres')
  const portSeparator = hostPort.lastIndexOf(':')
  const host = (portSeparator === -1 ? hostPort : hostPort.slice(0, portSeparator)).trim()
  const portText = portSeparator === -1 ? '' : hostPort.slice(portSeparator + 1)
  const port = portText ? Number(portText) : 5432
  const ipv6 = /^\[[0-9a-fA-F:]+\]$/.test(host)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || (!ipv6 && (host.includes('[') || host.includes(']') || /\s/.test(host) || hasPlaceholder(host) || hasPlaceholder(user)))) {
    throw new Error(`${name} still contains a placeholder or an invalid host character. The value was not printed.`)
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  const sslDisabled = /(^|&)sslmode=disable(&|$)/.test(query)
  return {
    host,
    port,
    user,
    password,
    database,
    ssl: local || sslDisabled ? false : { rejectUnauthorized: false },
  }
}

/** Prefer the direct URL that already applied the migration. */
export function postgresTargetForClient(env: NodeJS.ProcessEnv = process.env): PostgresTarget {
  const errors: string[] = []
  const candidates: Array<[string, string | undefined]> = [
    ['DIRECT_URL', env.DIRECT_URL],
    ['DATABASE_URL', env.DATABASE_URL],
  ]
  for (const [name, value] of candidates) {
    if (!value) continue
    try {
      return postgresTargetFromUrl(value, name)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${name} is invalid.`)
    }
  }
  throw new Error(errors[0] ?? 'Set DATABASE_URL and DIRECT_URL in .env. The values were not printed.')
}

/** A URL Prisma can parse. The password is encoded so it cannot become part of the host. */
export function safePostgresUrl(target: PostgresTarget): string {
  const user = encodeURIComponent(target.user)
  const password = encodeURIComponent(target.password)
  const base = `postgresql://${user}:${password}@${target.host}:${target.port}/${encodeURIComponent(target.database)}`
  return target.ssl ? `${base}?sslmode=require` : base
}
