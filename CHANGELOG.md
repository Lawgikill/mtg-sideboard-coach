# Changelog

## 1.5 — 2026-11-13

Almost everything here is in the Replay tab: the narration says more of what the log records, and gets several things right that it got wrong.

### Creature sizes everywhere

- **Every creature on the battlefield shows its size wherever it is named**: `Guiding Hydra (3/2) loses a +1/+1 counter and Nova Hellkite (6/7) and Starfield Shepherd (4/3) get a +1/+1 counter (Guiding Hydra)`. Counters, pumps and prowess all show up the same way, as the number beside the name. A creature leaving the battlefield shows its last size there: `Duelist of the Mind (0/3) dies`.
- **Combat shows sizes at each step**: on the attack, on the block, and on the damage, so growth mid-combat is visible and the damage adds up.
- **Blocks name the blocker**: `Nova Hellkite (5/5) is blocked by Duelist of the Mind (0/3)`.
- **Attacks state the defender's life**: `Nova Hellkite (5/5) attacks Tropical Taco (12 life)`.
- **Power and toughness changes are reported**: `Pompous Battlemage (4/4) gets +1/+1 from prowess`, `Salt Vampire (0/0) gets -2/-2 (Eject the Warp Core)`.

### New in the narration

- **Warp**: `casts and resolves Nova Hellkite for warp`, and the end-step exile, `Nova Hellkite (5/6) is exiled by warp`. Other alternative costs read the same way (`for harmonize`, `without paying its mana cost`).
- **Creatures tapped to pay for a spell**: `… for harmonize, tapping Duelist of the Mind`.
- **Cast copies**: `casts and resolves a copy of Improvised Act from exile (Pompous Battlemage)`.
- **Entering tapped**: `Quantum Riddler (5/7) enters tapped`, for spells resolving and creatures returning to the battlefield.
- **Sagas state their chapter**: `The Naked Time gets a Lore counter (now 3)`. Other counters show their count too, except +1/+1 counters, which the size already shows.
- **Cards put onto the battlefield say where from**: `Tropical Taco puts Mountain from their library onto the battlefield tapped and shuffles (The Naked Time)`. Your own searches end `, and shuffles` too.
- **Gaps in MTGA's own log are pointed out**: MTGA occasionally leaves a batch of updates out of its log. The narration now says so where it happens, instead of reading as if nothing occurred.

### Fixes

- **Creatures exiled instead of dying no longer read "dies"**: `Momo, Friendly Flier (1/1) is exiled instead of dying (Torch the Tower)`.
- **Searches count what they put onto the battlefield**: The Naked Time and Final Frontier read "takes 0 of 1 option" above the land they had just fetched.
- **Combat damage to a player is reported once.** A separate life-loss line repeated it and blamed all of it on one attacker.
- **Two Sagas at different chapters are no longer merged into one line**, and a chapter's effect is credited to the right copy.
- **Things that happened in different phases are no longer merged into one line**, such as a creature entering with counters and its beginning-of-combat trigger.
- **A spell cast just before a gap in MTGA's log is no longer dropped** as if it had been cancelled, and that turn no longer closes with land counts the gap made wrong.
- **"What they showed" counts fetched and tutored cards**, so lands fetched by an opponent's spells are no longer missing from the totals.
- **Two cards surveiled at once read correctly**, not as `puts Island and Final Frontier undefined`.

### Smaller changes

- **Sideboarding lists always show a count**, 1 included: `1 Nova Hellkite`. This covers your boarding, the opponent's possible board-ins, and the Journal notes that Import from Replay fills in.
- The separators in a list of card names are no longer coloured like the rest of a red damage line.
- The replay download buttons say they save HTML files, not text files.

## 1.4 — 2026-11-12

Fixes to how the Replay tab reads MTGA logs. The biggest affects any session with more than one match.

### Fixes

- **Every match in a session is read on its own terms.** One MTGA log covers a whole session, and your seat can change from match to match. Seats, player names, results and decks were worked out once per log, so in a session of several matches:
  - matches where you sat in the other seat showed wins as losses, and listed your own cards as the opponent's;
  - every match was named after the session's last opponent;
  - most matches after the first showed no result at all;
  - every match was filed under the first match's deck.
- **A game won by the opponent conceding no longer shows as a loss** when it was not the first game of the match.
- **Deck matching works for best-of-one sessions.** The deck used for game 1 was never read, so a session starting with a best-of-one match could not be matched to a deck.
- **Your own cards no longer appear in "what they showed".** A creature of yours dying into exile, or a warp spell you recast from exile, was counted as the opponent's. Those recasts also read `Seat 483 casts Nova Hellkite from exile`; they now read `Lawgikill casts and resolves Nova Hellkite from exile`.
- **Two-sided cards are listed under their front name** in the opponent summary, so a Pompous Battlemage's prepared Improvised Act no longer appears as a separate card.
- **The matchup decklist marks two-sided cards as seen**, and they are no longer mistaken for boarded-in cards, when the list on file holds the full `Front // Back` name.

Matches already imported into the Journal keep what was imported; re-import any whose results matter.

## 1.3 — 2026-10-24

- The **New Deck** card on the home screen shows its **+** centred above the label, no longer floating beside it.

## 1.2 — 2026-10-24

Versions are two-part from here on: 1.2, 1.3, and so on. Almost every change is in the Replay narration.

### New in the narration

- **Abilities a permanent gains** are reported: `Pawpatch Recruit gains double strike (Practiced Offense)`, `Leatherhead, Swamp Stalker gains haste and ward {1} (Lavaspur Boots)`. This is also how a Practiced Offense choice of double strike or lifelink shows, including the opponent's.
- **Ward payments**: `Rish pays {1} for ward (Keen-Eyed Curator)`. Without this, a land tapped for ward just looked missing from the turn's mana.
- **Activated abilities that never resolve**: `Lavaspur Boots' ability never resolves`, for example an equip whose target died in response.
- **Named cards and chosen land types**: `Rish plays Petrified Hamlet, choosing Fountainport`, `Lawgikill plays Multiversal Passage tapped, choosing Forest`.
- **A permanent becoming a creature**: `Plains becomes a creature`, after an earthbend.
- **Damage to a planeswalker shows the loyalty left**: `deals 2 damage to The Theorist, Jace Beleren (now 2 loyalty)`. This replaces a separate loyalty-counter line that only repeated the hit.

### Clearer lines

- **Mulligans read in order**: `Lawgikill mulligans and draws 7: …` then `Lawgikill bottoms Lavaspur Boots and keeps 6`, in place of "mulligans to 6" above a seven-card list. After a double mulligan, each redraw gets its own line. Opening hands are introduced with a colon.
- **Damage and the life it costs stay on one line**, even when other combat results are reported between them.

### Fixes

- A double striker's two hits no longer read as two copies (`2 Pawpatch Recruit deal 4 damage`).
- A life or loyalty total is no longer shown on a line before the remaining hits in the same combat step have been listed.

### Elsewhere

- Matchup colour pips in the Plans tab stay on one line, centred beside the name.
- The app shows its version as two parts (`v1.2`).

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
