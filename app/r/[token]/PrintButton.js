'use client';

export default function PrintButton() {
  return (
    <button type="button" className="pr-print" onClick={() => window.print()}>
      Print or save as PDF
    </button>
  );
}
