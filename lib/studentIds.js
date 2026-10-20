// Students who have no reg or admission number still need a unique value in the database.
// They get a hidden internal id made from their name (the same name gives the same id in every
// marking job, so report cards can still line a student up across subjects).
// It is never shown to teachers, in exports, or on report cards.

export const PLACEHOLDER_PREFIX = 'NOREG:';

export function slugName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// n is 1 for the first student with this name, 2 for the next, and so on.
export function makePlaceholderReg(name, n = 1) {
  return `${PLACEHOLDER_PREFIX}${slugName(name) || 'student'}${n > 1 ? `#${n}` : ''}`;
}

export function isPlaceholderReg(reg) {
  return String(reg || '').startsWith(PLACEHOLDER_PREFIX);
}

// What to show a person: blank for a hidden id.
export function displayReg(reg) {
  return isPlaceholderReg(reg) ? '' : String(reg || '');
}

// "Ada Obi (JSS/001)" or just "Ada Obi"
export function studentLabel(student) {
  const reg = displayReg(student?.reg_no);
  return reg ? `${student.full_name} (${reg})` : student?.full_name || '';
}
