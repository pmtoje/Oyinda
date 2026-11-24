# Credit360 by AltBank — logo system

**Source of truth:** `reference/credit360-logo-system-reference.png`, the approved logo sheet supplied by the product owner on 24-Nov-2026. It is kept unaltered: primary lockup, app icon / symbol mark, and compact lockup.

## Assets (`apps/web/public/brand/`)

| File | Use |
| --- | --- |
| `credit360-primary.svg` / `-on-dark.svg` | Main lockup: symbol, "Credit360", "by AltBank". Sign-in panels, documents' cover areas, large placements. |
| `credit360-compact.svg` / `-on-dark.svg` | Secondary lockup. Application headers (36 px tall; 30 px on phones), Word document headers (as a PNG). |
| `credit360-symbol.svg` / `-on-dark.svg` | The C, orbit and sparkle alone. Headers narrower than 420 px. |
| `credit360-app-icon.svg` | App icon / favicon: white C, gold orbit and sparkle on charcoal, rounded square. |
| `credit360-icon-{16,32,180,192,512}.png` | Favicon fallback, Apple touch icon, web-app manifest icons. |
| `apps/api/assets/brand/credit360-compact.png` | 1382 × 326 PNG of the compact lockup, embedded in generated Word documents. |

## How the SVGs were made — and what that means

The sheet is a raster image (1448 × 1086). Each element was **traced** from it with `tools/trace.py`: 4× supersampling, separation of the charcoal, gold and white layers by colour, then Potrace curve fitting. Shapes and letterforms therefore come from the supplied artwork itself. No font was substituted and nothing was redrawn by eye.

* **Interpretation, not exact fidelity.** Traced curves follow the artwork closely but can differ by a fraction of a pixel at the source scale. Fine details such as the sparkle points and the orbit's tapered ends are as faithful as the raster allows. **When the designer's master vector file (AI/SVG/PDF) is available, it should replace these files**, keeping the same names.
* **Dark-background lockups** were derived from the approved app icon, which shows a white C with the gold orbit on charcoal. In the `-on-dark` files the charcoal C and wordmark become warm white `#FBF9F7`; the gold is unchanged.
* The "360" keeps the subtle vertical gradient visible in the artwork (`#F6A50B` → `#EC9C05`). The orbit and sparkle are flat `#FDB205`.

## Colours measured from the artwork

| Element | Value |
| --- | --- |
| "Credit", symbol C, "by AltBank" | `#1E1B1E` (warm near-black) |
| App-icon field | `#211E21` / `#221F22` |
| Orbit, sparkle | `#FDB205` |
| "360" | `#F6A50B` → `#EC9C05` |
| App-icon C | `#FBF9F7` |
| Sheet background / accent | `#FCF8F3` / `#FDECD8` |

These drive the palette in `apps/web/src/styles/tokens.css`. They are *measured*, not certified: reconcile them with AltBank's corporate colour codes (decision C-01) before print production.

## Usage rules

* **Clear space:** at least the height of the sparkle (about a quarter of the symbol's height) on every side. In the app this comes from header padding.
* **Minimum sizes:** primary lockup 160 px wide; compact 120 px wide; symbol and app icon 16 px. Below 420 px wide, headers use the symbol alone.
* **Backgrounds:** charcoal artwork on white or cream; `-on-dark` artwork on charcoal (`#1E1B1E` and darker). Never place the charcoal version on dark surfaces or the white version on light ones.
* **Do not** stretch, rotate, recolour, add effects or shadows, re-set the wordmark in another typeface, separate "360" from "Credit", or crop the orbit or sparkle.
* **Accessibility:** logo images are decorative (`alt=""`) inside a link labelled "Credit360 by AltBank — home"; logotypes are exempt from WCAG contrast requirements. The brand gold is never used for running text: links use `#8A5E00` on light surfaces.

## Regenerating

```
python -m venv .venv && .venv/bin/pip install potracer numpy pillow
.venv/bin/python -I docs/brand/tools/trace.py docs/brand/reference/credit360-logo-system-reference.png out/
```
The crop boxes in `trace.py` are measured for this sheet; a new sheet needs new boxes.
