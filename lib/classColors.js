// Deterministic banner color per class, based on its name - so the same
// class always gets the same color, Classroom-style.
const PALETTE = [
  '#1a73e8', '#d93025', '#f9ab00', '#1e8e3e',
  '#8430ce', '#12a4af', '#e37400', '#5f6368',
];

export function colorForClass(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
