# Design Brief: App Icon / Favicon

## What

rolodex's original favicon (`src/shell/assets/favicon.svg`) was a
hand-authored, simple index-card SVG. This replaces it with a generated
icon set across all sizes (favicon.ico, PNG sizes, apple-touch-icon), built
from a real Gemini "Nano Banana" image generation pass rather than a
hand-drawn placeholder.

## Generation

- **Model**: `models/gemini-2.5-flash-image` (displayName "Nano Banana"),
  confirmed via the Generative Language API's own `ListModels` response —
  not assumed from training knowledge, since several newer "Nano Banana
  2"/"Nano Banana Pro" models also exist and could easily have been
  confused for the one actually requested.
- **API key**: resolved from Portunus
  (`personalsites-487021-google_generative_ai_api_key`, `state: enabled`)
  via `portunus resolve`, read into memory, and the resulting tempfile
  deleted immediately — never written to a file this repo tracks, never
  logged.
- **Prompt shape**: a shared style suffix (flat vector icon, bold simple
  shapes, no gradients/photorealism/text, reads at 16×16px, square 1:1,
  rolodex's real palette — paper `#E8EAE3`, ink `#1C2420`, brass `#92651E`)
  combined with 10 distinct concept directions (single card, fanned cards,
  rotary rolodex device, card-catalog drawer, hole-punched card, open card
  box, divider tab, edge-on stack, tent-fold card, closed latched box).

## Renditions

All 10 candidates: `renditions/candidate-1.png` through `candidate-10.png`
(1024×1024 each), plus `renditions/contact-sheet.png` (a labeled grid of
all 10 for side-by-side comparison).

**Rendered review (interactive picker)**:
https://claude.ai/code/artifact/9aa84cd7-0897-4dc1-b255-d03a96677ad0

## Selected

**Candidate 6** — an open card-file box viewed from above, index cards
peeking out, brass corner trim. Owner's pick, out of all 10.

Candidate 6's generated background drifted slightly off the established
palette (a light mint rather than the real paper `#E8EAE3`) — corrected via
a color-distance pixel replace before producing the final icon set (see
`renditions/selected-master-1024.png` for the corrected 1024×1024 master
this was built from).

## Output

Final icon set shipped to both `src/shell/assets/` (the standalone app) and
`docs/assets/` (the GitHub Pages site): `favicon.ico` (16/32/48
multi-resolution), `favicon-16.png`, `favicon-32.png`,
`apple-touch-icon.png` (180×180), `icon-512.png`. The old hand-authored
`favicon.svg` was removed from both locations; every `<link rel="icon">`
reference was updated accordingly.
