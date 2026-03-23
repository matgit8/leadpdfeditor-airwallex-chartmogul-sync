import { Store } from "../state/store";
import { logger } from "../http/logger";

async function main() {
  const store = new Store();
  await store.migrateIfNeeded();
  logger.info("DB schema ready");
  await store.close();
}

main().catch((err) => {
  logger.error({ err }, "Failed to initialize DB schema");
  process.exit(1);
});

