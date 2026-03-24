import { z } from "zod";

/**
 * Env vars are always strings | undefined. `z.coerce.number().default(n)` can still
 * produce NaN when the key is missing (Number(undefined) === NaN), so we preprocess
 * missing/empty/invalid values to a default before validating.
 */
function envPositiveInt(defaultValue: number) {
  return z.preprocess((val: unknown) => {
    if (val === undefined || val === null || val === "") return defaultValue;
    const n =
      typeof val === "number" ? val : Number(String(val).trim());
    if (!Number.isFinite(n) || n <= 0) return defaultValue;
    return Math.floor(n);
  }, z.number().int().positive());
}

const envSchema = z.object({
  PORT: envPositiveInt(8080),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),

  AIRWALLEX_CLIENT_ID: z.string().min(1),
  AIRWALLEX_API_KEY: z.string().min(1),
  AIRWALLEX_WEBHOOK_SECRET: z.string().min(1),
  AIRWALLEX_API_BASE_URL: z.string().default("https://api.airwallex.com"),

  CHARTMOGUL_API_KEY: z.string().min(1),
  CHARTMOGUL_DATA_SOURCE_UUID: z.string().optional(),
  CHARTMOGUL_DATA_SOURCE_NAME: z.string().optional().default("Airwallex billing (leadpdfeditor.com)"),

  SYNC_RECONCILE_DAYS: envPositiveInt(60),
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);
