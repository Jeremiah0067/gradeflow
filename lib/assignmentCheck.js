// Double-checks that a script is assigned to the right student, by comparing the name or reg number
// the AI read on the first page with the student the script is assigned to.
// Pure functions. It only ever WARNS: the teacher decides, because handwriting can be misread.

import { nameSimilarity, levenshtein, nameTokens, normReg } from './matchStudent';

// Is every word of the shorter name found in the longer one (one letter off is fine)?
// So "Ada" fits "Ada Obi", and a paper showing only a surname is not flagged.
function partOf(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (small.length === 0) return false;
  return small.every((w) => big.some((x) => x === w || (w.length >= 4 && x.length >= 4 && levenshtein(w, x) <= 1)));
}

// paper: { detected_name, detected_reg_no }   assigned: the student it is assigned to (or null)   roster: all students
// level: 'ok' | 'warn' | 'unverified' | 'none'
export function checkAssignment(paper, assigned, roster) {
  if (!assigned) return { level: 'none' };

  const readName = paper?.detected_name || '';
  const readReg = normReg(paper?.detected_reg_no);
  const hasName = nameTokens(readName).length > 0;

  if (!hasName && readReg.length < 4) {
    return {
      level: 'unverified',
      message: 'No name or reg number could be read on this script, so the student could not be double-checked. Please check the name on the first page yourself.',
    };
  }

  // A reg number on the paper is the strongest evidence
  if (readReg.length >= 4) {
    const owners = roster.filter((s) => normReg(s.reg_no) === readReg);
    if (owners.length === 1) {
      if (owners[0].id === assigned.id) return { level: 'ok' };
      return {
        level: 'warn',
        suggestedStudentId: owners[0].id,
        message: `The reg number on the paper (${paper.detected_reg_no}) belongs to ${owners[0].full_name}, but this script is assigned to ${assigned.full_name}.`,
      };
    }
  }

  if (hasName) {
    const mine = nameSimilarity(readName, assigned.full_name);
    if (mine >= 0.7 || partOf(readName, assigned.full_name)) return { level: 'ok' };

    const best = roster
      .filter((s) => s.id !== assigned.id)
      .map((s) => ({ s, score: nameSimilarity(readName, s.full_name) }))
      .sort((x, y) => y.score - x.score)[0];
    if (best && best.score >= 0.85) {
      return {
        level: 'warn',
        suggestedStudentId: best.s.id,
        message: `The name on the paper (${readName}) looks like ${best.s.full_name}, but this script is assigned to ${assigned.full_name}.`,
      };
    }
    if (mine < 0.5) {
      return { level: 'warn', message: `The name on the paper (${readName}) does not look like ${assigned.full_name}.` };
    }
    return { level: 'ok' }; // in between: not clear enough to bother the teacher
  }

  return { level: 'unverified', message: 'The reg number on the paper is not on your list, so the student could not be double-checked.' };
}

// The result for every script that has a student, keyed by script id.
export function checkAll(papers, students) {
  const byId = Object.fromEntries(students.map((s) => [s.id, s]));
  const out = {};
  papers.forEach((p) => {
    if (p.student_id && byId[p.student_id]) out[p.id] = checkAssignment(p, byId[p.student_id], students);
  });
  return out;
}

export const isMixup = (result) => result?.level === 'warn';
