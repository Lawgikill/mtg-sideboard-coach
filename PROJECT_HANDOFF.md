# MTG Sideboard Coach Handoff

Last updated: June 23, 2026. Version references corrected for the 1.0.0 release on October 21, 2026.

> **Older than CLAUDE.md, and narrower.** This was written before the Journal and Replay tabs, screenshot OCR, opponent decklists and the Scout tab (since removed) existed. Where it disagrees with [CLAUDE.md](./CLAUDE.md), CLAUDE.md is current. What follows describes the deck library, the Plans tab and packaging, and is kept for that history.

## Project Scope

MTG Sideboard Coach is a personal Magic: The Gathering desktop app focused on Standard deck sideboarding. It is not a collection manager or tournament tracker. The core goal is to import decks, view main/sideboard cards with card art, define matchup-specific sideboard plans, and keep those plans easy to scan during play or testing.

The app currently targets Windows through Electron. It shipped as a portable `.exe` when this was written and is now an installer that updates itself (see CLAUDE.md, *Installer and self-update*).

## Current Tech Stack

- React 19
- TypeScript
- Vite
- Electron
- electron-builder for Windows packaging (now an NSIS installer; originally portable)
- `@dnd-kit/core` for dragging cards into plans
- `lucide-react` for UI icons
- `mana-font` for Magic mana symbols
- Scryfall bulk data for Standard card metadata and images

## Key Files

- `src/App.tsx`: main app UI, deck/matchup/plan logic, sorting, drag/drop, inline editing.
- `src/App.css`: dark theme and layout styling.
- `src/arena.ts`: MTG Arena import/export parsing, card name normalization, deck color inference.
- `src/scryfall.ts`: Scryfall bulk fetch, Standard filtering, card database conversion.
- `src/storage.ts`: localStorage persistence for decks and card database; fires backup on every save.
- `src/types.ts`: shared app data types.
- `src/electron.d.ts`: TypeScript declarations for `window.electronAPI` (backup IPC bridge).
- `electron/main.cjs`: Electron window wrapper; IPC handlers for rolling backup system.
- `electron/preload.cjs`: contextBridge that exposes `window.electronAPI` to the renderer.
- `electron/launch.cjs`: local desktop launcher.
- `data/standard-cards-scryfall.json`: removed at the 1.0.0 release. It was an old manual export that nothing read; the `Cards JSON` button produces a fresh one on demand.
- `package.json`: scripts and Windows packaging config (installer + GitHub update source).

## Data Storage

The app stores runtime data in localStorage:

- `mtg-sideboard-coach:decks`
- `mtg-sideboard-coach:standard-cards`

This means a portable `.exe` can be handed to someone else, but their decks and Scryfall sync live on their machine. The executable does not automatically include your local saved decks unless we later add import/export or bundled seed data.

## Automatic Backups

Every time decks are saved, `storage.ts` calls `window.electronAPI?.saveDecksBackup(json)` which triggers an IPC call to the main process. The main process writes a timestamped JSON snapshot to:

```
%APPDATA%\mtg-sideboard-coach\backups\decks-2026-06-23T14-32-00.json
```

Write conditions (both must be true):
- At least 1 hour has passed since the last backup.
- The deck content has changed since the last backup.

The backup modal (accessible via the `Backups` button in the deck library toolbar) lists the 50 most recent backups newest-first. Each entry has a `Restore` button that overwrites current localStorage state. A `Clear older than 7 days` button deletes old files.

IPC channels (all handled in `electron/main.cjs`):
- `save-decks-backup` — write a snapshot if conditions are met
- `list-backups` — return 50 most recent `{ filename, modifiedAt }` entries
- `load-backup` — read a specific file; guarded against path traversal
- `clear-old-backups` — delete files older than N days

The `window.electronAPI` object is only present in Electron (not browser dev mode); all call sites guard with optional chaining so the app works in both environments.

## Scryfall Sync

`Sync Standard` downloads Scryfall bulk `oracle_cards`, filters to English Standard-legal cards, and stores normalized card records locally.

Current Scryfall behavior:

- Uses Standard legality from Scryfall.
- Stores aliases for split/transform card faces.
- Stores `faceImageUris` for dual-faced previews.
- Stores card art/image URLs rather than downloading all images offline.
- Handles new Standard sets after Scryfall updates, assuming `Sync Standard` is run again.

## Arena Name Aliases

Some Arena sets use different card names than the Scryfall oracle database. `ARENA_NAME_ALIASES` in `src/scryfall.ts` maps Arena export names to Scryfall oracle names. The alias lookup runs after the main card index is built so it does not require a fresh Scryfall sync.

Current alias set: **Through the Omenpaths (OM1) → Marvel's Spider-Man (SPM)**

OM1 is the Arena-native digital set released September 2025. It uses in-universe MTG flavor names (e.g., "A Most Helpful Weaver") for cards that are mechanically identical to the tabletop SPM set (e.g., "Origin of Spider-Man"). Arena always exports using OM1 names, but Scryfall's `oracle_cards` bulk data uses SPM names. The alias table covers ~90 renamed cards across all colors so both OM1 and SPM card names resolve correctly on import.

To add new aliases for a future set: add entries to `ARENA_NAME_ALIASES` in `src/scryfall.ts`. No schema changes required; the lookup is a plain string-to-string map keyed by normalized Arena name.

## Deck Import / Export

Imports MTG Arena-style deck lists, including MTG Untapped exports.

Implemented import behavior:

- `Name ...` sets the deck name.
- `Deck` and `Sideboard` sections are recognized.
- A standalone `About` line is ignored.
- Unknown cards are skipped and reported.
- Unknown cards are not added to the deck.
- Cards with commas and split names are handled through normalized Scryfall lookup.
- Sideboards over 15 cards show a warning.

Export behavior:

- Decks export back to Arena-style text through the `Arena` button.

## Home Page

The home page shows a searchable/filterable list of decks.

Implemented:

- Dark theme.
- Large `MTG SIDEBOARD COACH` title.
- Scryfall card-count/status chips.
- `Sync Standard`, `Cards JSON`, `Import Deck`, and `Backups` buttons.
- Deck cards with representative art.
- Deck card image selection:
  - Main deck only.
  - Excludes lands.
  - Chooses highest copy count first: 4-of, then 3-of, then 2-of, then 1-of.
  - Within that, chooses highest mana value.
  - Ties choose alphabetically last.
- Color filters use boxed mana buttons.
- The gold exact button switches color filtering from "contains any selected color" to "exactly this selected color set."

Filter examples:

- `R`: decks/matchups containing red.
- `R + exact`: mono-red only.
- `R + U`: decks/matchups containing red or blue.
- `R + U + exact`: exactly Izzet only.

## Deck Page

The deck page has:

- Main deck column.
- Sideboard column.
- Matchups column.
- Sideboard Plan panel.

All four columns are locked to the app window height and scroll independently — no full-page scroll. Column headers (Main, Sideboard, Matchups, Sideboard Plan) are sticky and stay pinned at the top of each column when scrolling.

Deck renaming:

- The deck name in the workspace topbar is an inline editable input.
- It looks like the heading at rest; a border appears on hover/focus.
- Changes save immediately to localStorage via the existing `onUpdateDeck` / `useEffect` path.
- No separate rename modal or button is needed.

Implemented card row behavior:

- Rows show a left thumbnail.
- Thumbnail frame is based on casting-cost colors.
- Lands use actual color identity for the thumbnail frame.
- Colorless/artifact frame is light grey/silver.
- Quantity is centered in a fixed right-side count column.
- Card name truncates with ellipsis when needed.
- Casting cost appears under the card name.
- Split/room mana costs show both halves separated by `//`.
- Cards are draggable into sideboard plans.
- Drag image preview is suppressed.
- Hovering a row shows card art.
- Dual-faced cards show both faces when Scryfall face images are available.
- Hover previews follow the row vertically and clamp inside the visible app window.
- `Out` column previews open left so they do not run off-screen.

Inline card editing (no reimport needed):

- Each card row shows `−` and `+` quantity buttons on hover.
- Clicking `−` removes one copy; reaching zero deletes the row entirely.
- Clicking `+` adds one more copy.
- The `+`/`−` buttons are wrapped in `stopPropagation` so they do not trigger DnD drag activation.
- Each zone (Main, Sideboard) has an "Add card…" search input at the bottom.
- Typing 2+ characters opens an upward dropdown of up to 8 results (prefix matches first, then contains-matches, alphabetical within each group).
- Selecting a result adds 1 copy, or increments quantity if the card is already in the zone.
- Deck color identity updates immediately when cards are added or removed.
- Any sideboard plan entries for a removed/reduced card are capped via `normalizeMatchupPlans`.

Implemented deck sorting:

- Ascending mana value.
- Mana value 0 cards, mostly lands, sort at the bottom.
- Then alphabetical.
- Split/room cards sum the mana value of all halves, so `Unholy Annex // Ritual Chamber` sorts as 8.

Deck color identity:

- Deck identity uses casting-cost colors, not full Scryfall color identity.
- This avoids a deck being marked white because of a transformed face with white color identity when no white mana is cast.

## Matchups

Matchups are searchable and color-filterable. Matchup definitions are treated as a global library across decks.

Implemented:

- Matchup name.
- Matchup color tags.
- Notes.
- Main sideboard plan.
- Zero or more situational sideboarding blocks.
- Matchup color filters use the same boxed mana + exact toggle as the home page.
- Clicking the active matchup de-selects it and shows an empty Sideboard Plan panel.
- Creating a matchup adds that matchup to every deck.
- Imported/new decks receive blank copies of existing global matchups.
- Renaming a matchup or changing its colors updates that definition across all decks.
- Deleting a matchup removes it from all decks.
- Sideboarding notes, In/Out plans, and situational sections remain per-deck.

## Sideboard Plans

Main plan:

- Has `In` and `Out` columns.
- `In` accepts only cards that exist in the sideboard.
- `Out` accepts only cards that exist in the maindeck.
- Quantities are capped by source quantities.
- `-` reduces quantity and deletes the row when quantity reaches 0.
- `+` increases quantity up to available quantity.
- There is no separate per-row remove button: stepping to 0 removes the row.
- Totals appear beside `In` and `Out`.
- Rows sort the same way as main/sideboard columns.
- The plan header has copy/paste controls.
- Copy stores the selected matchup's notes, main `In` / `Out`, and situational sideboarding blocks in an in-app clipboard.
- Paste replaces the currently selected matchup's per-deck plan with the copied plan.
- Paste does not change the target matchup's global name or colors.

Situational sideboarding:

- Optional and expandable.
- Use `+ Situational Sideboarding` to add a block.
- Each block has its own notes and `In` / `Out` columns.
- The add button stays below the newest block so multiple situational blocks can be stacked.
- Each situational block can be removed.
- Existing single situational data from the earlier implementation migrates into a first expandable block.

Sideboard size validation:

- Main plan warning uses:
  - `starting sideboard - main In + main Out`
- Each situational block is evaluated as additive to the main plan:
  - `main post-board sideboard - situational In + situational Out`
- This reflects the intended workflow: the main plan is the base plan, and situational blocks are optional additions to that plan.

## Windows Build

**Superseded.** The portable build described here was replaced at 1.0.0 by an installer that updates itself from GitHub Releases. `npm run package:win` now produces `release/mtg-sideboard-coach-setup-<version>.exe`. See CLAUDE.md, *Installer and self-update*, for how it works and how to release.

Old portable builds left in `release/` (such as v3.2.0) are from before the version reset and are older than v1.0.0.

## Development Checklist

Before handing work back:

```powershell
npm run build
npm run lint
```

To run locally:

```powershell
npm run desktop
```

To package:

```powershell
npm run package:win
```

## Known Gaps / Future Ideas

- Add deck export/import for the app's full saved data, not just Arena deck text.
- Add offline image caching if Scryfall image loading ever feels slow.
- Add code signing for a cleaner Windows distribution (the app icon now exists: `build/icon.png`).
- Add tests for parsing, sorting, color filters, and plan quantity validation.
- Remove unused `@dnd-kit/sortable` dependency if sortable rows are definitely gone for good.
- Some OM1 black-section cards (~7 cards: Nill, Rhilex, Scorvus, Tethex, Viggo, Wekhdu, Wrench) may still be unmapped to their SPM equivalents — confirm and add if needed.
