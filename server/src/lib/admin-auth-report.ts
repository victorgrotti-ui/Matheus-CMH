import { cookieOptions, readToken, signToken, verifyPassword } from './auth'
import { prisma } from './prisma'

type AccountRow = {
  id: string
  email: string
  name: string
  role: string
  active: boolean
  tokenVersion: number
  passwordHash: string
}

export type AdminAuthReport = {
  adminNameSet: boolean
  adminEmailSet: boolean
  adminPasswordSet: boolean
  adminEmailValid: boolean
  adminPasswordLengthOk: boolean
  adminPasswordHasOuterSpace: boolean
  configuredNameIsMatheus: boolean
  jwtConfigured: boolean
  cookie: { httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string }
  configuredAccount: {
    exists: boolean
    roleAdmin: boolean
    active: boolean
    nameIsMatheus: boolean
    nameContainsMatheus: boolean
    passwordMatches: boolean
    sessionRoundTrip: boolean
  }
  matheusAccountCount: number
}

function blankAccount() {
  return {
    exists: false,
    roleAdmin: false,
    active: false,
    nameIsMatheus: false,
    nameContainsMatheus: false,
    passwordMatches: false,
    sessionRoundTrip: false,
  }
}

async function accountStatus(account: AccountRow | null, password: string, jwtReady: boolean) {
  if (!account) return blankAccount()
  const normalizedName = account.name.trim().toLowerCase()
  let passwordMatches = false
  let sessionRoundTrip = false
  if (password) passwordMatches = await verifyPassword(password, account.passwordHash)
  if (jwtReady) {
    const token = signToken({ id: account.id, role: account.role, tokenVersion: account.tokenVersion })
    const payload = readToken(token)
    sessionRoundTrip = payload?.sub === account.id && payload.role === account.role && payload.ver === account.tokenVersion
  }
  return {
    exists: true,
    roleAdmin: account.role === 'ADMIN',
    active: account.active,
    nameIsMatheus: normalizedName === 'matheus',
    nameContainsMatheus: normalizedName.includes('matheus'),
    passwordMatches,
    sessionRoundTrip,
  }
}

export async function adminAuthReport(
  env: NodeJS.ProcessEnv = process.env,
  findAccounts: (email: string) => Promise<AccountRow[]> = async (email) => {
    const rows = await prisma.user.findMany({
      where: {
        OR: [...(email ? [{ email }] : []), { name: { contains: 'matheus', mode: 'insensitive' } }],
      },
      select: { id: true, email: true, name: true, role: true, active: true, tokenVersion: true, passwordHash: true },
    })
    return rows
  },
): Promise<AdminAuthReport> {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase() ?? ''
  const name = env.ADMIN_NAME?.trim() ?? ''
  const password = env.ADMIN_PASSWORD ?? ''
  const jwtSecret = env.JWT_SECRET ?? ''
  const previousSecret = process.env.JWT_SECRET
  const previousVercel = process.env.VERCEL
  process.env.JWT_SECRET = jwtSecret
  process.env.VERCEL = env.VERCEL
  try {
    const accounts = await findAccounts(email)
    const jwtReady = jwtSecret.length >= 16 && !jwtSecret.toLowerCase().includes('replace-with')
    const configured = email ? accounts.find((account) => account.email.toLowerCase() === email) ?? null : null
    const cookie = cookieOptions()
    return {
      adminNameSet: name.length > 0,
      adminEmailSet: email.length > 0,
      adminPasswordSet: password.length > 0,
      adminEmailValid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      adminPasswordLengthOk: password.length >= 8 && password.length <= 72,
      adminPasswordHasOuterSpace: password.length > 0 && password !== password.trim(),
      configuredNameIsMatheus: name.toLowerCase() === 'matheus',
      jwtConfigured: jwtReady,
      cookie: { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, path: cookie.path },
      configuredAccount: await accountStatus(configured, password, jwtReady),
      matheusAccountCount: accounts.filter((account) => account.name.toLowerCase().includes('matheus')).length,
    }
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previousSecret
    if (previousVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previousVercel
  }
}
