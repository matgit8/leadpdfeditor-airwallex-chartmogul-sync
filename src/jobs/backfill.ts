import { Store } from "../state/store";
import { logger } from "../http/logger";
import { AirwallexClient } from "../airwallex/client";
import { ChartMogulClient } from "../chartmogul/client";
import { config } from "../config";
import { mapInvoiceToChartMogulInvoicePayload } from "../mapping/toChartmogul";

const PLAN_EXTERNAL_IDS = {
  trial: "trial_1w_199",
  monthly: "monthly_1m_4999",
};

export async function runBackfill(args: { store: Store; startDate: string; endDate: string }): Promise<void> {
  const { store } = args;
  const airwallex = new AirwallexClient();
  const chartmogul = new ChartMogulClient();

  await store.migrateIfNeeded();

  const dataSourceUuid = await chartmogul.ensureDataSourceUuid(config.CHARTMOGUL_DATA_SOURCE_NAME ?? "Airwallex billing");
  logger.info({ startDate: args.startDate, endDate: args.endDate, dataSourceUuid }, "Backfill starting");

  // Ensure ChartMogul plans exist (we key them by stable external_id)
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
      intervalCount: args.intervalCount,
      intervalUnit: args.intervalUnit,
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

  const invoicesBufferByCustomer: Record<string, unknown[]> = {};
  const invoicesBufferMax = 25;

  async function flushCustomerInvoices(customerUuid: string) {
    const invoices = invoicesBufferByCustomer[customerUuid];
    if (!invoices || invoices.length === 0) return;
    await chartmogul.importInvoices({ customerUuid, invoices });
    invoicesBufferByCustomer[customerUuid] = [];
  }

  let pageAfter: string | undefined = undefined;
  let importedCount = 0;
  let skippedCount = 0;

  // Loop invoices by Airwallex pagination cursor.
  while (true) {
    const resp = await airwallex.listInvoices({
      fromCreatedAt: args.startDate,
      toCreatedAt: args.endDate,
      pageSize: 50,
      status: "FINALIZED",
      paymentStatus: "PAID",
      pageAfter,
    });

    const items = resp.items ?? [];
    if (items.length === 0) break;

    for (const inv of items) {
      if (!inv.subscription_id) continue;

      const alreadyImported = await store.isInvoiceImported(inv.id);
      if (alreadyImported) {
        skippedCount += 1;
        continue;
      }

      const sub = await airwallex.retrieveSubscription(inv.subscription_id);
      const customerExternalId = inv.billing_customer_id;

      let customerUuid = await store.getChartMogulCustomerUuid(customerExternalId);
      if (!customerUuid) {
        customerUuid = await chartmogul.createCustomer({
          dataSourceUuid,
          externalId: customerExternalId,
          company: customerExternalId,
        });
        await store.setChartMogulCustomerUuid({
          externalId: customerExternalId,
          chartmogulCustomerUuid: customerUuid,
        });
      }

      const mapped = mapInvoiceToChartMogulInvoicePayload({
        dataSourceUuid,
        airwallexInvoice: inv,
        airwallexSubscription: sub,
        planUuids: { trial: trialPlanUuid, monthly: monthlyPlanUuid },
        subscriptionExternalId: inv.subscription_id,
      });

      invoicesBufferByCustomer[customerUuid] ??= [];
      invoicesBufferByCustomer[customerUuid].push(mapped.invoice);

      if (invoicesBufferByCustomer[customerUuid].length >= invoicesBufferMax) {
        await flushCustomerInvoices(customerUuid);
      }

      // Record as imported immediately after we enqueue into the buffer.
      // ChartMogul import runs async, but invoice dedupe prevents double-importing
      // on subsequent reconciliation runs.
      await store.recordInvoiceImport({
        invoiceExternalId: inv.id,
        customerExternalId,
        status: "import_requested",
      });

      importedCount += 1;
    }

    pageAfter = resp.page_after ?? undefined;
    if (!pageAfter) break;
  }

  // Final flush for all customers.
  for (const customerUuid of Object.keys(invoicesBufferByCustomer)) {
    await flushCustomerInvoices(customerUuid);
  }

  logger.info(
    { importedCount, skippedCount },
    "Backfill finished"
  );
}

