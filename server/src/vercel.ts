import type { IncomingMessage, ServerResponse } from 'http'
import { createApp } from './app'
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

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
