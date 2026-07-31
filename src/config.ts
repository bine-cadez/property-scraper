export type DatabaseConfig = {
  databaseUrl: string;
};

export type AppConfig = DatabaseConfig & {
  nodeEnv: string;
  host: string;
  port: number;
  authKey: string;
  corsOrigins?: string[];
};

export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  return {
    databaseUrl:
      env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5433/property_scraper",
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 3000);
  const authKey = env.AUTH_KEY?.trim();

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  if (!authKey) {
    throw new Error("AUTH_KEY must be set to a non-empty value");
  }

  return {
    nodeEnv: env.NODE_ENV ?? "development",
    host: env.HOST ?? "0.0.0.0",
    port,
    ...loadDatabaseConfig(env),
    authKey,
    corsOrigins: (env.CORS_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
