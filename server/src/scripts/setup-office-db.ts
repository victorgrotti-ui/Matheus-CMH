import { execFileSync } from 'child_process'
import path from 'path'
import { isPostgresUrl } from '../lib/database-file'
import { redactConnectionStrings } from '../lib/postgres-url'
import { officeDatabaseCommands } from '../lib/office-setup'
import { prisma } from '../lib/prisma'

function prepareDatabase() {
  const root = path.resolve(__dirname, '../../..')
  for (const step of officeDatabaseCommands(root)) {
    execFileSync(step.command, step.args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    })
  }
}

async function main() {
  if (!isPostgresUrl() || !process.env.DIRECT_URL) {
    console.error('Set DATABASE_URL and DIRECT_URL to the Supabase PostgreSQL connection strings.')
    console.error('Supabase → Project Settings → Database. Use the pooler URL for DATABASE_URL and the direct URL for DIRECT_URL.')
    process.exit(1)
  }

  console.log('Applying migrations on Supabase. Existing company rows are not deleted.')
  prepareDatabase()

  const [users, employees, services, expenses, payments, settings] = await Promise.all([
    prisma.user.count(),
    prisma.employee.count(),
    prisma.service.count(),
    prisma.expense.count(),
    prisma.payment.count(),
    prisma.companySettings.count(),
  ])
  console.log(`Administrators: ${users}`)
  console.log(`Employees: ${employees}`)
  console.log(`Services: ${services}`)
  console.log(`Expenses: ${expenses}`)
  console.log(`Payments: ${payments}`)
  console.log(`Company settings: ${settings}`)
  if (employees + services + expenses + payments > 0) {
    console.log('This database already has records. They were left in place.')
    return
  }
  console.log('The company database is ready. It has no employees, services, expenses or payments.')
  console.log('Create the administrator next with npm run admin:create')
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(redactConnectionStrings(message))
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
