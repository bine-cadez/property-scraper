export type AppConfig = {
  nodeEnv: string;
  host: string;
  port: number;
  databaseUrl: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 3000);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return {
    nodeEnv: env.NODE_ENV ?? "development",
    host: env.HOST ?? "0.0.0.0",
    port,
    databaseUrl:
      env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5433/property_scraper",
  };
}
