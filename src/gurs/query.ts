export type QueryParameters = Record<string, unknown>;

export class ApiValidationError extends Error {
  statusCode = 400;
}

export function singleQueryValue(
  query: QueryParameters,
  name: string,
): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ApiValidationError(`${name} must be supplied once`);
  }
  return value;
}

export function assertKnownFilters(
  query: QueryParameters,
  known: readonly string[],
): void {
  const allowed = new Set(["cursor", "limit", ...known]);
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ApiValidationError(
      `Unknown filter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

export function parsePage(query: QueryParameters): {
  limit: number;
  cursor?: string;
} {
  const rawLimit = singleQueryValue(query, "limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApiValidationError("limit must be an integer between 1 and 200");
  }
  const cursor = singleQueryValue(query, "cursor");
  return { limit, ...(cursor ? { cursor: decodeCursor(cursor) } : {}) };
}

export function encodeCursor(value: string): string {
  return Buffer.from(JSON.stringify({ value }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { value?: unknown };
    if (typeof parsed.value !== "string") throw new Error("invalid");
    return parsed.value;
  } catch {
    throw new ApiValidationError("cursor is invalid");
  }
}

export function parseNumberFilter(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiValidationError(`${name} must be a number`);
  }
  return parsed;
}

export function parseBooleanFilter(value: string, name: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ApiValidationError(`${name} must be true or false`);
}

export function parseBbox(value: string): [number, number, number, number] {
  const coordinates = value.split(",").map(Number);
  if (
    coordinates.length !== 4 ||
    coordinates.some((coordinate) => !Number.isFinite(coordinate))
  ) {
    throw new ApiValidationError(
      "bbox must contain minLon,minLat,maxLon,maxLat",
    );
  }
  const [minLon, minLat, maxLon, maxLat] = coordinates as [
    number,
    number,
    number,
    number,
  ];
  if (
    minLon < -180 ||
    maxLon > 180 ||
    minLat < -90 ||
    maxLat > 90 ||
    minLon >= maxLon ||
    minLat >= maxLat
  ) {
    throw new ApiValidationError("bbox is outside WGS84 bounds");
  }
  return [minLon, minLat, maxLon, maxLat];
}

function camelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

export function serializeRow(
  row: Record<string, unknown>,
  numericFields: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      camelCase(key),
      numericFields.has(key) && value !== null ? Number(value) : value,
    ]),
  );
}
