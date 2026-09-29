// Deterministic pastel card color per class, based on its name - matches
// the Figma reference design (light background, dark text, not a solid
// vivid banner).
const PALETTE = [
  { bg: '#e3edfd', text: '#1a73e8' }, // blue
  { bg: '#e2f3e7', text: '#1e8e3e' }, // green
  { bg: '#f1e6fb', text: '#8430ce' }, // purple
  { bg: '#fdf0da', text: '#b06000' }, // amber
  { bg: '#fde3e1', text: '#c5221f' }, // red
  { bg: '#dff6f5', text: '#12847f' }, // teal
];

export function colorForClass(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
