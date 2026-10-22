// Scoring primitives shared by the two things that compare card lists: deck
// attribution in the main process (deckMatch.cjs) and the opponent-archetype guess
// in the renderer (src/archetypeGuess.ts).
//
// It lives under electron/ rather than a top-level shared/ folder for a packaging
// reason, not a conceptual one: electron-builder ships "electron/**/*" and
// "dist/**/*", so a new top-level folder would be missing from the installed app.
// The renderer's copy is bundled into dist/ by Vite, so only the main process reads
// this file at runtime.
//
// It is CommonJS because the main process is: electron/*.cjs ships unbundled and is
// require()d directly, so it cannot be ESM. Vite converts it for the renderer.

const BASIC_LANDS = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
  'Snow-Covered Mountain', 'Snow-Covered Forest', 'Snow-Covered Wastes',
])

// Basics are near-useless as evidence: every green deck runs a pile of Forests, so
// counting them in full makes unrelated decks of the same colour look similar. They
// still carry a little weight, since the *number* of basics is mildly characteristic.
const BASIC_WEIGHT = 0.15

function weightFor(name) {
  return BASIC_LANDS.has(name) ? BASIC_WEIGHT : 1
}

function countByName(names) {
  const counts = new Map()
  for (const name of names) {
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return counts
}

// How much of the observed list is drawn from a candidate pool. Asymmetric on
// purpose, and the asymmetry is the point in both callers:
//
//   - A game-two decklist swaps in sideboard cards, so comparing it to a maindeck
//     alone scored a correctly-matched deck at 0.56. Against the whole 75: 0.98.
//   - A single game shows only a fraction of the opponent's deck, so any measure
//     that penalised unseen cards would score every candidate near zero.
//
// The question is whether what was seen fits the candidate, not whether all of the
// candidate was seen.
function containment(observedCounts, poolCounts) {
  let shared = 0
  let total = 0

  for (const [name, quantity] of observedCounts) {
    const weight = weightFor(name)
    shared += Math.min(quantity, poolCounts.get(name) || 0) * weight
    total += quantity * weight
  }

  return total === 0 ? 0 : shared / total
}

module.exports = { BASIC_LANDS, BASIC_WEIGHT, containment, countByName, weightFor }
