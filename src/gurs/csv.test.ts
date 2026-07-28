import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv.js";

describe("parseCsv", () => {
  it("parses quoted commas, escaped quotes, and embedded newlines", () => {
    expect(
      parseCsv(
        [
          "ID,OPIS,OPOMBA",
          '1,"Ljubljana, Center","prva ""opomba"""',
          '2,"več',
          'vrstic",',
          "",
        ].join("\r\n"),
      ),
    ).toEqual([
      {
        ID: "1",
        OPIS: "Ljubljana, Center",
        OPOMBA: 'prva "opomba"',
      },
      {
        ID: "2",
        OPIS: "več\r\nvrstic",
        OPOMBA: "",
      },
    ]);
  });

  it("fills missing trailing fields and skips empty rows", () => {
    expect(parseCsv("A,B,C\n1,2\n\n")).toEqual([
      { A: "1", B: "2", C: "" },
    ]);
  });
});
