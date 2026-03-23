import { Store } from "../state/store";
import { AirwallexClient } from "../airwallex/client";
import { ChartMogulClient } from "../chartmogul/client";
import { config } from "../config";
import { logger } from "../http/logger";
import { mapInvoiceToChartMogulInvoicePayload } from "../mapping/toChartmogul";

const PLAN_EXTERNAL_IDS = {
  trial: "trial_1w_199",
  monthly: "monthly_1m_4999",
};

const PRICES_CENTS = {
  trial: 199,
  monthly: 4999,
};

function extractWebhookObject(payload: any): any {
  // Airwallex webhook payload generally looks like:
  // { id, name, created_at, data: { ... } }
  // Some versions embed the returned object under data.object.
  if (!payload) return payload;
  if (payload.data?.object) return payload.data.object;
  if (payload.data) return payload.data;
  return payload;
}

function pickDate(args: { primary?: string | null; fallback?: string | null }): string {
  return args.primary ?? args.fallback ?? new Date().toISOString();
}

export async function processWebhookEvent(args: {
  event: { eventId: string; eventName: string; payload: unknown };
  _store: Store;
}): Promise<void> {
  const { event } = args;
  const store = args._store;
  const airwallex = new AirwallexClient();
  const chartmogul = new ChartMogulClient();

  const payload = event.payload as any;
  const object = extractWebhookObject(payload);

  // Ensure core mappings exist (plans + data source UUID + charts)
  const dataSourceUuid = await chartmogul.ensureDataSourceUuid(config.CHARTMOGUL_DATA_SOURCE_NAME ?? "Airwallex billing");

  async function ensurePlan(args: {
    externalId: string;
    name: string;
    intervalUnit: "day" | "month" | "year";
    intervalCount: number;
  }): Promise<string> {
    const existing = await store.getChartMogulPlanUuid(args.externalId);
    if (existing) return existing;
    const created = await chartmogul.createPlan({
      dataSourceUuid,
      name: args.name,
      intervalUnit: args.intervalUnit,
      intervalCount: args.intervalCount,
      externalId: args.externalId,
    });
    await store.setChartMogulPlanUuid({ externalId: args.externalId, chartmogulPlanUuid: created });
    return created;
  }

  const trialPlanUuid = await ensurePlan({
    externalId: PLAN_EXTERNAL_IDS.trial,
    name: "Trial (1 week) - $1.99",
    intervalUnit: "day",
    intervalCount: 7,
  });

  const monthlyPlanUuid = await ensurePlan({
    externalId: PLAN_EXTERNAL_IDS.monthly,
    name: "Monthly - $49.99",
    intervalUnit: "month",
    intervalCount: 1,
  });

  async function ensureCustomer(customerExternalId: string): Promise<string> {
    const existing = await store.getChartMogulCustomerUuid(customerExternalId);
    if (existing) return existing;
    const created = await chartmogul.createCustomer({
      dataSourceUuid,
      externalId: customerExternalId,
      company: customerExternalId,
    });
    await store.setChartMogulCustomerUuid({
      externalId: customerExternalId,
      chartmogulCustomerUuid: created,
    });
    return created;
  }

  // 1) Invoice-related events -> import invoice when paid
  if (event.eventName.startsWith("invoice.")) {
    const invoice = object;
    const invoiceId = invoice?.id ?? event.eventId;

    // Dedupe invoice imports
    const already = await store.isInvoiceImported(invoiceId);
    if (already) {
      logger.info({ invoiceId }, "Invoice already imported; skipping");
      return;
    }

    const subscriptionId = invoice?.subscription_id ?? invoice?.subscriptionId;
    const billingCustomerId = invoice?.billing_customer_id ?? invoice?.billingCustomerId;
    const paymentStatus = invoice?.payment_status;

    // Only import when paid (backfill also imports PAID invoices).
    if (paymentStatus !== "PAID") {
      logger.info({ invoiceId, paymentStatus }, "Invoice not PAID; skipping import");
      return;
    }
    if (!subscriptionId || !billingCustomerId) {
      logger.warn(
        { invoiceId, subscriptionId, billingCustomerId },
        "Missing subscription_id or billing_customer_id; cannot import"
      );
      return;
    }

    const sub = await airwallex.retrieveSubscription(subscriptionId);
    const customerUuid = await ensureCustomer(billingCustomerId);

    const mapped = mapInvoiceToChartMogulInvoicePayload({
      dataSourceUuid,
      airwallexInvoice: {
        id: invoice.id,
        number: invoice.number,
        created_at: invoice.created_at ?? invoice.updated_at ?? payload?.created_at ?? new Date().toISOString(),
        due_at: invoice.due_at,
        currency: invoice.currency,
        total_amount: invoice.total_amount,
        total_tax_amount: invoice.total_tax_amount,
        subscription_id: invoice.subscription_id,
        billing_customer_id: invoice.billing_customer_id,
        paid_at: invoice.paid_at,
        payment_status: invoice.payment_status,
        status: invoice.status,
        updated_at: invoice.updated_at,
      },
      airwallexSubscription: sub,
      planUuids: { trial: trialPlanUuid, monthly: monthlyPlanUuid },
      subscriptionExternalId: subscriptionId,
    });

    await chartmogul.importInvoices({ customerUuid, invoices: [mapped.invoice] });
    await store.recordInvoiceImport({
      invoiceExternalId: invoiceId,
      customerExternalId: billingCustomerId,
      status: "import_requested",
    });
    logger.info({ invoiceId }, "Imported invoice into ChartMogul");
    return;
  }

  // 2) Subscription-related events -> subscription_events in ChartMogul
  if (event.eventName.startsWith("subscription.")) {
    const subscription = object;
    const subscriptionExternalId = subscription?.id ?? subscription?.subscription_id;
    const customerExternalId =
      subscription?.billing_customer_id ?? subscription?.customer_id ?? subscription?.billingCustomerId;

    if (!subscriptionExternalId || !customerExternalId) {
      logger.warn(
        { subscriptionExternalId, customerExternalId },
        "Missing subscription id or customer id; skipping subscription event"
      );
      return;
    }

    const webhookCreatedAt = payload?.created_at ?? payload?.data?.created_at ?? new Date().toISOString();
    const status = subscription?.status;

    // Trial start (paid trial) -> subscription_start
    if (status === "IN_TRIAL" || event.eventName === "subscription.in_trial") {
      const trialStart =
        subscription?.trial_starts_at ?? subscription?.trial_start_at ?? subscription?.starts_at;
      const trialEnd =
        subscription?.trial_ends_at ?? subscription?.trial_end_at ?? subscription?.ends_at;

      const effectiveDate = trialStart ?? pickDate({ primary: trialStart, fallback: webhookCreatedAt });

      await ensureCustomer(customerExternalId);
      await chartmogul.createSubscriptionEvent({
        dataSourceUuid,
        subscriptionEvent: {
          external_id: event.eventId,
          customer_external_id: customerExternalId,
          event_type: "subscription_start",
          event_date: formatChartmogulDate(webhookCreatedAt),
          effective_date: formatChartmogulDate(effectiveDate),
          subscription_external_id: subscriptionExternalId,
          plan_external_id: PLAN_EXTERNAL_IDS.trial,
          currency: subscription?.currency ?? "USD",
          amount_in_cents: PRICES_CENTS.trial,
        },
      });
      logger.info({ subscriptionExternalId }, "Imported subscription trial start event");
      return;
    }

    // Monthly activation -> subscription_start
    if (status === "ACTIVE" || event.eventName === "subscription.active") {
      const currentStart =
        subscription?.current_period_starts_at ??
        subscription?.current_period_start_at ??
        subscription?.starts_at;

      const effectiveDate = currentStart ?? pickDate({ primary: currentStart, fallback: webhookCreatedAt });

      await ensureCustomer(customerExternalId);
      await chartmogul.createSubscriptionEvent({
        dataSourceUuid,
        subscriptionEvent: {
          external_id: event.eventId,
          customer_external_id: customerExternalId,
          event_type: "subscription_start",
          event_date: formatChartmogulDate(webhookCreatedAt),
          effective_date: formatChartmogulDate(effectiveDate),
          subscription_external_id: subscriptionExternalId,
          plan_external_id: PLAN_EXTERNAL_IDS.monthly,
          currency: subscription?.currency ?? "USD",
          amount_in_cents: PRICES_CENTS.monthly,
        },
      });
      logger.info({ subscriptionExternalId }, "Imported subscription monthly start event");
      return;
    }

    // Cancellation -> subscription_cancelled or subscription_cancellation_scheduled
    if (status === "CANCELLED" || event.eventName === "subscription.cancelled") {
      const cancelAt =
        subscription?.cancel_at ?? subscription?.cancelAt ?? subscription?.ends_at ?? webhookCreatedAt;
      const cancelAtPeriodEnd =
        subscription?.cancel_at_period_end ?? subscription?.cancelAtPeriodEnd ?? false;

      await ensureCustomer(customerExternalId);

      const eventType = cancelAtPeriodEnd
        ? "subscription_cancellation_scheduled"
        : "subscription_cancelled";

      await chartmogul.createSubscriptionEvent({
        dataSourceUuid,
        subscriptionEvent: {
          external_id: event.eventId,
          customer_external_id: customerExternalId,
          event_type: eventType,
          event_date: formatChartmogulDate(webhookCreatedAt),
          effective_date: formatChartmogulDate(cancelAt),
          subscription_external_id: subscriptionExternalId,
        },
      });

      logger.info({ subscriptionExternalId, eventType }, "Imported subscription cancellation event");
      return;
    }
  }

  logger.debug({ eventName: event.eventName }, "Webhook event not handled; ignoring");
}

function formatChartmogulDate(isoOrDate: string): string {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  // ChartMogul examples often use YYYY-MM-DD without time for subscription events.
  return d.toISOString().slice(0, 10);
}


