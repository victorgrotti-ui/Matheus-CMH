import { execFileSync } from 'node:child_process'

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit', env: process.env })
}

run('npx', ['prisma', 'generate'])
if (process.env.DIRECT_URL) {
  console.log('Applying Supabase migrations. Existing rows are not deleted.')
  run('npx', ['prisma', 'migrate', 'deploy'])
} else {
  console.log('DIRECT_URL is not set. Migrations were skipped. No database rows were changed.')
}
run('npm', ['run', 'build', '-w', 'client'])
