import dotenv from "dotenv";
import { z } from "zod";
import { Store } from "./state/store";
import { runBackfill } from "./jobs/backfill";
import { logger } from "./http/logger";
import { config } from "./config";

dotenv.config();

const envSchema = z.object({
  BACKFILL_START_DATE: z.string().min(1),
  BACKFILL_END_DATE: z.string().min(1),
});

async function main() {
  const { BACKFILL_START_DATE, BACKFILL_END_DATE } = envSchema.parse(process.env);
  const store = new Store();
  try {
    logger.info(
      { start: BACKFILL_START_DATE, end: BACKFILL_END_DATE, reconcileDays: config.SYNC_RECONCILE_DAYS },
      "Running backfill"
    );
    await store.migrateIfNeeded();
    await runBackfill({ store, startDate: BACKFILL_START_DATE, endDate: BACKFILL_END_DATE });
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  logger.error({ err }, "Backfill failed");
  process.exit(1);
});

