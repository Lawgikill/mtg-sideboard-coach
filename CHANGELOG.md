# Changelog

## 1.1.0 — 2026-10-22

The first update delivered through the app's own updater. Every change is in the Replay narration.

### New in the narration

- **Your chosen modes and optional costs** appear on the cast line: `casts and resolves Pawpatch Recruit with offspring`, `casts Bushwhack, choosing "Search your library for a basic land card…"`. These are only ever recorded for your own spells.
- **Your activated abilities name their targets**, as spells already did: `activates Lavaspur Boots: Equip {1}, targeting Plains`. That matters most when the effect never happens, such as an equip whose target was killed in response.
- **Attackers show their size** when they attack: `Keen-Eyed Curator (8/7) attacks Rish`, with counters, equipment and other bonuses already included.
- **Counterspells are credited**: `Leatherhead, Swamp Stalker is countered (Three Steps Ahead)`.
- **Token copies say so, with their real size**: `creates a 1/1 token copy of Pawpatch Recruit`. Hovering it shows the actual token card, not the 2/1 card it copies.

### Clearer lines

- Identical tokens are counted (`creates 2 Map tokens (Get Lost)`), and every token line says "token".
- Activation lines drop restrictions like "Activate only as a sorcery". The ability was already used, so they say nothing.
- Lines that combine three related events no longer repeat the player's name.
- Same-named tokens of different sizes (the various Soldier tokens) now preview the right one.

### Fixes

- `creates a Illusion` now reads `creates an Illusion token`.

## 1.0.0 — 2026-10-22

First release. Version numbers before this (up to 3.2.0) were pre-release builds and are not part of this sequence.

### Installing and updating

- Windows installer: per-user, no admin prompt, with Start menu and desktop shortcuts. Uninstalling keeps all your data.
- Automatic updates from GitHub Releases: checks shortly after launch and every few hours, downloads in the background, then offers **Restart to update**. Ignore it and the update installs the next time you close the app.
- The home screen shows the installed version with a **Check for updates** button.
- Only one copy of the app runs at a time; launching it again brings the open window forward.

### Decks

- Import decks from MTG Arena or Untapped text; export back to Arena format by copy or `.txt` download.
- Colour identity and splash colours inferred from mana pips, not card counts.
- Main deck grouped by card type and sorted by mana value. The same ordering backs every export.
- Four-copy-limit violations flagged across both zones without changing the list.
- Standard card database synced from Scryfall's bulk data, tokens included.
- Automatic hourly deck backups on desktop, with restore.

### Sideboard plans

- Global matchups shared across every deck, with per-deck In/Out plans and situational sections.
- Drag or click cards into a plan. Copy or paste a plan, or copy one from another deck.
- Sideboard Stats: what comes in and out most across all matchups.
- Opponent decklists per matchup: editable, importable from text or a tracker screenshot (OCR, desktop only), with an "Also Seen" list for cards met in play.
- Filter matchups by cards in the opponent's list.

### Journal

- Match and game log with results, play/draw (inferred where not set), and per-game notes.
- Match Stats: winrate, records, a per-matchup breakdown, and on-the-play / on-the-draw game rates.
- Search notes with Ctrl+F, filter by archetype, export everything or the filtered set.
- Pop-out Journal window, kept in sync with the main window.

### Replay (desktop only)

- MTGA logs archived automatically and parsed into a turn-by-turn narration of each game, with hoverable card names.
- Covers casts, resolutions, combat, damage, life changes with their causes, counters, tokens, targets, modal choices, activated abilities, library searches, mulligans (including the hand you threw away and what you bottomed), turn-end hand, library and untapped-land counts, and how each game ended.
- Opponent archetype assignment, with a best guess from the cards they showed.
- Match summary of every opponent card seen, beside their decklist on file.
- Per game after the first: exactly what you boarded in and out, and what the opponent possibly boarded in.
- Send a match to the Journal, with sideboarding answers pre-filled, or push the cards seen into a matchup's Also Seen.
- Find within a replay; copy as text; download as standalone HTML; download every match against one archetype as a zip.

### Known limitations

- The installer is unsigned, so a first install downloaded through a browser shows a Windows SmartScreen prompt (*More info → Run anyway*). Updates after that install without it.
- Replay reads archived logs, so it works after a match, not during one.
- The opponent's hand, targets, searches and sideboard submission are never sent to your client, so those stay hidden or are inferred.
- MTGA sometimes leaves events out of its log entirely, for example a cost payment. The narration does not invent what isn't there.
- A Journal entry imported from Replay takes its date from the archived log file, so matches from one MTGA session share a date.
- The final turn of a game gets no end-of-turn counts line.
