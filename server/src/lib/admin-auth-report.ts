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
  matheus: {
    exists: boolean
    roleAdmin: boolean
    active: boolean
    sameEmailAsAdminEnv: boolean
    passwordMatches: boolean
    sessionRoundTrip: boolean
  }
}

function blankAccount() {
  return {
    exists: false,
    roleAdmin: false,
    active: false,
    sameEmailAsAdminEnv: false,
    passwordMatches: false,
    sessionRoundTrip: false,
  }
}

export async function adminAuthReport(
  env: NodeJS.ProcessEnv = process.env,
  findAccounts: (email: string) => Promise<AccountRow[]> = async (email) => {
    const rows = await prisma.user.findMany({
      where: {
        OR: [{ email }, { name: { equals: 'Matheus', mode: 'insensitive' } }],
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
    const matheus = accounts.find((account) => account.name.trim().toLowerCase() === 'matheus') ?? null
    const cookie = cookieOptions()
    let passwordMatches = false
    let sessionRoundTrip = false
    if (matheus && password) {
      passwordMatches = await verifyPassword(password, matheus.passwordHash)
    }
    if (matheus && jwtSecret.length >= 16 && !jwtSecret.toLowerCase().includes('replace-with')) {
      const token = signToken({ id: matheus.id, role: matheus.role, tokenVersion: matheus.tokenVersion })
      const payload = readToken(token)
      sessionRoundTrip = payload?.sub === matheus.id && payload.role === matheus.role && payload.ver === matheus.tokenVersion
    }
    return {
      adminNameSet: name.length > 0,
      adminEmailSet: email.length > 0,
      adminPasswordSet: password.length > 0,
      adminEmailValid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      adminPasswordLengthOk: password.length >= 8 && password.length <= 72,
      adminPasswordHasOuterSpace: password.length > 0 && password !== password.trim(),
      configuredNameIsMatheus: name.toLowerCase() === 'matheus',
      jwtConfigured: jwtSecret.length >= 16 && !jwtSecret.toLowerCase().includes('replace-with'),
      cookie: { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, path: cookie.path },
      matheus: matheus
        ? {
            exists: true,
            roleAdmin: matheus.role === 'ADMIN',
            active: matheus.active,
            sameEmailAsAdminEnv: matheus.email.toLowerCase() === email,
            passwordMatches,
            sessionRoundTrip,
          }
        : blankAccount(),
    }
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = previousSecret
    if (previousVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previousVercel
  }
}
