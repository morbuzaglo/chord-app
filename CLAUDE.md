# Chords for All

A static single-page app ("Chords for All") for finding or writing song chord charts,
transposing them, and viewing guitar/piano fingering diagrams. Pure HTML/CSS/JS, no build step,
no backend — `index.html` + `app.js` + `style.css`, with `favorites.json` as the local
favorites store.

## Architecture
- Four input modes (tabs in `index.html`): **Search** (Ultimate Guitar + tab4u.com/Hebrew),
  **Paste link** (UG or tab4u URLs only), **My chords** (manual entry using `[C]` bracket
  notation inline with lyrics, Hebrew supported), **Favorites**.
- `app.js` — chord theory engine: parses chord symbols (`parseChordSymbol`), a `QUALITIES`
  table mapping quality tokens (maj7, sus4, dim7, add9, …) to interval formulas, transposition,
  and a `SHAPE_KEY`/`SHAPE_APPROX` mapping down to a smaller set of guitar/piano diagram shapes
  (many extended/altered chords are rendered as an *approximation* of a simpler shape —
  flagged in the UI with an "approx voicing" note, not a bug).
- Guitar diagrams and piano-key diagrams are rendered as inline SVG.

## Deployed as a static site (2026-09-21)

Pushed to GitHub Pages as a public, backend-free deployment. The original app assumed a small
server behind `/api/search`, `/api/fetch` (scrape Ultimate Guitar/tab4u, dodging their CORS
restrictions) and `/api/favorites` (favorites persisted server-side to `favorites.json`) — that
server was never actually written, so those three things didn't work in any environment, not
just this one.

- **Favorites** now use `localStorage` (`FAVORITES_KEY = 'chords-app-favorites-v1'`) instead of
  `/api/favorites` — fully functional, just per-browser/device instead of synced.
  `favorites.json` is gitignored (it also held real scraped, copyrighted lyric/chord text —
  shouldn't be redistributed via a public repo regardless).
- **Search and "paste a link"** cannot work client-side-only (Ultimate Guitar/tab4u don't grant
  CORS to arbitrary origins, and scraping needs a server anyway) — rather than let the `fetch`
  calls fail silently, `loadSong`/the search-form handler now show `NO_BACKEND_MESSAGE` and the
  tab hints in `index.html` say so up front. **"My chords" (manual paste/typing) is the only
  fully-working way to load a song here.** If a real backend gets built later, these are the
  functions to restore fetch-based behavior in (`loadSong`, the `search-form` submit handler).

## Known issues & fixes (already applied — don't reintroduce)
- **Piano diagram used to overflow its card.** Root cause was a hardcoded `width`/`height`
  on the `<svg>` fighting the CSS. Fix: the SVG has *no* hardcoded pixel width/height — it
  relies entirely on its `viewBox` plus `.diagram-card svg` CSS sizing rules (`style.css`
  around the "This is the actual fix..." comment) to scale responsively. If diagrams start
  overflowing again, check first whether a `width="..."` attribute crept back onto the `<svg>`.
- The key label showing the current key/transposition (e.g. `F# (+1.5)`) has a **fixed CSS
  width** on purpose, so longer labels don't shove the +/- transpose buttons sideways —
  don't remove that width without checking the longest realistic label still fits.
