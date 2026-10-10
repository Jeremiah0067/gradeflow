# GradeFlow design system

**Install first:** `npm install @fontsource-variable/atkinson-hyperlegible-next`

## Idea
A marking desk. Quiet paper-and-ink surfaces. The red pen is used for ONE thing: the mark you give
(the circled score on the review screen). Sentence case everywhere, no ALL-CAPS labels.

## Why these choices (researched)
- One navigation for the whole site (side rail on desktop, bottom bar on phones). Nigeria's web traffic is mostly mobile.
- Marking jobs show a status rail and ONE next action, like SpeedGrader and Gradescope show progress.
- Camera-first photo buttons; every upload area also works by click and by drag and drop.
- Atkinson Hyperlegible Next: made so look-alike characters (O and 0, l and 1) are easy to tell apart, which matters for reg numbers.
  It is self-hosted (about 34 KB), so no extra requests to Google Fonts on slow connections.
- Text contrast 4.5:1 or better, control borders 3:1, 44px touch targets on main actions, visible focus rings, reduced-motion respected.

## Tokens (styles/globals.css, section 1)
desk #f3f4f7, paper #fff, ink #1a2138, biro blue #2340b4 (actions), red pen #c62d1f (marks only), tick green #17754a, highlighter #fff3c4.
Spacing is a 4px scale (--s-1 .. --s-8). Controls 10px radius, panels 14px, pills full.

## Building new screens
Page: `.page-wide` or `.page-narrow` > `.page-head` (h1 + actions). Boxes (`.surface`) only for things you act on.
Lists: `.rows` > `.row`. Status: `.chip` + `.chip-blue|green|amber|red`. Messages: `.alert` + `.alert-error|warn|ok|info`.
Uploads: `<Dropzone>` / `<PhotoButtons>` from components/ui/FilePicker. Progress of a job: `computeProgress()` + `<Rail>`.
Old pages keep working: the old class names are still defined, and the old per-page sidebars were removed because AppShell replaced them.

## Not yet updated visually
Class page, people page, inbox and assignment pages get the new colours, type, buttons and navigation automatically,
but their own layouts were not redesigned or checked in a browser.
