import type { IncomingMessage, ServerResponse } from 'http'
import { createApp } from './app'
import { adminAuthReport } from './lib/admin-auth-report'
import { ensureBootstrapAdmin } from './lib/bootstrap-admin'
import { redactConnectionStrings } from './lib/postgres-url'
import { ensureSettings } from './lib/settings'

const app = createApp()
let ready: Promise<void> | undefined

function prepare(): Promise<void> {
  ready ??= ensureSettings()
    .then(() => ensureBootstrapAdmin())
    .catch((error: unknown) => {
      ready = undefined
      throw error
    })
  return ready
}

function restoreApiPrefix(req: IncomingMessage): void {
  const url = req.url ?? '/'
  const queryIndex = url.indexOf('?')
  const pathOnly = queryIndex === -1 ? url : url.slice(0, queryIndex)
  const queryString = queryIndex === -1 ? '' : url.slice(queryIndex + 1)
  const params = new URLSearchParams(queryString)
  const forwarded = params.get('cmh_path')
  if (forwarded) {
    params.delete('cmh_path')
    const rest = params.toString()
    const suffix = forwarded.replace(/^\/+/, '')
    req.url = `/api/${suffix}${rest ? `?${rest}` : ''}`
    return
  }
  if (pathOnly === '/api' || pathOnly.startsWith('/api/')) return
  const suffix = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`
  req.url = `/api${suffix}${queryString ? `?${queryString}` : ''}`
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  restoreApiPrefix(req)
  const pathOnly = (req.url ?? '/').split('?')[0]
  if (pathOnly === '/api/health') {
    app(req, res)
    return
  }
  if (pathOnly === '/api/health/auth') {
    try {
      const report = await adminAuthReport()
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(report))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'The administrator check failed.'
      res.statusCode = 503
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: redactConnectionStrings(message).replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[redacted-email]') }))
    }
    return
  }
  try {
    await prepare()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'The company database is not available.'
    res.statusCode = 503
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: redactConnectionStrings(message) }))
    return
  }
  app(req, res)
}
