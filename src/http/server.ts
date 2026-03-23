import express from "express";
import { config } from "../config";
import { handleAirwallexWebhook } from "../webhooks/handler";
import { logger } from "./logger";

export function createServer() {
  const app = express();

  // IMPORTANT: use raw body so signature verification uses the unmodified payload bytes.
  app.post(
    "/webhooks/airwallex",
    express.raw({ type: "application/json" }),
    (req, res) => {
      void handleAirwallexWebhook(req, res);
    }
  );

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use((_req, res) => {
    res.status(404).send("Not found");
  });

  return app;
}

export async function startServer() {
  const app = createServer();
  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "Webhook server listening");
  });
}

