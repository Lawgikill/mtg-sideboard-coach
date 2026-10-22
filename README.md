# MTG Sideboard Coach

**Version 1.0.0** — see [CHANGELOG.md](./CHANGELOG.md).

A personal desktop app for building Magic: The Gathering Standard sideboard plans, logging matches, and reviewing MTGA games turn by turn.

The app is a React/Vite UI wrapped in Electron. It stores decks and the synced Scryfall card database in local storage inside the Electron app, and writes hourly deck backups to disk.

## Common Commands

```powershell
npm install
npm run desktop
npm run build
npm run lint
npm run package:win
```

- `npm run desktop`: builds the web app and opens it in Electron.
- `npm run build`: TypeScript + Vite production build.
- `npm run lint`: ESLint check.
- `npm run package:win`: builds a portable Windows executable in `release/`, named `MTG Sideboard Coach v<version> portable.exe`.

## What It Does

Each deck has three tabs:

- **Plans** — main deck, sideboard, and per-matchup In/Out plans. Matchups are shared across decks, and each can hold the opponent's decklist.
- **Journal** — match results, play/draw, notes, stats, search and export.
- **Replay** *(desktop only)* — MTGA's own logs turned into a readable play-by-play. It shows what the opponent showed and what they possibly boarded in, plus exactly what you boarded. Matches can be sent to the Journal or exported as HTML.

## User Workflow

1. Click `Sync Standard` to fetch Standard-legal cards from Scryfall.
2. Import a deck in MTG Arena / MTG Untapped-style text format.
3. Open a deck.
4. Create matchups and, optionally, import the opponent's decklist for each.
5. Drag or click cards from the sideboard into `In` and from the maindeck into `Out`.
6. Add optional situational sideboarding sections when a matchup has conditional plans.
7. After playing on MTG Arena with the app open, open the **Replay** tab, assign the opponent's archetype, and send the match to the Journal.

## Important Notes

- The `Cards JSON` button exports the local Scryfall card database.
- Card art is lazy-loaded from Scryfall URLs.
- A fresh Scryfall sync is needed when new Standard sets release.
- Dual-faced card previews depend on synced Scryfall `card_faces` image data.
- The packaged app is portable, but each computer keeps its own local app data.
- Replay reads MTGA's `Player.log` and its local card database. MTGA must be installed, with **Detailed Logs (Plugin Support)** turned on in MTGA's account settings, or game events are not written to the log at all.

## Documentation

- [CLAUDE.md](./CLAUDE.md) — the authoritative, current reference: data model, behaviours, and the reasoning behind them.
- [CHANGELOG.md](./CHANGELOG.md) — release notes.
- [PROJECT_HANDOFF.md](./PROJECT_HANDOFF.md) — the original knowledge-transfer document. Older, and narrower than CLAUDE.md.
