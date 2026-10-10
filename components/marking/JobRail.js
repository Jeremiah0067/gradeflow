'use client';

import Link from 'next/link';
import { Icon } from '../icons';

// Where this marking job is up to. Each step is a link to where you do that step.
//   steps: from computeProgress()   links: { [stepKey]: href }   (href starting with "#" scrolls on this page)
export function Rail({ steps, links }) {
  return (
    <ol className="rail" aria-label="Progress of this marking job">
      {steps.map((s) => {
        const href = links[s.key];
        const inner = (
          <>
            <span className="rail-label">{s.label}</span>
            <span className="rail-count">{s.count}</span>
          </>
        );
        return (
          <li key={s.key} className={`rail-step is-${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
            <span className="rail-mark" aria-hidden="true">
              {s.state === 'done' && <Icon name="check" size={12} strokeWidth={3.5} />}
            </span>
            {href && href.startsWith('#') ? (
              <a className="rail-link" href={href}>{inner}</a>
            ) : href ? (
              <Link className="rail-link" href={href}>{inner}</Link>
            ) : (
              <span className="rail-link">{inner}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// One card, one next step, one button.
export function NextAction({ next, children }) {
  return (
    <div className="nextaction">
      <div className="nextaction-text">
        <p className="nextaction-title">{next.title}</p>
        <p className="nextaction-hint">{next.hint}</p>
      </div>
      {children}
    </div>
  );
}
