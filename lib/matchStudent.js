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

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A header row has column TITLES such as "Name", "Class" or "Admission No". Only whole titles count,
// so a student called "Reginald Obi" or "Armstrong Bello" is never mistaken for a header.
const TITLE_PATTERNS = [
  /^(student|pupil|candidate|learner)s?$/,
  /^(student|pupil|candidate|learner)?(full|first|last|other|sur|given|family)?names?(ofstudent|ofpupil)?$/,
  /^(student|pupil|candidate|learner)?(class|classname|form|grade|arm|section|stream|level)$/,
  /^(reg|registration|admission|adm|matric|matriculation|roll|student|pupil|candidate|id)(no|number|num|id)?$/,
  /^(s\/?n|sno|sn|serial|serialno|no|number|sl|slno)$/,
  /^(gender|sex|dob|dateofbirth|age|house)$/,
];

export function looksLikeHeader(row) {
  return (row || []).some((c) => {
    const t = norm(c);
    return t !== '' && TITLE_PATTERNS.some((re) => re.test(t));
  });
}

// Guess which columns hold the name, the reg/admission number and the class from the header row.
// Only the name is needed. Returns -1 for anything it cannot find.
export function guessRosterColumns(headers) {
  const n = headers.map(norm);
  const used = new Set();
  const find = (contains, exact = []) => {
    const i = n.findIndex((h, idx) => !used.has(idx) && h !== '' && (exact.includes(h) || contains.some((c) => h.includes(c))));
    if (i >= 0) used.add(i);
    return i;
  };

  // "id" and "adm" are matched exactly, because words like "candidate" contain the letters "id".
  const reg = find(
    ['regno', 'regnumber', 'registration', 'matric', 'studentid', 'studentno', 'admission', 'admno', 'rollno', 'candidateid'],
    ['id', 'reg', 'adm']
  );
  const cls = find(['class', 'form', 'grade', 'arm', 'section', 'stream', 'level'], ['cls']);
  const full = find(['fullname', 'studentname', 'candidatename', 'nameofstudent']);
  const first = find(['firstname', 'givenname', 'othername', 'forename']);
  const surname = find(['surname', 'lastname', 'familyname']);

  let name = full;
  let surnameCol = -1;
  if (name < 0) {
    if (first >= 0) {
      name = first;
      surnameCol = surname;
    } else if (surname >= 0) {
      name = surname;
    } else {
      name = find(['name']);
    }
  } else if (surname >= 0 && first >= 0) {
    // Both a full name and separate parts exist: the full name is enough.
    surnameCol = -1;
  }
  return { reg, name, surname: surnameCol, cls };
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
