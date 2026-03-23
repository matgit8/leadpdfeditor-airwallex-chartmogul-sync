import { Store } from "../state/store";
import { logger } from "../http/logger";
import { runBackfill } from "./backfill";

function formatIsoUtc(d: Date): string {
  return d.toISOString();
}

export async function runReconciliation(args: { store: Store; days: number }): Promise<void> {
  const now = new Date();
  const endDate = formatIsoUtc(now);

  const start = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000);
  const startDate = formatIsoUtc(start);

  logger.info({ startDate, endDate, days: args.days }, "Reconciliation window computed");

  await runBackfill({ store: args.store, startDate, endDate });

  await args.store.setState({
    key: "airwallex_reconciliation_last_run",
    value: { endDate, startDate, runAt: now.toISOString(), days: args.days },
  });

  logger.info("Reconciliation completed");
}

