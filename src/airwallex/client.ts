import { config } from "../config";
import { logger } from "../http/logger";

type AirwallexAuthResponse = {
  token: string;
  expires_at: string;
};

type AirwallexListResponse<T> = {
  items: T[];
  page_after?: string | null;
  page_before?: string | null;
};

export type AirwallexInvoice = {
  id: string;
  number?: string;
  created_at: string;
  due_at?: string;
  currency: string;
  total_amount: number;
  total_tax_amount: number;
  subscription_id?: string;
  billing_customer_id: string;
  paid_at?: string;
  payment_status: "PAID" | "UNPAID" | string;
  status: "DRAFT" | "FINALIZED" | "VOIDED" | string;
  updated_at?: string;
};

export type AirwallexSubscription = {
  id: string;
  status: "PENDING" | "IN_TRIAL" | "ACTIVE" | "UNPAID" | "CANCELLED" | string;
  trial_starts_at?: string | null;
  trial_ends_at?: string | null;
  current_period_starts_at?: string | null;
  current_period_ends_at?: string | null;
};

export class AirwallexClient {
  private token: string | null = null;
  private expiresAtMs: number = 0;

  private authBaseUrl(): string {
    // config.AIRWALLEX_API_BASE_URL is typically https://api.airwallex.com
    return config.AIRWALLEX_API_BASE_URL.replace(/\/+$/, "");
  }

  private async getAuthToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.expiresAtMs - 60_000) {
      return this.token;
    }

    const res = await fetch(`${this.authBaseUrl()}/api/v1/authentication/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-client-id": config.AIRWALLEX_CLIENT_ID,
        "x-api-key": config.AIRWALLEX_API_KEY,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error({ status: res.status, text: text.slice(0, 400) }, "Airwallex auth failed");
      throw new Error(`Airwallex auth failed: ${res.status}`);
    }

    const json = (await res.json()) as AirwallexAuthResponse;
    this.token = json.token;
    this.expiresAtMs = Date.parse(json.expires_at);
    return this.token;
  }

  async getAccessToken(): Promise<string> {
    return this.getAuthToken();
  }

  private async apiRequest<T>(args: {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
  }): Promise<T> {
    const token = await this.getAuthToken();
    const url = new URL(`${this.authBaseUrl()}${args.path}`);
    if (args.query) {
      for (const [k, v] of Object.entries(args.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      method: args.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error({ status: res.status, text: text.slice(0, 500) }, "Airwallex API request failed");
      throw new Error(`Airwallex request failed: ${res.status}`);
    }

    return (await res.json()) as T;
  }

  async listInvoices(args: {
    fromCreatedAt: string;
    toCreatedAt: string;
    pageSize?: number;
    status?: string;
    paymentStatus?: string;
    billingCustomerId?: string;
    subscriptionId?: string;
    pageAfter?: string;
  }): Promise<AirwallexListResponse<AirwallexInvoice>> {
    return this.apiRequest<AirwallexListResponse<AirwallexInvoice>>({
      method: "GET",
      path: "/api/v1/invoices",
      query: {
        from_created_at: args.fromCreatedAt,
        to_created_at: args.toCreatedAt,
        page_size: args.pageSize ?? 20,
        status: args.status,
        payment_status: args.paymentStatus,
        billing_customer_id: args.billingCustomerId,
        subscription_id: args.subscriptionId,
        page: args.pageAfter,
      },
    });
  }

  async retrieveSubscription(subscriptionId: string): Promise<AirwallexSubscription> {
    return this.apiRequest<AirwallexSubscription>({
      method: "GET",
      path: `/api/v1/subscriptions/${subscriptionId}`,
    });
  }
}

