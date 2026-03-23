import { Pool, PoolClient } from "pg";
import { config } from "../config";

export type WebhookEventRow = {
  eventId: string;
  eventName: string;
  payload: unknown;
  attempts: number;
};

export class Store {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: config.DATABASE_URL });
  }

  async migrateIfNeeded(): Promise<void> {
    // Intentionally lightweight: the migrations themselves live in /migrations.
    // For safety, we only run a minimal schema creation here.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sync_webhook_events (
        event_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        payload JSONB NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        processing_started_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sync_invoices (
        invoice_external_id TEXT PRIMARY KEY,
        customer_external_id TEXT NOT NULL,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        status TEXT NOT NULL DEFAULT 'imported',
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sync_chartmogul_customers (
        external_id TEXT PRIMARY KEY,
        chartmogul_customer_uuid TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sync_chartmogul_plans (
        external_id TEXT PRIMARY KEY,
        chartmogul_plan_uuid TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async enqueueWebhookEvent(args: {
    eventId: string;
    eventName: string;
    payload: unknown;
  }): Promise<boolean> {
    await this.migrateIfNeeded();

    const res = await this.pool.query(
      `
      INSERT INTO sync_webhook_events (event_id, event_name, payload)
      VALUES ($1, $2, $3)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
      `,
      [args.eventId, args.eventName, args.payload]
    );
    return res.rowCount === 1;
  }

  async claimQueuedWebhookEvents(limit: number): Promise<WebhookEventRow[]> {
    await this.migrateIfNeeded();

    const res = await this.pool.query(
      `
      UPDATE sync_webhook_events
      SET status = 'processing',
          attempts = attempts + 1,
          processing_started_at = now(),
          updated_at = now(),
          last_error = NULL
      WHERE event_id IN (
        SELECT event_id
        FROM sync_webhook_events
        WHERE status = 'queued'
        ORDER BY received_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING event_id, event_name, payload, attempts
      `,
      [limit]
    );

    return res.rows.map((r) => ({
      eventId: r.event_id,
      eventName: r.event_name,
      payload: r.payload,
      attempts: r.attempts,
    }));
  }

  async markWebhookEventDone(eventId: string): Promise<void> {
    await this.migrateIfNeeded();
    await this.pool.query(
      `
      UPDATE sync_webhook_events
      SET status = 'done',
          processed_at = now(),
          updated_at = now()
      WHERE event_id = $1
      `,
      [eventId]
    );
  }

  async markWebhookEventFailed(args: {
    eventId: string;
    error: unknown;
  }): Promise<void> {
    await this.migrateIfNeeded();
    const msg =
      args.error instanceof Error ? args.error.message : JSON.stringify(args.error);
    await this.pool.query(
      `
      UPDATE sync_webhook_events
      SET status = 'failed',
          last_error = $2,
          updated_at = now()
      WHERE event_id = $1
      `,
      [args.eventId, msg]
    );
  }

  async isInvoiceImported(invoiceExternalId: string): Promise<boolean> {
    await this.migrateIfNeeded();
    const res = await this.pool.query(
      `
      SELECT 1
      FROM sync_invoices
      WHERE invoice_external_id = $1
      `,
      [invoiceExternalId]
    );
    return res.rowCount === 1;
  }

  async recordInvoiceImport(args: {
    invoiceExternalId: string;
    customerExternalId: string;
    status?: string;
  }): Promise<void> {
    await this.migrateIfNeeded();
    await this.pool.query(
      `
      INSERT INTO sync_invoices (invoice_external_id, customer_external_id, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (invoice_external_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = now()
      `,
      [args.invoiceExternalId, args.customerExternalId, args.status ?? "imported"]
    );
  }

  async getChartMogulCustomerUuid(externalId: string): Promise<string | null> {
    await this.migrateIfNeeded();
    const res = await this.pool.query(
      `
      SELECT chartmogul_customer_uuid
      FROM sync_chartmogul_customers
      WHERE external_id = $1
      `,
      [externalId]
    );
    return res.rowCount === 0 ? null : res.rows[0].chartmogul_customer_uuid;
  }

  async setChartMogulCustomerUuid(args: {
    externalId: string;
    chartmogulCustomerUuid: string;
  }): Promise<void> {
    await this.migrateIfNeeded();
    await this.pool.query(
      `
      INSERT INTO sync_chartmogul_customers (external_id, chartmogul_customer_uuid)
      VALUES ($1, $2)
      ON CONFLICT (external_id)
      DO UPDATE SET chartmogul_customer_uuid = EXCLUDED.chartmogul_customer_uuid, updated_at = now()
      `,
      [args.externalId, args.chartmogulCustomerUuid]
    );
  }

  async getChartMogulPlanUuid(externalId: string): Promise<string | null> {
    await this.migrateIfNeeded();
    const res = await this.pool.query(
      `
      SELECT chartmogul_plan_uuid
      FROM sync_chartmogul_plans
      WHERE external_id = $1
      `,
      [externalId]
    );
    return res.rowCount === 0 ? null : res.rows[0].chartmogul_plan_uuid;
  }

  async setChartMogulPlanUuid(args: {
    externalId: string;
    chartmogulPlanUuid: string;
  }): Promise<void> {
    await this.migrateIfNeeded();
    await this.pool.query(
      `
      INSERT INTO sync_chartmogul_plans (external_id, chartmogul_plan_uuid)
      VALUES ($1, $2)
      ON CONFLICT (external_id)
      DO UPDATE SET chartmogul_plan_uuid = EXCLUDED.chartmogul_plan_uuid, updated_at = now()
      `,
      [args.externalId, args.chartmogulPlanUuid]
    );
  }

  async getState<T = unknown>(key: string): Promise<T | null> {
    await this.migrateIfNeeded();
    const res = await this.pool.query(
      `
      SELECT value
      FROM sync_state
      WHERE key = $1
      `,
      [key]
    );
    if (res.rowCount === 0) return null;
    return res.rows[0].value as T;
  }

  async setState(args: { key: string; value: unknown }): Promise<void> {
    await this.migrateIfNeeded();
    await this.pool.query(
      `
      INSERT INTO sync_state (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `,
      [args.key, args.value]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
}

