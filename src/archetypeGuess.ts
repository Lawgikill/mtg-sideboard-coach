// Guesses which archetype the opponent was playing, from the cards they were
// actually seen to own during a parsed MTGA match.
//
// The scoring itself is shared with the main process's deck attribution rather than
// reimplemented here — see electron/cardMatching.cjs for why it lives there.

import { containment } from '../electron/cardMatching.cjs'
import type { Matchup } from './types'

// Events that show the opponent *owning* a card. Mill is excluded on its own: a
// mill line is attributed to the card's owner, who is whoever is being milled.
const OWNERSHIP_KINDS = new Set([
  'play', 'cast', 'discard', 'sacrifice', 'exile', 'return', 'destroy', 'attack', 'mill',
])

// Hand and library are hidden, so a card leaving one is the moment a *distinct copy*
// becomes known — the only reliable way to count copies.
//
// Counting every ownership event instead made one creature that was cast, attacked,
// was exiled and died read as four copies. Counting entries into play fixed that but
// missed discards, which never enter play yet are plainly copies: two of a card
// discarded is two copies known. This rule covers both, and correctly ignores a
// spell recast from the graveyard, which is a copy already counted.
const HIDDEN_ZONES = new Set(['hand', 'library'])

// Kinds whose `cards` list belongs to the event's own seat, so it can be read for
// ownership. A merged discard or mill names several cards and keeps no single
// `card`, which is how every card an opponent discarded went unseen.
const OWNED_LIST_KINDS = new Set(['discard', 'mill', 'select'])

// Cards the opponent was seen to own during one game, with how many times each was
// seen. Shared by the archetype guess and the on-screen game summary, so the two can
// never disagree about what counts as "seen".
//
// A merged line drops its single `card`, so these kinds are also read through
// `cards` — their contents belong to the event's own seat (the player discarding,
// being milled, or taking cards from their library). Other kinds are not, because a
// merged line there lists cards acted *on* rather than owned.
//
// The `source` is always excluded: it is appended to `cards` so attributions stay
// hoverable, and it can belong to either player.
export function observedCardsInGame(game: MtgaGame, localSeat: number | null): Map<string, number> {
  const seen = new Map<string, number>()
  if (localSeat == null) return seen

  // Presence and copies are counted separately: being seen at all puts a card on the
  // list, while only leaving a hidden zone adds to its count. A creature cast once,
  // which then attacked, was exiled and died, is one copy seen four times.
  const copies = new Map<string, number>()
  for (const event of game.events) {
    // A merged line carries what each line folded into it contributed, since merging
    // drops the single `card`, keeps only one `fromZone`, and takes the first line's
    // `kind`. Everything else is a single contribution of its own. Seat and kind are
    // read per contribution: lines merged on a shared source can belong to different
    // players, and an exile folded into a counter is still an exile.
    const parts = event.origins?.length ? event.origins : [event]

    for (const part of parts) {
      const kind = part.kind ?? event.kind
      if (!OWNERSHIP_KINDS.has(kind)) continue
      if (part.seat === localSeat) continue

      const owned = OWNED_LIST_KINDS.has(kind)
        ? [part.card, ...(event.cards ?? [])].filter((name) => name && name !== event.source)
        : [part.card].filter(Boolean)

      for (const name of owned as string[]) {
        seen.set(name, 1)
        if (part.fromZone && HIDDEN_ZONES.has(part.fromZone)) {
          copies.set(name, (copies.get(name) || 0) + 1)
        }
      }
    }
  }

  // Four is the legal ceiling, and an observation that exceeds it is a miscount —
  // a spell recast from the graveyard is one card entering play twice.
  for (const card of seen.keys()) {
    seen.set(card, Math.min(Math.max(copies.get(card) || 0, 1), 4))
  }
  return seen
}

export function observedOpponentCards(match: MtgaMatch): Map<string, number> {
  const seen = new Map<string, number>()

  for (const game of match.games) {
    // Highest count in any one game, never the sum across games: casting Opt in two
    // games is evidence of one or two copies, not four.
    for (const [card, count] of observedCardsInGame(game, match.localSeat)) {
      seen.set(card, Math.max(seen.get(card) || 0, count))
    }
  }

  return seen
}

function poolFor(matchup: Matchup): Map<string, number> {
  const counts = new Map<string, number>()
  // Both the conventional list and anything recorded as "Also Seen": a card the
  // archetype is known to play is evidence for it wherever it was recorded.
  for (const entry of [...(matchup.opponentEntries ?? []), ...(matchup.opponentVariantEntries ?? [])]) {
    counts.set(entry.name, (counts.get(entry.name) || 0) + entry.quantity)
  }
  return counts
}

export type ArchetypeGuess = {
  name: string
  score: number
  margin: number
  cardsSeen: number
}

export function guessArchetype(match: MtgaMatch, matchups: Matchup[]): ArchetypeGuess | null {
  const observed = observedOpponentCards(match)
  if (observed.size === 0) return null

  const ranked = matchups
    .filter((matchup) => (matchup.opponentEntries ?? []).length > 0)
    .map((matchup) => ({ name: matchup.name, score: containment(observed, poolFor(matchup)) }))
    .sort((a, b) => b.score - a.score)

  // No cutoff on purpose. A weak guess is still a starting point, and the dropdown
  // beside it overrides in one click; the score is shown so a thin one reads as thin.
  if (ranked.length === 0 || ranked[0].score === 0) return null

  return {
    name: ranked[0].name,
    score: ranked[0].score,
    // Several of these archetypes share staples, so how far clear the leader is
    // says more about confidence than its raw score does.
    margin: ranked[0].score - (ranked[1]?.score ?? 0),
    cardsSeen: observed.size,
  }
}
