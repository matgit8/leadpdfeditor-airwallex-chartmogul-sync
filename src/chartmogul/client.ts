import { config } from "../config";
import { logger } from "../http/logger";

type ChartMogulError = {
  message?: string;
  errors?: unknown;
};

function basicAuthHeader(apiKey: string): string {
  // ChartMogul uses HTTP Basic with API key as username and an empty password.
  const token = Buffer.from(`${apiKey}:`).toString("base64");
  return `Basic ${token}`;
}

export class ChartMogulClient {
  private apiKey: string;
  private baseUrl = "https://api.chartmogul.com/v1";

  constructor() {
    this.apiKey = config.CHARTMOGUL_API_KEY;
  }

  private async request<T>(args: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    json?: unknown;
  }): Promise<T> {
    const res = await fetch(`${this.baseUrl}${args.path}`, {
      method: args.method,
      headers: {
        Authorization: basicAuthHeader(this.apiKey),
        "Content-Type": "application/json",
      },
      body: args.json === undefined ? undefined : JSON.stringify(args.json),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: ChartMogulError | null = null;
      try {
        parsed = text ? (JSON.parse(text) as ChartMogulError) : null;
      } catch {
        parsed = null;
      }
      logger.error({ status: res.status, text: text.slice(0, 500) }, "ChartMogul API request failed");
      throw new Error(parsed?.message ?? `ChartMogul request failed: ${res.status}`);
    }

    // Some endpoints return 202 without body; guard JSON parsing.
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return undefined as unknown as T;
    }
    return (await res.json()) as T;
  }

  async retrieveAccount(): Promise<unknown> {
    return this.request({
      method: "GET",
      path: "/account",
    });
  }

  async ensureDataSourceUuid(storeExternalName: string): Promise<string> {
    if (config.CHARTMOGUL_DATA_SOURCE_UUID) return config.CHARTMOGUL_DATA_SOURCE_UUID;

    const created = await this.request<{ uuid: string }>({
      method: "POST",
      path: "/data_sources",
      json: { name: storeExternalName },
    });
    return created.uuid;
  }

  async createPlan(args: {
    dataSourceUuid: string;
    name: string;
    intervalCount: number;
    intervalUnit: "day" | "month" | "year";
    externalId: string;
  }): Promise<string> {
    const created = await this.request<{ uuid: string }>({
      method: "POST",
      path: "/plans",
      json: {
        data_source_uuid: args.dataSourceUuid,
        name: args.name,
        interval_count: args.intervalCount,
        interval_unit: args.intervalUnit,
        external_id: args.externalId,
      },
    });
    return created.uuid;
  }

  async createCustomer(args: {
    dataSourceUuid: string;
    externalId: string;
    name?: string;
    email?: string;
    company?: string;
    country?: string;
    websiteUrl?: string;
  }): Promise<string> {
    const created = await this.request<{ uuid: string }>({
      method: "POST",
      path: "/customers",
      json: {
        data_source_uuid: args.dataSourceUuid,
        external_id: args.externalId,
        name: args.name,
        email: args.email,
        company: args.company,
        country: args.country,
        website_url: args.websiteUrl,
      },
    });
    return created.uuid;
  }

  async importInvoices(args: {
    customerUuid: string;
    invoices: unknown[];
    // For custom source imports, this endpoint is:
    // POST /v1/import/customers/{customer_uuid}/invoices
  }): Promise<void> {
    await this.request({
      method: "POST",
      path: `/import/customers/${args.customerUuid}/invoices`,
      json: { invoices: args.invoices },
    });
  }

  async createSubscriptionEvent(args: {
    dataSourceUuid: string;
    subscriptionEvent: {
      external_id: string;
      customer_external_id: string;
      event_type: string;
      event_date: string;
      effective_date: string;
      subscription_external_id: string;
      plan_external_id?: string;
      currency?: string;
      amount_in_cents?: number;
      tax_amount_in_cents?: number;
      retracted_event_id?: string;
      event_order?: number;
      quantity?: number;
    };
  }): Promise<void> {
    await this.request({
      method: "POST",
      path: `/subscription_events`,
      json: {
        subscription_event: {
          ...args.subscriptionEvent,
          data_source_uuid: args.dataSourceUuid,
        },
      },
    });
  }
}

