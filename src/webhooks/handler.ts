import crypto from "crypto";
import { Request, Response } from "express";
import { Store } from "../state/store";
import { config } from "../config";
import { logger } from "../http/logger";

type AirwallexWebhookEvent = {
  id: string;
  name: string;
  created_at?: string;
  data?: unknown;
  version?: string;
  [k: string]: unknown;
};

function getHeader(req: Request, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (!v) return null;
  return Array.isArray(v) ? v[0] : v;
}

export async function handleAirwallexWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = (req as unknown as { body: Buffer }).body;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).send("Missing raw request body");
    return;
  }

  const timestamp = getHeader(req, "x-timestamp");
  const signature = getHeader(req, "x-signature");

  if (!timestamp || !signature) {
    res.status(400).send("Missing signature headers");
    return;
  }

  const expected = crypto
    .createHmac("sha256", config.AIRWALLEX_WEBHOOK_SECRET)
    .update(timestamp)
    .update(rawBody)
    .digest("hex");

  if (expected !== signature) {
    logger.warn({ timestamp }, "Webhook signature verification failed");
    res.status(400).send("Invalid signature");
    return;
  }

  let event: AirwallexWebhookEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as AirwallexWebhookEvent;
  } catch {
    res.status(400).send("Invalid JSON");
    return;
  }

  if (!event?.id || !event?.name) {
    res.status(400).send("Missing event id/name");
    return;
  }

  const store = new Store();
  try {
    const inserted = await store.enqueueWebhookEvent({
      eventId: event.id,
      eventName: event.name,
      payload: event,
    });

    // Always 200 OK to acknowledge; if it was a duplicate we still succeed.
    res.status(200).json({ ok: true, inserted });
  } catch (err) {
    logger.error({ err, eventId: event.id }, "Failed to enqueue webhook event");
    // Still respond 200 only if you want to swallow errors; here we return 500 so Sevalla may retry.
    res.status(500).send("Failed to enqueue");
  } finally {
    await store.close();
  }
}

