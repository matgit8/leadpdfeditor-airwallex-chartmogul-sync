import dotenv from "dotenv";
import { Store } from "./state/store";
import { processWebhookEvent } from "./processor/eventProcessor";
import { logger } from "./http/logger";

dotenv.config();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorker() {
  const store = new Store();
  await store.migrateIfNeeded();
  logger.info("Worker started");

  // Infinite loop by design: Sevalla background worker pods restart on completion.
  let idleTicks = 0;
  while (true) {
    const events = await store.claimQueuedWebhookEvents(10);
    if (events.length === 0) {
      idleTicks += 1;
      // ~60s with 2s sleep: confirms worker is alive when queue is empty (common before webhooks/backfill).
      if (idleTicks % 30 === 0) {
        logger.info(
          "Worker idle: webhook queue empty — point Airwallex webhooks at POST /webhooks/airwallex, or run npm run start:backfill once"
        );
      }
      await sleep(2000);
      continue;
    }

    idleTicks = 0;
    logger.info({ count: events.length }, "Claimed queued webhook events");

    for (const ev of events) {
      try {
        await processWebhookEvent({
          event: { eventId: ev.eventId, eventName: ev.eventName, payload: ev.payload },
          _store: store,
        });
        await store.markWebhookEventDone(ev.eventId);
      } catch (err) {
        logger.error({ err, eventId: ev.eventId }, "Webhook event processing failed");
        await store.markWebhookEventFailed({ eventId: ev.eventId, error: err });
      }
    }
  }
}

runWorker().catch((err) => {
  logger.error({ err }, "Worker crashed");
  process.exit(1);
});


