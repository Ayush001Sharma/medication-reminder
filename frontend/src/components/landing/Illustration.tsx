import { useId } from 'react'

/**
 * A calm scene drawn from plain SVG shapes: soft hills, a low sun and a weekly pill box with the first days
 * done. Original artwork (no photos, no stock or copyrighted images). Colours come from the theme classes, so it
 * stays in the palette. Decorative only, hidden from assistive technology: the page text says everything.
 */
export function Illustration({ className }: { className?: string }) {
  const days = [0, 1, 2, 3, 4, 5, 6]
  const clipId = `scene-${useId().replace(/:/g, '')}` // the hills and the sun stay inside the rounded corners
  return (
    <svg className={className} viewBox="0 0 480 380" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clipId}>
          <rect width="480" height="380" rx="32" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
      <rect width="480" height="380" className="fill-sage-tint" />
      <circle cx="372" cy="96" r="44" className="fill-clay" />
      <circle cx="372" cy="96" r="62" className="stroke-clay" strokeWidth="2" strokeDasharray="2 10" strokeLinecap="round" />
      <path d="M0 292c60-46 120-62 190-40s118 30 290-26v154H0z" className="fill-sage" />
      <path d="M0 330c88-32 168-34 250-12s146 8 230-18v80H0z" className="fill-sage-dark" />
      </g>

      {/* the weekly pill box */}
      <g transform="translate(84 168)">
        <rect x="6" y="10" width="312" height="118" rx="24" className="fill-ink" opacity="0.08" />
        <rect width="312" height="118" rx="24" className="fill-surface" />
        {days.map((day) => (
          <g key={day} transform={`translate(${14 + day * 42} 16)`}>
            <rect width="34" height="86" rx="12" className="fill-subtle" />
            {day < 4 && <rect x="9" y="22" width="16" height="42" rx="8" className="fill-sage" />}
            {day === 4 && <rect x="9" y="22" width="16" height="42" rx="8" className="fill-clay" />}
            {day < 4 && <path d="M11 74l5 5 8-9" className="stroke-sage-dark" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
          </g>
        ))}
      </g>

      {/* a sprig of leaves */}
      <g transform="translate(36 246)">
        <path d="M30 100C30 70 34 40 52 10" className="stroke-sage-dark" strokeWidth="4" strokeLinecap="round" />
        <path d="M44 34c-18-2-30-14-32-30 18 0 30 12 32 30z" className="fill-sage-tint" />
        <path d="M38 58c-20 2-34-8-40-22 18-6 34 2 40 22z" className="fill-sage-tint" />
        <path d="M46 28c14-6 22-18 22-32-16 4-24 16-22 32z" className="fill-surface" />
      </g>

      {/* a small clock */}
      <g transform="translate(396 258)">
        <circle cx="30" cy="30" r="30" className="fill-surface" />
        <circle cx="30" cy="30" r="22" className="stroke-sage" strokeWidth="3" />
        <path d="M30 17v14l9 6" className="stroke-sage-dark" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  )
}
