import type { IncomingMessage, ServerResponse } from 'http'

function requestUrl(req: IncomingMessage): string {
  return req.url ?? '/'
}

function isHealth(req: IncomingMessage): boolean {
  const url = requestUrl(req)
  const pathOnly = url.split('?')[0]
  if (pathOnly === '/api/health' || pathOnly === '/health') return true
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  return new URLSearchParams(query).get('cmh_path') === 'health'
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function webResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export default async function handler(req: IncomingMessage, res?: ServerResponse): Promise<void | Response> {
  try {
    if (!res || typeof res.setHeader !== 'function' || typeof res.end !== 'function') {
      return webResponse(200, { ok: true, service: 'CMH Cleaning Management System' })
    }
    if (isHealth(req)) {
      send(res, 200, { ok: true, service: 'CMH Cleaning Management System' })
      return
    }
    const loaded = await import('./app.mjs')
    await loaded.default(req, res)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'The API failed to start.'
    const body = { error: message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]').slice(0, 400) }
    if (res && typeof res.end === 'function') {
      send(res, 500, body)
      return
    }
    return webResponse(500, body)
  }
}
