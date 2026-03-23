import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),

  AIRWALLEX_CLIENT_ID: z.string().min(1),
  AIRWALLEX_API_KEY: z.string().min(1),
  AIRWALLEX_WEBHOOK_SECRET: z.string().min(1),
  AIRWALLEX_API_BASE_URL: z.string().default("https://api.airwallex.com"),

  CHARTMOGUL_API_KEY: z.string().min(1),
  CHARTMOGUL_DATA_SOURCE_UUID: z.string().optional(),
  CHARTMOGUL_DATA_SOURCE_NAME: z.string().optional().default("Airwallex billing (leadpdfeditor.com)"),

  SYNC_RECONCILE_DAYS: z.coerce.number().int().positive().default(60),
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);

