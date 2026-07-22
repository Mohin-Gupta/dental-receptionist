import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { syncConfiguredPriceVersions } from './priceCatalog';

async function main() {
  const result = await syncConfiguredPriceVersions();
  console.log('Local billing price catalog synchronized', result);
}

main()
  .catch((error) => {
    console.error('Local billing price catalog synchronization failed', {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : 'unknown error',
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
