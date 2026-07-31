import { describe, expect, it } from "vitest";

import { buildCqlPredicateBatches, validateTransactionYear } from "./ingest.js";
import {
  ApiValidationError,
  decodeCursor,
  encodeCursor,
  parseBbox,
} from "./query.js";

describe("CQL batching", () => {
  it("deduplicates natural keys, bounds predicates, and escapes strings", () => {
    const predicates = buildCqlPredicateBatches(
      [
        { KO_ID: 1, ST_PARCELE: "12/3" },
        { KO_ID: 1, ST_PARCELE: "12/3" },
        { KO_ID: 2, ST_PARCELE: "O'Brien" },
      ],
      ["KO_ID", "ST_PARCELE"],
      1,
    );

    expect(predicates).toEqual([
      "(KO_ID = 1 AND ST_PARCELE = '12/3')",
      "(KO_ID = 2 AND ST_PARCELE = 'O''Brien')",
    ]);
  });
});

describe("API query validation", () => {
  it("round-trips opaque cursors", () => {
    const cursor = encodeCursor("building:100");
    expect(decodeCursor(cursor)).toBe("building:100");
  });

  it("rejects malformed cursors and bounding boxes", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(ApiValidationError);
    expect(() => parseBbox("14,46,13,47")).toThrow(
      "bbox is outside WGS84 bounds",
    );
  });

  it("validates the optional ETN transaction year", () => {
    expect(validateTransactionYear("2025")).toBe(2025);
    expect(() => validateTransactionYear(1900)).toThrow(
      "transactionYear must be an integer between 2007 and 2100",
    );
  });
});
