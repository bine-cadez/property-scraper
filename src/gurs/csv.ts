export type CsvRecord = Record<string, string>;

export function parseCsv(text: string): CsvRecord[] {
  const rows = parseCsvRows(text);

  if (rows.length === 0) {
    return [];
  }

  const [header, ...dataRows] = rows;

  if (!header || header.some((name) => name.length === 0)) {
    throw new Error("CSV header contains an empty column name");
  }

  return dataRows
    .filter((row) => row.some((value) => value.length > 0))
    .map((row, rowIndex) => {
      if (row.length > header.length) {
        throw new Error(
          `CSV row ${rowIndex + 2} has ${row.length} fields; expected ${header.length}`,
        );
      }

      return Object.fromEntries(
        header.map((name, columnIndex) => [name, row[columnIndex] ?? ""]),
      );
    });
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }

      continue;
    }

    if (character === '"') {
      if (field.length > 0) {
        throw new Error("Unexpected quote in an unquoted CSV field");
      }

      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (inQuotes) {
    throw new Error("Unterminated quoted CSV field");
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
