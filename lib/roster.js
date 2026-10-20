// Turns the teacher's student list into students ready to save. Pure functions: easy to test.
// The list only NEEDS a name. A reg or admission number and a class are optional extras.

import { makePlaceholderReg, slugName } from './studentIds';

const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Each class once, even if it was typed as "JSS2A" in one row and "jss2a" in another.
export function distinctValues(rows, col) {
  if (col < 0) return [];
  const seen = new Map();
  rows.slice(1).forEach((r) => {
    const v = clean(r[col]);
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  });
  return [...seen.values()].sort(natural);
}

// rows[0] is the header row.
export function buildRoster(rows, { nameCol = -1, surnameCol = -1, regCol = -1, classCol = -1, classFilter = '' } = {}) {
  const out = { students: [], skipped: 0, duplicates: [], blank: 0, filteredOut: 0, withoutReg: 0 };
  if (!rows || rows.length < 2 || nameCol < 0) return out;

  const seenReg = new Set();
  const seenNoReg = new Set();
  const sameNameCount = {};
  const want = clean(classFilter).toLowerCase();

  rows.slice(1).forEach((row) => {
    const cls = classCol >= 0 ? clean(row[classCol]) : '';
    if (want && cls.toLowerCase() !== want) {
      out.filteredOut += 1;
      return;
    }

    const name = [clean(row[nameCol]), surnameCol >= 0 ? clean(row[surnameCol]) : ''].filter(Boolean).join(' ');
    if (!name) {
      out.blank += 1;
      out.skipped += 1;
      return;
    }

    const reg = regCol >= 0 ? clean(row[regCol]) : '';
    if (reg) {
      const key = reg.toLowerCase();
      if (seenReg.has(key)) {
        out.skipped += 1;
        out.duplicates.push(name);
        return;
      }
      seenReg.add(key);
      out.students.push({ reg_no: reg, full_name: name });
      return;
    }

    // No reg number: the same name AND class again is treated as the same row pasted twice.
    const dupKey = `${slugName(name)}|${cls.toLowerCase()}`;
    if (seenNoReg.has(dupKey)) {
      out.skipped += 1;
      out.duplicates.push(name);
      return;
    }
    seenNoReg.add(dupKey);
    const base = slugName(name);
    sameNameCount[base] = (sameNameCount[base] || 0) + 1;
    out.students.push({ reg_no: makePlaceholderReg(name, sameNameCount[base]), full_name: name });
    out.withoutReg += 1;
  });
  return out;
}

// A typed or pasted list: one student per line. After the name, a reg or admission number is optional
// (separated by a tab or a comma). "Okafor, Chinedu" stays one name, because the part after the comma has no digits.
export function parseNamesText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let anyReg = false;
  const rows = lines.map((line) => {
    let name = line;
    let reg = '';
    if (line.includes('\t')) {
      const parts = line.split('\t').map((p) => p.trim());
      name = parts[0];
      reg = parts[1] || '';
    } else {
      const i = line.lastIndexOf(',');
      if (i > 0) {
        const tail = line.slice(i + 1).trim();
        if (/\d/.test(tail) && !/\s/.test(tail)) {
          name = line.slice(0, i).trim();
          reg = tail;
        }
      }
    }
    if (reg) anyReg = true;
    return [name, reg];
  });
  return { rows: [['Name', 'Reg / admission number'], ...rows], nameCol: 0, regCol: anyReg ? 1 : -1 };
}
