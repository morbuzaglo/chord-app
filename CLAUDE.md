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

## Deployed as a static site + real local backend (2026-09-21)

Pushed to GitHub Pages (public, permanent, backend-free) at
https://morbuzaglo.github.io/chord-app/. The original app assumed a small server behind
`/api/search`, `/api/fetch` (scrape Ultimate Guitar/tab4u, dodging their CORS restrictions) and
`/api/favorites` — that server was never actually written, so those three things never worked
anywhere, not just on Pages.

- **Favorites** now use `localStorage` (`FAVORITES_KEY = 'chords-app-favorites-v1'`) instead of
  `/api/favorites`, in both environments — fully functional, just per-browser/device instead of
  synced. `favorites.json` (the old server-side store) is gitignored — it also held real scraped,
  copyrighted lyric/chord text, which shouldn't be redistributed via a public repo regardless.
- **Search and "paste a link"** genuinely need a server (Ultimate Guitar/tab4u don't grant CORS to
  arbitrary origins, and scraping needs a server-side fetch anyway). `server.ps1` (PowerShell,
  since this dev machine has no Node/Python) now implements real scraping for both sites — see
  its own header comment for the exact JSON/HTML shapes it depends on, reverse-engineered
  2026-09-21 by fetching real UG/tab4u pages and inspecting the response structure directly
  (UG: the `js-store` `data-content` JSON blob every UG page embeds, `store.page.data.results` /
  `.tab.song_name` / `.tab_view.wiki_tab.content` with `[ch]`/`[tab]` tags already matching
  `stripUGTags`'s expectations; tab4u: the `#songContentTPL` table of alternating
  `<td class="chords">`/`<td class="song">` rows, `&nbsp;`-decoded 1:1 into the same
  whitespace-positioned `[Chord]` bracket format the manual-entry parser already understands).
- **One `app.js`, not two forks**: `IS_STATIC_DEPLOY = /\.github\.io$/i.test(location.hostname)`
  picks behavior by hostname at runtime — on Pages, Search/paste-link show
  `NO_BACKEND_MESSAGE`; anywhere else (localhost, a devtunnel host, a future real deployment)
  they call `/api/search` / `/api/fetch` for real. Keep it this way rather than reintroducing a
  second copy of the file — a hostname check is much harder to accidentally push out of sync
  than "remember to swap these two functions back before committing."
- **Running the real backend locally**: `powershell -File server.ps1` (serves the app + APIs on
  `http://localhost:8787` by default), then `devtunnel host -p 8787 --allow-anonymous` to expose
  it publicly. The GitHub Pages copy is unaffected either way.

## Known issues & fixes (already applied — don't reintroduce)
- **Piano diagram used to overflow its card.** Root cause was a hardcoded `width`/`height`
  on the `<svg>` fighting the CSS. Fix: the SVG has *no* hardcoded pixel width/height — it
  relies entirely on its `viewBox` plus `.diagram-card svg` CSS sizing rules (`style.css`
  around the "This is the actual fix..." comment) to scale responsively. If diagrams start
  overflowing again, check first whether a `width="..."` attribute crept back onto the `<svg>`.
- The key label showing the current key/transposition (e.g. `F# (+1.5)`) has a **fixed CSS
  width** on purpose, so longer labels don't shove the +/- transpose buttons sideways —
  don't remove that width without checking the longest realistic label still fits.
