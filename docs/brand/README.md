# Brand

<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="lockup-dark.svg">
    <img src="lockup.svg" height="48" alt="Job Matcher">
  </picture>
</p>

The mark is a check drawn as two flat-cut highlighter strokes. Where the strokes cross, the marker passes twice and the yellow deepens: that overlap is the match. It borrows from the app itself, which highlights the reasons a listing fits your resume.

The full guide is [brand-guide.pdf](brand-guide.pdf). The raster artwork (the social preview, the app icons and the guide) was built in Canva from the same geometry as the SVGs here.

## Files

| File | Use it for |
| --- | --- |
| [mark.svg](mark.svg) | The default mark: the check on its rounded ink tile. Favicons, avatars, the app header. |
| [mark-check.svg](mark-check.svg) | The check without its tile, for dark backgrounds. |
| [mark-square.svg](mark-square.svg) | Full-bleed tile, for platforms that round the corners themselves. |
| [lockup.svg](lockup.svg) | Mark and wordmark on light backgrounds. |
| [lockup-dark.svg](lockup-dark.svg) | Mark and wordmark on dark backgrounds. |
| [app-icon-1024.png](app-icon-1024.png) | Full-bleed 1024 px icon, the master for raster app icons. |
| [../social-preview.png](../social-preview.png) | Link previews: GitHub, Open Graph, Twitter cards. 1280 × 640. |

Where the copies live:

- `apps/web/app/`: `icon.svg`, `favicon.ico` (16, 32 and 48 px), `apple-icon.png` (180 px) and `manifest.ts`.
- `apps/web/public/`: the install icons, `icon-192.png`, `icon-512.png` and `icon-maskable-512.png`.
- `site/assets/`: `logo.svg`, `favicon.ico`, `apple-touch-icon.png` and `social-preview.png`.
- `apps/web/components/logo.tsx` and the header of `site/index.html` draw the mark inline.

## The mark

It is drawn on a 64-unit grid. The base of the check sits at y = 48, the long stroke's top at y = 16 and the short stroke's top at y = 30, so at 16 and 32 px the horizontal edges land on whole pixels. The tile's corner radius is 14 units.

The maskable icon scales the check to 80% so it stays inside the 40% safe circle that launchers crop to.

## Colour

| Name | Hex | Role |
| --- | --- | --- |
| Ink | `#1c2a23` | Text and the tile |
| Paper | `#eef1ec` | Page background |
| Sheet | `#fafbf8` | Cards and panels |
| Marker | `#f3de6e` | The check and highlighted text |
| Marker, twice | `#e2b92a` | Only where the two strokes cross |
| Match | `#2f6b4f` | Verdicts |

These are the app's own tokens in `apps/web/app/globals.css`.

## Type

Schibsted Grotesk, one family throughout: bold for headings and the wordmark, regular for reading. The wordmark is set in bold with −1.5% tracking and outlined in the SVGs, so it renders without the font installed.

## Using the logo

- Leave clear space of half the tile height on every side.
- Smallest sizes: the mark at 16 px, the lockup at 120 px wide.
- On dark backgrounds, use the check without its tile ([mark-check.svg](mark-check.svg), [lockup-dark.svg](lockup-dark.svg)).
- Keep the colours as drawn. Don't recolour, outline, rotate or add effects to the mark.
