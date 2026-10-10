// The one hand-drawn thing in the app: a mark, circled in red pen, the way a teacher writes it in the margin.
export default function PenScore({ value, outOf }) {
  return (
    <span className="penscore" role="img" aria-label={`${value} out of ${outOf}`}>
      <svg viewBox="0 0 120 56" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path
          d="M12 30 C 8 12, 58 3, 98 10 C 124 16, 117 45, 68 50 C 28 55, 3 44, 11 21 C 14 14, 22 11, 32 9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="penscore-num">{value}</span>
      <span className="penscore-of">/ {outOf}</span>
    </span>
  );
}
