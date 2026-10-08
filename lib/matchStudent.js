/**
 * lib/matchStudent.js
 * High-precision roster matching engine for handwritten test script identification.
 * Handles OCR errors, registration number canonicalization, and fuzzy matching.
 */

export function normalizeIdentifier(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function fixOcrConfusions(str) {
  return str
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/5/g, 'S')
    .replace(/8/g, 'B');
}

export function matchStudentToRoster(rawInput, roster = []) {
  if (!rawInput || !Array.isArray(roster) || roster.length === 0) {
    return null;
  }

  const normInput = normalizeIdentifier(rawInput);
  if (!normInput) return null;

  // 1. Direct Reg Number Exact Match
  for (const student of roster) {
    const studentReg = normalizeIdentifier(student.reg_no || student.registration_number || student.matric_no);
    if (studentReg && studentReg === normInput) {
      return {
        student,
        confidence: 1.0,
        matchType: 'exact_reg_no',
      };
    }
  }

  // 2. Direct Name Exact Match
  for (const student of roster) {
    const studentName = normalizeIdentifier(student.name || student.full_name);
    if (studentName && studentName === normInput) {
      return {
        student,
        confidence: 0.95,
        matchType: 'exact_name',
      };
    }
  }

  // 3. OCR Confusables Normalized Match (e.g., 0/O swapping)
  const ocrFixedInput = fixOcrConfusions(normInput);
  for (const student of roster) {
    const studentReg = fixOcrConfusions(normalizeIdentifier(student.reg_no || student.matric_no));
    if (studentReg && studentReg === ocrFixedInput) {
      return {
        student,
        confidence: 0.90,
        matchType: 'ocr_corrected_reg',
      };
    }
  }

  // 4. Substring / Containment Match
  for (const student of roster) {
    const studentReg = normalizeIdentifier(student.reg_no || student.matric_no);
    if (studentReg && (studentReg.includes(normInput) || normInput.includes(studentReg)) && normInput.length >= 4) {
      return {
        student,
        confidence: 0.82,
        matchType: 'partial_reg',
      };
    }
  }

  // 5. Fuzzy Distance Match (Levenshtein)
  let bestMatch = null;
  let lowestDistance = Infinity;

  for (const student of roster) {
    const studentReg = normalizeIdentifier(student.reg_no || student.matric_no);
    if (!studentReg) continue;

    const dist = levenshteinDistance(normInput, studentReg);
    if (dist < lowestDistance) {
      lowestDistance = dist;
      bestMatch = student;
    }
  }

  const maxAllowedEdits = normInput.length > 7 ? 2 : 1;
  if (bestMatch && lowestDistance <= maxAllowedEdits) {
    const score = Math.max(0.60, 1.0 - lowestDistance * 0.15);
    return {
      student: bestMatch,
      confidence: Number(score.toFixed(2)),
      matchType: 'fuzzy_reg_distance',
    };
  }

  return null;
}
