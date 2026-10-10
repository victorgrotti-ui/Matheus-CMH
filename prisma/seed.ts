import { prisma } from '../server/src/lib/prisma'
import { redactConnectionStrings } from '../server/src/lib/postgres-url'

async function main() {
  await prisma.companySettings.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      companyName: 'CMH Cleaning',
      currency: 'GBP',
      defaultPaymentDay: 'SATURDAY',
    },
  })
  console.log('Company settings are ready. No sample employees, services or payments were added.')
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
