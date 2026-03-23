import dotenv from "dotenv";
import { Store } from "../state/store";
import { AirwallexClient } from "../airwallex/client";
import { ChartMogulClient } from "../chartmogul/client";
import { logger } from "../http/logger";

dotenv.config();

async function main() {
  const store = new Store();
  await store.migrateIfNeeded();

  const chartmogul = new ChartMogulClient();
  const account = await chartmogul.retrieveAccount();
  logger.info({ account }, "ChartMogul account reachable");

  const airwallex = new AirwallexClient();
  const token = await airwallex.getAccessToken();
  logger.info({ tokenLength: token.length }, "Airwallex auth token reachable");

  await store.close();
  logger.info("Smoke test finished");
}

main().catch((err) => {
  logger.error({ err }, "Smoke test failed");
  process.exit(1);
});

