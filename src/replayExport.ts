// Plain-text rendering of a parsed MTGA match, for the clipboard and for .txt files.
// Kept out of App.tsx so the match export and the per-game export cannot drift apart:
// both go through buildReplayText, which differs only in which games it is handed.

import type { CardRecord, DeckEntry } from './types'
import { normalizeCardName } from './arena'
import { observedCardsInGame, observedOpponentCards } from './archetypeGuess'

const RULE = '='.repeat(60)

// One prepared seen-cards summary, used by the on-screen block and by both export
// formats. Built here rather than at each of the three sites so a file cannot list
// different cards, in a different order, from what was on screen when it was made.
//
// `cards` stays as pairs: the screen attaches a hover preview to each card, which a
// pre-formatted string could not carry.
export type ReplaySummary = {
  label: string
  cards: Array<[string, number]>
  boarded?: ReplayBoarded
}

// What the opponent appears to have brought in for a game after the first. Never
// stated as fact: a card can go unseen in game one and still have been maindeck, so
// this is what the evidence *allows*, not what is known.
export type ReplayBoarded = {
  label: string
  // Which baseline this was measured against. It says how much weight the inference
  // carries, so it is never dropped — but it is not what the line is read for, so on
  // screen and in HTML it is a tooltip. A text file has no hover, so there it prints.
  basis: string
  // Present only when some card is absent from the sideboard on file, which can only
  // be judged against a complete list.
  note: string
  cards: Array<{ name: string; count: number; unlisted: boolean }>
}

// Exactly fifteen sideboard cards is what makes a saved list a complete template: at
// fifteen there is nothing missing from it, so a card seen that is not in the maindeck
// must have been boarded in. Short of fifteen the list is a partial record, and
// treating its absences as meaningful would invent sideboarding out of missing data.
const COMPLETE_SIDEBOARD = 15

// Lands are left out of the boarding analysis entirely. Seeing a fifth Plains in game
// two says nothing about sideboarding — it says the deck draws lands — and a manabase
// is the part of a list a partial record is least likely to have recorded, so lands
// were the loudest source of false positives. Decks that genuinely board lands exist;
// this trades those rare cases for a signal that is readable the rest of the time.
//
// Judged on the front face, as the app's type grouping is everywhere else: a modal
// card with a land back is a spell when it is cast. A card the database does not know
// is kept rather than guessed at.
function isLand(card?: CardRecord): boolean {
  const typeLine = card?.faces?.[0]?.typeLine ?? card?.typeLine
  return Boolean(typeLine?.includes('Land'))
}

export type ReplaySummaries = {
  match: ReplaySummary
  games: Map<number, ReplaySummary>
}

// The optional extras a file can carry, each behind its own toggle. An options bag
// rather than more positional arguments: there are three of them now, all optional,
// and a caller passing them in the wrong order would type-check silently.
export type ReplayExtras = {
  summaries?: ReplaySummaries
  decklist?: ReplayDecklist
  // Our own boarding is read off the game itself, so this is a flag rather than data.
  boarding?: boolean
}

// Tokens are dropped — a Treasure the opponent made is not a card in their deck, and
// this list is about the deck. Sorted by name so two exports of the same match agree.
function summaryOf(seen: Map<string, number>, label: string, cardByName: Map<string, CardRecord>) {
  const cards = [...seen]
    .filter(([name]) => !cardByName.get(normalizeCardName(name))?.isToken)
    .sort((a, b) => a[0].localeCompare(b[0]))

  // Copies, not distinct names: a list showing "3 Breeding Pool" has shown three cards.
  // The boarding block counts the same way, so the two numbers on screen mean one thing.
  const copies = cards.reduce((sum, [, count]) => sum + count, 0)

  return { label: `${label} ${copies} card${copies === 1 ? '' : 's'}`, cards }
}

// The matchup's decklist on file, prepared the way the Replay tab shows it: main
// grouped by type, then Sideboard, then the net Also Seen delta. Built in App.tsx,
// which owns the type grouping, and carried here as plain data so the exporters need
// to know nothing about decks.
export type ReplayDecklistSection = { heading: string; cards: Array<[string, number]> }

export type ReplayDecklist = {
  label: string
  counts: string
  sections: ReplayDecklistSection[]
}

export function summaryCardLabel(name: string, count: number): string {
  return count > 1 ? `${count} ${name}` : name
}

// Cards seen in this game beyond what was already known to be in their deck.
//
// The two cases differ only in the baseline:
//   complete list  - their maindeck on file, plus whatever game one revealed
//   partial list   - game one alone
// In both, game one is the floor: a card seen before boarding is maindeck by
// definition, which is the same reasoning the Scout tab's "Seen in Game 1" rests on.
//
// Game two and game three are both measured against game one, never against each
// other: a card seen in game two was itself boarded in, so using it as a baseline
// would hide the very cards being looked for.
function boardedIn(
  match: MtgaMatch,
  game: MtgaGame,
  cardByName: Map<string, CardRecord>,
  opponentEntries: DeckEntry[],
): ReplayBoarded | undefined {
  const gameOne = match.games.find((entry) => entry.gameNumber === 1)
  if (game.gameNumber < 2 || !gameOne) return undefined

  const quantities = (zone: string) => {
    const counts = new Map<string, number>()
    for (const entry of opponentEntries) {
      if (entry.zone !== zone) continue
      const key = normalizeCardName(entry.name)
      counts.set(key, (counts.get(key) ?? 0) + entry.quantity)
    }
    return counts
  }

  const main = quantities('main')
  const sideboard = quantities('sideboard')
  const sideboardSize = [...sideboard.values()].reduce((sum, count) => sum + count, 0)
  const complete = sideboardSize === COMPLETE_SIDEBOARD

  const seenEarlier = new Map<string, number>()
  for (const [name, count] of observedCardsInGame(gameOne, match.localSeat)) {
    seenEarlier.set(normalizeCardName(name), count)
  }

  const cards: ReplayBoarded['cards'] = []
  let copies = 0

  for (const [name, count] of observedCardsInGame(game, match.localSeat)) {
    const card = cardByName.get(normalizeCardName(name))
    if (card?.isToken || isLand(card)) continue

    const key = normalizeCardName(name)
    // The higher of the two, not the sum: a list running 4 Forest against 2 seen in
    // game one still only accounts for 4.
    const known = Math.max(seenEarlier.get(key) ?? 0, complete ? main.get(key) ?? 0 : 0)
    const extra = count - known
    if (extra <= 0) continue

    copies += extra
    cards.push({
      name,
      count: extra,
      // Only meaningful against a complete list: in a partial one, absence from the
      // sideboard says nothing, because the sideboard itself is incomplete.
      unlisted: complete && !sideboard.has(key) && !main.has(key),
    })
  }

  if (cards.length === 0) return undefined

  cards.sort((a, b) => a.name.localeCompare(b.name))

  // Copies, not distinct names: two Negate is two cards in and two cards out. The
  // observed summary above counts distinct names instead, which is a different and
  // equally correct question about a different list.
  //
  return {
    label: `Possibly boarded in — ${copies} card${copies === 1 ? '' : 's'}:`,
    basis: complete ? 'measured against their 75 on file' : 'measured against game 1 only',
    note: cards.some((entry) => entry.unlisted) ? '* not on their sideboard list on file' : '',
    cards,
  }
}

// Pre-filled answers to the journal's first two prompts, which the log already knows:
//   Q1. What did you board in/out?      -> our own submission, exact
//   Q2. What did you see them board in? -> the inference, hedged as "possibly"
// The numbering is the prompt's, not positional, so Q2 keeps its number when Q1 is
// turned off. Every other prompt is left for the player to answer.
//
// Semicolons between cards, as everywhere else: card names contain commas.
export function gameNotesFromReplay(
  match: MtgaMatch,
  game: MtgaGame,
  cardByName: Map<string, CardRecord>,
  opponentEntries: DeckEntry[],
  includeOwnBoarding: boolean,
): string {
  const list = (cards: Array<{ name: string; count: number }>) =>
    cards.map((card) => summaryCardLabel(card.name, card.count)).join('; ')

  const lines: string[] = []

  if (includeOwnBoarding && game.sideboarding) {
    const { in: boardedIn, out: boardedOut } = game.sideboarding
    // Both halves on the one answer, with OUT on its own line: a sideboard plan reads
    // as a pair, and running them together makes neither side scannable.
    if (boardedIn.length > 0) lines.push(`1: IN: ${list(boardedIn)}`)
    if (boardedOut.length > 0) lines.push(`${boardedIn.length > 0 ? '' : '1: '}OUT: ${list(boardedOut)}`)
  }

  const theirs = boardedIn(match, game, cardByName, opponentEntries)
  if (theirs) lines.push(`2: Possibly boarded in: ${list(theirs.cards)}`)

  return lines.join('\n')
}

export function buildReplaySummaries(
  match: MtgaMatch,
  cardByName: Map<string, CardRecord>,
  // The matchup's list on file, when one is known. Absent, every game after the first
  // is still analysed — against game one alone, which is the partial-list case.
  opponentEntries: DeckEntry[] = [],
): ReplaySummaries {
  return {
    // Across the whole match the counts are the highest seen in any one game, never a
    // sum — two Opts in each of two games is evidence of two copies, not four.
    match: summaryOf(
      observedOpponentCards(match),
      `${match.opponent} showed, across ${match.games.length} games,`,
      cardByName,
    ),
    // A per-game list of what they showed was removed: every card in it is already in
    // the match block above, and in a game after the first the part that actually
    // differs is exactly what the boarding block states. Only the inference is left.
    games: new Map(match.games.map((game) => [
      game.gameNumber,
      { label: '', cards: [], boarded: boardedIn(match, game, cardByName, opponentEntries) },
    ])),
  }
}

// One card per line rather than a semicolon-separated run. A sixteen-card list wrapped
// across three lines of prose is hard to read down and impossible to scan for a card;
// the narration's semicolon convention is for lists inside a sentence, which this is not.
//
// No trailing blank line: both callers already follow the block with one, and adding a
// second here put two blank lines between the match summary and the first game.
function summaryLines(summary: ReplaySummary, indent: string): string[] {
  const lines = summary.cards.length > 0
    ? [
      `${indent}${summary.label}`,
      ...summary.cards.map(([name, count]) => `${indent}  ${summaryCardLabel(name, count)}`),
    ]
    : []

  if (summary.boarded) {
    lines.push(
      `${indent}${summary.boarded.label}`,
      ...summary.boarded.cards.map((entry) => `${indent}  ${
        summaryCardLabel(entry.name, entry.count)
      }${entry.unlisted ? ' *' : ''}`),
      // The basis is a tooltip on screen; a file has no hover, so it prints here.
      `${indent}  ${[summary.boarded.basis, summary.boarded.note].filter(Boolean).join(' · ')}`,
    )
  }

  return lines
}

// What we boarded, stated plainly. No hedging, unlike the opponent's block: this is
// our own submitted list before and after, so it is fact rather than inference.
function boardingLines(game: MtgaGame, indent: string): string[] {
  if (!game.sideboarding) return []

  const side = (label: string, cards: Array<{ name: string; count: number }>) => {
    if (cards.length === 0) return []
    const copies = cards.reduce((sum, card) => sum + card.count, 0)
    return [
      `${indent}${label} — ${copies} card${copies === 1 ? '' : 's'}:`,
      ...cards.map((card) => `${indent}  ${summaryCardLabel(card.name, card.count)}`),
    ]
  }

  return [...side('You boarded in', game.sideboarding.in), ...side('You boarded out', game.sideboarding.out)]
}

// The decklist as the tab shows it. Sections are already ordered and counted by the
// time they arrive, so this only lays them out.
function decklistLines(decklist: ReplayDecklist, indent: string): string[] {
  return [
    `${indent}${decklist.label} — ${decklist.counts}`,
    ...decklist.sections.flatMap((section) => [
      `${indent}  ${section.heading}`,
      ...section.cards.map(([name, quantity]) => `${indent}    ${quantity} ${name}`),
    ]),
  ]
}

function formatPlayedAt(value: string) {
  const when = new Date(value)
  if (Number.isNaN(when.getTime())) return value
  return when.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// How a game or match ended, shown only when it was not the ordinary way. A normal
// finish is "ResultReason_Game" / "MatchCompletedReasonType_Success", which says
// nothing a reader does not already know from the result itself.
//
// Unknown values are spaced out rather than suppressed: the one real match here
// ended normally, so every other value is unseen, and a reason worth reporting must
// not vanish because it was not anticipated.
export function describeEndReason(reason: string | null | undefined): string {
  if (!reason) return ''
  const raw = reason.replace('ResultReason_', '').replace('MatchCompletedReasonType_', '')
  // `Game` and `Success` are the ordinary finishes. `Concede` is suppressed although
  // it is not ordinary: a win is a win, and the closing line of the narration already
  // names who conceded, so repeating it in the result reads as a qualification on the
  // result itself. Everything else is still shown, including values never seen in a
  // real log — a reason worth reporting must not vanish for want of being anticipated.
  if (raw === 'Game' || raw === 'Success' || raw === 'Concede') return ''
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

export function describeStart(game: MtgaGame): string {
  if (game.onThePlay === null) return ''
  return game.onThePlay ? 'on the play' : 'on the draw'
}

function describeGame(game: MtgaGame) {
  const outcome = game.won === null ? 'no result recorded' : game.won ? 'won' : 'lost'
  const start = describeStart(game)
  const ended = describeEndReason(game.endReason)
  return `GAME ${game.gameNumber} — ${start ? `${start}, ` : ''}${outcome}` +
    `${ended ? ` by ${ended}` : ''}, ${game.maxTurn} turn${game.maxTurn === 1 ? '' : 's'}`
}

// Wins and losses are counted rather than taken from a match-level field: a match
// abandoned part way through has games with no result, and those must not read as
// losses the way a plain "games minus wins" would make them.
//
// Exported because the match picker labels games with the same verdict: two
// definitions of "won" would eventually disagree with each other.
export function matchRecord(games: MtgaGame[]) {
  const wins = games.filter((game) => game.won === true).length
  const losses = games.filter((game) => game.won === false).length
  const undecided = games.filter((game) => game.won === null).length

  let outcome = 'drawn'
  if (wins > losses) outcome = 'won'
  else if (losses > wins) outcome = 'lost'
  else if (wins === 0 && losses === 0) outcome = 'no result recorded'

  return { wins, losses, outcome, line: `${wins}-${losses} (${outcome})`, undecided }
}

function renderGame(game: MtgaGame, summary?: ReplaySummary, boarding?: boolean) {
  const lines: string[] = [RULE, describeGame(game), RULE, '']

  // Directly under the heading, matching the screen: what was boarded and what they
  // showed are the questions a replay is read with, not things to go looking for at
  // the end. Ours first — what we did, then what they appear to have done.
  if (boarding) {
    const boarded = boardingLines(game, '    ')
    if (boarded.length > 0) lines.push(...boarded, '')
  }
  if (summary) lines.push(...summaryLines(summary, '    '))

  for (const event of game.events) {
    // Turn headings carry their own blank line above, which is what gives the log
    // its shape when read as a block of text rather than as styled elements.
    if (event.kind === 'turn') {
      if (lines[lines.length - 1] !== '') lines.push('')
      lines.push(event.text)
      continue
    }
    lines.push(`    ${event.text}`)
  }

  return lines
}

// The opponent's archetype, once categorised, reads as a possessive: "LazyPunda's
// Simic Mill". One phrasing shared by the match picker, the on-screen header and the
// export, so the same match cannot be described three different ways.
// MTGA names the format "MatchWinCondition_Best2of3", which is a protocol value
// rather than something to show a player.
//
// Parsed by shape rather than looked up in a table: Best2of3 is the only value that
// appears in real logs here, so a table would be guessing at the others. The Bo1
// spelling is handled by name, and anything unrecognised degrades to its own words
// instead of a blank or a run-on token.
export function formatMatchFormat(condition: string | null | undefined): string {
  if (!condition) return ''
  const raw = condition.replace('MatchWinCondition_', '')

  const best = raw.match(/^Best(\d+)of(\d+)$/)
  if (best) return `Best of ${best[2]}`
  if (/^single/i.test(raw)) return 'Best of 1'

  return raw.replace(/([a-z])([A-Z])/g, '$1 $2')
}

export function opponentLabel(opponent: string, archetype?: string): string {
  return archetype ? `${opponent}'s ${archetype}` : opponent
}

export function buildReplayText(
  match: MtgaMatch,
  game?: MtgaGame,
  archetype?: string,
  extras: ReplayExtras = {},
): string {
  const { summaries, decklist, boarding } = extras
  const games = game ? [game] : match.games
  const record = matchRecord(match.games)

  const header = [
    game ? 'MTG Sideboard Coach — Game Replay' : 'MTG Sideboard Coach — Match Replay',
    `Deck: ${match.deckName || 'unassigned'}`,
    `Opponent: ${opponentLabel(match.opponent, archetype)}`,
    `Played: ${formatPlayedAt(match.playedAt)}`,
  ]

  if (match.matchWinCondition) {
    header.push(`Format: ${formatMatchFormat(match.matchWinCondition)}`)
  }
  // A single game still carries the match result: a game read on its own is hard to
  // place otherwise, and the file may well be shared without the rest of the match.
  header.push(`Match result: ${record.line}`)
  const completed = describeEndReason(match.completedReason)
  if (completed) header.push(`Match ended by: ${completed}`)
  if (game) header.push(`This file: game ${game.gameNumber} of ${match.games.length}`)
  if (record.undecided > 0) {
    header.push(`Note: ${record.undecided} game${record.undecided === 1 ? '' : 's'} with no result recorded`)
  }

  // The match-wide summary only belongs on a file covering the whole match: across two
  // games it is a different claim from either game's own list, and on a single-game
  // export it would merely repeat the block below it.
  const matchSummary = !game && match.games.length > 1 && summaries
    ? ['', ...summaryLines(summaries.match, '')]
    : []

  // Reference for the whole match, so it sits in the header region of either scope —
  // once, near the top, exactly as the tab places it above the first game.
  const list = decklist ? ['', ...decklistLines(decklist, '')] : []

  const body = games.flatMap((entry) => ['', ...renderGame(entry, summaries?.games.get(entry.gameNumber), boarding)])

  return [...header, ...matchSummary, ...list, ...body].join('\n').replace(/\s+$/, '') + '\n'
}

export function replayFileName(match: MtgaMatch, game?: MtgaGame, extension = 'txt'): string {
  // Opponent names are free text and reach the filesystem, so they are scrubbed the
  // same way the journal export scrubs matchup names.
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9 ,'()-]+/g, '-').trim() || 'match'
  const when = new Date(match.playedAt)
  const stamp = Number.isNaN(when.getTime()) ? 'replay' : when.toISOString().slice(0, 10)
  const suffix = game ? `-game-${game.gameNumber}` : ''

  return `replay-${stamp}-vs-${safe(match.opponent)}${suffix}.${extension}`
}
