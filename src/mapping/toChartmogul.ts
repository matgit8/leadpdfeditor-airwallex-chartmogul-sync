import type { AirwallexInvoice, AirwallexSubscription } from "../airwallex/client";

function toCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function formatForChartMogulTimestamp(isoOrDate: string): string {
  // ChartMogul import docs frequently show `YYYY-MM-DD HH:mm:ss`.
  // We normalize to UTC to avoid timezone drift.
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) {
    // Fallback: pass through raw string.
    return isoOrDate;
  }
  const utc = d.toISOString(); // 2022-01-01T00:00:00.000Z
  return utc.replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function mapInvoiceToChartMogulInvoicePayload(args: {
  dataSourceUuid: string;
  airwallexInvoice: AirwallexInvoice;
  airwallexSubscription: AirwallexSubscription;
  planUuids: {
    trial: string;
    monthly: string;
  };
  // External IDs must be stable for idempotent imports.
  subscriptionExternalId: string;
}): {
  invoice: {
    external_id: string;
    date: string;
    currency: string;
    due_date?: string;
    data_source_uuid: string;
    line_items: unknown[];
    transactions: unknown[];
  };
  inferred: { lineItemType: "trial" | "subscription" };
} {
  const inv = args.airwallexInvoice;
  const sub = args.airwallexSubscription;

  const isTrial = sub.status === "IN_TRIAL";
  const trialStart = sub.trial_starts_at ?? null;
  const trialEnd = sub.trial_ends_at ?? null;

  const currentStart = sub.current_period_starts_at ?? null;
  const currentEnd = sub.current_period_ends_at ?? null;

  const servicePeriodStart = isTrial
    ? trialStart ?? inv.created_at
    : currentStart ?? inv.created_at;
  const servicePeriodEnd = isTrial
    ? trialEnd ?? (() => {
        const d = new Date(servicePeriodStart);
        if (Number.isNaN(d.getTime())) return inv.created_at;
        d.setUTCDate(d.getUTCDate() + 7);
        return d.toISOString();
      })()
    : currentEnd ?? (() => {
        // Fallback for missing period end; assume one month.
        const d = new Date(servicePeriodStart);
        if (Number.isNaN(d.getTime())) return inv.created_at;
        d.setUTCMonth(d.getUTCMonth() + 1);
        return d.toISOString();
      })();

  const amountInCents = toCents(inv.total_amount);
  const taxInCents = toCents(inv.total_tax_amount);

  const lineItem =
    isTrial
      ? {
          type: "trial",
          subscription_external_id: args.subscriptionExternalId,
          plan_uuid: args.planUuids.trial,
          service_period_start: formatForChartMogulTimestamp(servicePeriodStart),
          service_period_end: formatForChartMogulTimestamp(servicePeriodEnd),
          amount_in_cents: amountInCents,
          tax_amount_in_cents: taxInCents,
          quantity: 1,
          prorated: false,
        }
      : {
          type: "subscription",
          subscription_external_id: args.subscriptionExternalId,
          plan_uuid: args.planUuids.monthly,
          service_period_start: formatForChartMogulTimestamp(servicePeriodStart),
          service_period_end: formatForChartMogulTimestamp(servicePeriodEnd),
          amount_in_cents: amountInCents,
          tax_amount_in_cents: taxInCents,
          quantity: 1,
          prorated: false,
        };

  // For historical backfill we typically import only PAID invoices.
  const paidAt = inv.paid_at ?? inv.updated_at ?? inv.created_at;
  const tx = {
    date: formatForChartMogulTimestamp(paidAt),
    type: "payment",
    result: "successful",
  };

  return {
    inferred: { lineItemType: isTrial ? "trial" : "subscription" },
    invoice: {
      external_id: inv.number ?? inv.id,
      date: formatForChartMogulTimestamp(inv.created_at),
      due_date: inv.due_at ? formatForChartMogulTimestamp(inv.due_at) : undefined,
      currency: inv.currency,
      data_source_uuid: args.dataSourceUuid,
      line_items: [lineItem],
      transactions: [tx],
    },
  };
}

