import dotenv from "dotenv";
import { config } from "./config";
import { Store } from "./state/store";
import { runReconciliation } from "./jobs/reconcile";
import { logger } from "./http/logger";

dotenv.config();

async function main() {
  const store = new Store();
  try {
    await store.migrateIfNeeded();
    logger.info({ days: config.SYNC_RECONCILE_DAYS }, "Starting daily reconciliation");
    await runReconciliation({ store, days: config.SYNC_RECONCILE_DAYS });
    logger.info("Daily reconciliation finished");
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  logger.error({ err }, "Daily reconciliation failed");
  process.exit(1);
});

