// Matches what the AI read at the top of a script (name and/or reg number)
// to a student on the roster. Deliberately cautious: a wrong match would put
// one student's marks on another student, so when unsure we return no match
// and the teacher picks the student by hand.

function normReg(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function nameTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 1 means identical. Word order is ignored, so "Obi Ada" matches "Ada Obi".
export function nameSimilarity(a, b) {
  const ta = nameTokens(a).sort().join(' ');
  const tb = nameTokens(b).sort().join(' ');
  if (!ta || !tb) return 0;
  return 1 - levenshtein(ta, tb) / Math.max(ta.length, tb.length);
}

// detected: { name, reg_no }   students: [{ id, full_name, reg_no }]
// takenIds: ids of students who already have a script (they can't be matched again)
export function matchStudent(detected, students, takenIds = new Set()) {
  const reg = normReg(detected?.reg_no);
  const name = detected?.name || '';
  const candidates = students.filter((s) => !takenIds.has(s.id));

  // 1. Exact reg number is the strongest signal
  if (reg.length >= 4) {
    const exact = students.filter((s) => normReg(s.reg_no) === reg);
    if (exact.length === 1) {
      if (takenIds.has(exact[0].id)) {
        return { student: null, note: `Reg number matches ${exact[0].full_name}, who already has a script.` };
      }
      return { student: exact[0], method: 'reg_no', score: 1 };
    }
  }

  // 2. Name similarity, accepted only if clearly better than the runner-up
  if (nameTokens(name).length > 0) {
    const scored = candidates
      .map((s) => ({ s, score: nameSimilarity(name, s.full_name) }))
      .sort((x, y) => y.score - x.score);
    const best = scored[0];
    const second = scored[1];
    if (best && best.score >= 0.85 && (!second || best.score - second.score >= 0.08)) {
      return { student: best.s, method: 'name', score: best.score };
    }

    // 3. Reg number is one character off (misread digit), and the name roughly agrees
    if (reg.length >= 6) {
      const near = candidates.find(
        (s) => levenshtein(normReg(s.reg_no), reg) <= 1 && nameSimilarity(name, s.full_name) >= 0.6
      );
      if (near) return { student: near, method: 'reg_no_near', score: 0.8 };
    }

    if (best && best.score >= 0.6) {
      return { student: null, note: `Could not be sure. Closest match was ${best.s.full_name}.` };
    }
  }

  if (!reg && nameTokens(name).length === 0) {
    return { student: null, note: 'No name or reg number could be read on the first page.' };
  }
  return { student: null, note: 'The name or reg number on the script did not match anyone on the roster.' };
}
