// Small CSV helpers (no dependencies).
// parseCsv: reads a CSV string into rows. Handles quotes, BOM, CRLF, and
//           comma / semicolon / tab separators.
// toCsv:    builds a CSV string (used later for exporting results).

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && counts[ch] !== undefined) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';
}

export function parseCsv(input) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

// Guess which columns hold the reg number and the student name from the header row.
export function guessRosterColumns(headers) {
  const norm = headers.map((h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, ''));
  const find = (contains, exact = [], skip = -1) =>
    norm.findIndex((h, i) => i !== skip && (exact.includes(h) || contains.some((c) => h.includes(c))));

  // "id" is matched exactly, because words like "candidate" contain the letters "id".
  const reg = find(
    ['regno', 'regnumber', 'registration', 'matric', 'studentid', 'admission', 'candidateid'],
    ['id', 'reg']
  );
  const name = find(['fullname', 'studentname', 'candidatename', 'name'], [], reg);
  return { reg, name };
}

// Stops spreadsheet apps from running a cell as a formula (e.g. a name starting with "=").
function safeCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(safeCell).join(',')).join('\r\n');
}
