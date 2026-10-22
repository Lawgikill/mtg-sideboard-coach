import type { Deck, GameLog, MatchLog } from './types'

// The review prompts shown in the Journal's General Notes box. They live here
// because the export falls back to them when a deck's notes are still untouched.
export const JOURNAL_NOTES_PROMPTS = [
  'Q1. What did you board in/out?',
  'Q2. What did you see them board in?',
  'Q3. What actually won or lost the game? Name specific cards.',
  "Q4. Was there a turn where you couldn't do what you needed to? Be specific.",
  'Q5. Which cards were dead or bad in your hand?',
  'Q6. Which card(s) swung the game the most?',
  'Q7. What ran out first: life, cards in hand, threats, or answers?',
  'Q8. If you replayed this game, would you board differently?',
].join('\n')

const RULE = '='.repeat(66)
const THIN_RULE = '-'.repeat(66)

function formatStamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

function formatExportedAt(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatRecord(wins: number, losses: number, draws: number) {
  return draws > 0 ? `${wins}-${losses}-${draws}` : `${wins}-${losses}`
}

function getMatchOutcome(match: MatchLog) {
  const wins = match.games.filter((game) => game.result === 'win').length
  const losses = match.games.filter((game) => game.result === 'loss').length
  const draws = match.games.filter((game) => game.result === 'draw').length
  const played = wins + losses + draws

  // A match with nothing recorded yet is "in progress", not a draw.
  const outcome = played === 0 ? 'Unplayed' : wins > losses ? 'Win' : losses > wins ? 'Loss' : 'Draw'
  return { wins, losses, draws, outcome }
}

export type MatchupRecord = {
  name: string
  wins: number
  losses: number
  draws: number
  played: number
  winRate: number | null
}

// Win rate counts decided matches only: draws and unplayed entries would otherwise
// drag the percentage down without representing a loss.
function toWinRate(wins: number, losses: number) {
  const decided = wins + losses
  return decided === 0 ? null : wins / decided
}

// Shared so the Journal filter buckets blank opponents the same way the stats do.
export const UNSPECIFIED_OPPONENT = 'Unspecified'

function summarize(deck: Deck) {
  const matches = deck.matchLogs ?? []
  const totals = { matchWins: 0, matchLosses: 0, matchDraws: 0, gameWins: 0, gameLosses: 0, gameDraws: 0 }
  const byName = new Map<string, { wins: number; losses: number; draws: number; played: number }>()

  for (const match of matches) {
    const { wins, losses, draws, outcome } = getMatchOutcome(match)
    totals.gameWins += wins
    totals.gameLosses += losses
    totals.gameDraws += draws
    if (outcome === 'Win') totals.matchWins += 1
    else if (outcome === 'Loss') totals.matchLosses += 1
    else if (outcome === 'Draw') totals.matchDraws += 1

    const key = match.opponent.trim() || UNSPECIFIED_OPPONENT
    const row = byName.get(key) ?? { wins: 0, losses: 0, draws: 0, played: 0 }
    row.played += 1
    if (outcome === 'Win') row.wins += 1
    else if (outcome === 'Loss') row.losses += 1
    else if (outcome === 'Draw') row.draws += 1
    byName.set(key, row)
  }

  // Play/draw is a per-game property, so these are GAME win rates — unlike the
  // headline figure, which is per match.
  const starts = {
    play: { wins: 0, losses: 0 },
    draw: { wins: 0, losses: 0 },
  }
  for (const match of matches) {
    match.games.forEach((game, index) => {
      const start = resolveGameStart(match.games, index)
      if (start !== 'play' && start !== 'draw') return
      if (game.result === 'win') starts[start].wins += 1
      else if (game.result === 'loss') starts[start].losses += 1
    })
  }

  const onPlay = { ...starts.play, winRate: toWinRate(starts.play.wins, starts.play.losses) }
  const onDraw = { ...starts.draw, winRate: toWinRate(starts.draw.wins, starts.draw.losses) }

  const byMatchup: MatchupRecord[] = Array.from(byName.entries())
    .map(([name, row]) => ({ name, ...row, winRate: toWinRate(row.wins, row.losses) }))
    .sort((a, b) => b.played - a.played || a.name.localeCompare(b.name))

  return { matches, ...totals, byMatchup, onPlay, onDraw, winRate: toWinRate(totals.matchWins, totals.matchLosses) }
}

export function summarizeJournal(deck: Deck) {
  return summarize(deck)
}

const RESULT_LABEL: Record<string, string> = { win: 'Win', loss: 'Loss', draw: 'Draw', '': '-' }
const START_LABEL: Record<string, string> = { play: 'On the play', draw: 'On the draw', '': '' }

// Whoever lost the previous game chooses who starts, and all but always chooses to
// play — so winning game one puts you on the draw, losing it puts you on the play.
export function inferGameStart(games: GameLog[], index: number): '' | 'play' | 'draw' {
  if (index === 0) return ''
  const previous = games[index - 1]
  if (previous.result === 'win') return 'draw'
  if (previous.result === 'loss') return 'play'
  return ''
}

export function resolveGameStart(games: GameLog[], index: number) {
  return games[index].start ?? inferGameStart(games, index)
}

// `filterLabel` records which archetype a filtered export covers, so the file says
// so on its face and cannot later be mistaken for a complete log.
export function buildJournalText(deck: Deck, now = new Date(), filterLabel?: string) {
  const { matches, matchWins, matchLosses, matchDraws, gameWins, gameLosses, gameDraws } = summarize(deck)
  const lines: string[] = [RULE, `MATCH JOURNAL - ${deck.name}`, RULE]

  if (deck.colors.length > 0) lines.push(`Colors:       ${deck.colors.join('')}`)
  if (filterLabel) lines.push(`Matchup:      ${filterLabel}`)
  lines.push(`Exported:     ${formatExportedAt(now)}`)
  lines.push(`Matches:      ${matches.length}`)
  lines.push(`Match record: ${formatRecord(matchWins, matchLosses, matchDraws)}`)
  lines.push(`Game record:  ${formatRecord(gameWins, gameLosses, gameDraws)}`)
  lines.push('')

  // Falls back to the prompts so the questions travel with the log even on a deck
  // whose notes are still untouched (undefined until the player types something).
  const notes = (deck.journalNotes ?? JOURNAL_NOTES_PROMPTS).trim()
  if (notes) {
    lines.push(THIN_RULE, 'GENERAL NOTES', THIN_RULE, notes, '')
  }

  if (matches.length === 0) {
    lines.push('No matches logged yet.')
    return lines.join('\n')
  }

  for (const match of matches) {
    const { wins, losses, draws, outcome } = getMatchOutcome(match)
    const opponent = match.opponent.trim() || 'Unknown opponent'
    const record = outcome === 'Unplayed' ? outcome : `${outcome} (${formatRecord(wins, losses, draws)})`
    const heading = `vs. ${opponent}`

    lines.push(THIN_RULE)
    // Right-align the result when the heading leaves room for it.
    lines.push(heading.length + record.length + 2 <= RULE.length
      ? `${heading.padEnd(RULE.length - record.length)}${record}`
      : `${heading}  ${record}`)
    lines.push(formatStamp(match.date))
    lines.push(THIN_RULE)

    // Result and play/draw sit on their own line with the notes flush beneath, so a
    // long answer keeps the full width instead of wrapping into a narrow column.
    match.games.forEach((game, index) => {
      const start = START_LABEL[resolveGameStart(match.games, index)] ?? ''
      const result = (RESULT_LABEL[game.result] ?? '-').padEnd(6)
      lines.push(`Game ${index + 1}  ${result}${start}`.trimEnd())

      for (const note of game.notes.split('\n')) lines.push(note.trimEnd())
      lines.push('')
    })
  }

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines.join('\n')
}
