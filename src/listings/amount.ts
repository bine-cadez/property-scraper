export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const compact = value.replace(/(\d)\s+(?=\d)/g, "$1");
  if (/(?:^|[^\d])[-−]\s*\d/.test(compact)) return null;
  const match = compact.replace(/\s/g, "").match(/\d[\d.,]*/);
  if (!match) return null;
  let numeric = match[0];
  if (numeric.includes(",")) numeric = numeric.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(numeric)) numeric = numeric.replace(/\./g, "");
  const parsed = Number(numeric);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
