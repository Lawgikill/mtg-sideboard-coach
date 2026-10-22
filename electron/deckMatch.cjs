// Matches a decklist submitted to MTGA against the decks stored in the app, so a
// parsed game can be filed under the deck it was played with.
//
// Exact matching is useless in practice: a list drifts by a card or two between
// sessions and would stop matching itself. Quantities matter though — four copies
// versus one is a real difference — so this is a weighted Jaccard over card counts
// rather than a plain set overlap.

// Scoring lives in cardMatching.cjs because the renderer's archetype guess scores
// the same way; one definition means the two cannot drift apart.
const { BASIC_LANDS, containment, countByName } = require('./cardMatching.cjs')

function poolOf(deck) {
  const counts = new Map()
  // Both zones: a sideboarded game is still the same 75 cards.
  for (const entry of deck.entries || []) {
    counts.set(entry.name, (counts.get(entry.name) || 0) + entry.quantity)
  }
  return counts
}

// Below this, a game is left unassigned rather than filed under a wrong deck: a
// wrong attribution silently pollutes a deck's history, which is worse than asking.
// Measured against real data — correct matches scored 0.69 (a 20-card drift) to
// 1.00, while every mismatch stayed at or below 0.33, so the gap is wide.
const MATCH_THRESHOLD = 0.6

function scoreDecks(submittedNames, decks) {
  const submitted = countByName(submittedNames)

  return decks
    .map((deck) => ({ deckId: deck.id, name: deck.name, score: containment(submitted, poolOf(deck)) }))
    .sort((a, b) => b.score - a.score)
}

function matchDeck(submittedNames, decks, threshold = MATCH_THRESHOLD) {
  const scored = scoreDecks(submittedNames, decks)
  const best = scored[0]
  const runnerUp = scored[1]

  return {
    deckId: best && best.score >= threshold ? best.deckId : null,
    deckName: best && best.score >= threshold ? best.name : null,
    score: best ? best.score : 0,
    // How clear the win was. A close second means the decks are near-identical
    // (two builds of one archetype), which is worth surfacing rather than hiding.
    margin: best && runnerUp ? best.score - runnerUp.score : (best ? best.score : 0),
    ranked: scored,
  }
}

module.exports = { matchDeck, scoreDecks, containment, poolOf, countByName, MATCH_THRESHOLD, BASIC_LANDS }
