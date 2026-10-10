import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit', env: process.env })
}

run('npx', ['prisma', 'generate'])
await build({
  entryPoints: ['server/src/vercel.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'client/server-bundle/app.mjs',
  external: ['@prisma/client', '@prisma/adapter-pg', 'pg'],
  banner: {
    js: [
      "import { createRequire as __cmhCreateRequire } from 'node:module';",
      "import { fileURLToPath as __cmhFileURLToPath } from 'node:url';",
      "import { dirname as __cmhDirname } from 'node:path';",
      'const __filename = __cmhFileURLToPath(import.meta.url);',
      'const __dirname = __cmhDirname(__filename);',
      'const require = __cmhCreateRequire(import.meta.url);',
    ].join('\n'),
  },
})
console.log('Bundled the API for Vercel. No database rows were changed.')
copyRuntimeModules()

function copyRuntimeModules() {
  const destination = 'client/server-bundle/node_modules'
  rmSync(destination, { recursive: true, force: true })
  const seen = new Set()
  for (const name of ['@prisma/client', '.prisma', '@prisma/adapter-pg', 'pg']) {
    const source = findInstalled(name)
    if (!source) throw new Error(`Missing ${name} after prisma generate.`)
    copyPackage(source, join(destination, name), seen)
  }
  console.log('Copied the database driver into the API folder. No database rows were changed.')
}

function findInstalled(name) {
  const folder = join('node_modules', name)
  if (!existsSync(folder)) return undefined
  if (name === '.prisma' || existsSync(join(folder, 'package.json'))) return folder
  return undefined
}

function copyPackage(source, destination, seen) {
  if (seen.has(source)) return
  seen.add(source)
  mkdirSync(join(destination, '..'), { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: true })
  const manifestPath = existsSync(join(source, 'package.json'))
    ? join(source, 'package.json')
    : join(source, 'client', 'package.json')
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const installed = findInstalled(dependency)
    if (!installed) continue
    copyPackage(installed, join('client/server-bundle/node_modules', dependency), seen)
  }
}
if (process.env.DIRECT_URL) {
  console.log('Applying Supabase migrations. Existing rows are not deleted.')
  run('npx', ['prisma', 'migrate', 'deploy'])
} else {
  console.log('DIRECT_URL is not set. Migrations were skipped. No database rows were changed.')
}
run('npm', ['run', 'build', '-w', 'client'])
