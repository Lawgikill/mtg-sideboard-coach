export type OcrMatch = {
  raw: string
  name: string | null
  quantity: number
  score: number
}

// A card plus any other strings that should resolve to it. Double-faced cards need
// this: their `name` is the combined "Front // Back", but a tracker lists whichever
// face it saw under that face's own name, which is nothing like the combined one.
export type OcrCardCandidate = {
  name: string
  matchNames?: string[]
}

// Screenshots put the card art, mana pips and row chrome right next to the name, so
// OCR lines arrive with leading junk ("[#8]", "IN", "By * |") and trailing pipes.
// Rather than trying to clean that perfectly, we fuzzy-match against the real card
// list — "Pinnade starcage" only resolves because the database knows the true name.
function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Levenshtein with an early bail: once every cell in a row exceeds the cutoff the
// strings can't come back under it, so most non-matches abandon after a row or two.
function boundedDistance(a: string, b: string, cutoff: number) {
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let rowMin = i

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      current.push(value)
      if (value < rowMin) rowMin = value
    }

    if (rowMin > cutoff) return cutoff + 1
    previous = current
  }

  return previous[b.length]
}

// Any card whose two halves each carry their own name: transform and modal DFCs,
// but equally adventures, splits, and prepared spells ("Emeritus of Abundance //
// Regrowth"). A tracker lists whichever half it saw under that half's own name, and
// the combined name is nothing like it, so every half has to be matchable alone.
export function buildOcrCandidates(
  cards: Iterable<{ name: string; faces?: Array<{ name: string }> }>,
): OcrCardCandidate[] {
  const byName = new Map<string, OcrCardCandidate>()

  for (const card of cards) {
    if (byName.has(card.name)) continue

    const matchNames = new Set<string>()
    card.faces?.forEach((face) => { if (face.name) matchNames.add(face.name) })
    // Covers records carrying the combined name without per-face data.
    if (card.name.includes(' // ')) {
      card.name.split(' // ').forEach((part) => matchNames.add(part.trim()))
    }
    matchNames.delete(card.name)

    byName.set(card.name, { name: card.name, matchNames: Array.from(matchNames) })
  }

  return Array.from(byName.values())
}

type NormalizedName = { normalized: string; name: string }

function bestMatch(candidate: string, normalizedNames: NormalizedName[]) {
  let best: { name: string; score: number; matchedLength: number } | null = null

  for (const entry of normalizedNames) {
    const cutoff = Math.max(2, Math.floor(Math.max(candidate.length, entry.normalized.length) * 0.3))
    const distance = boundedDistance(candidate, entry.normalized, cutoff)
    if (distance > cutoff) continue

    const score = 1 - distance / Math.max(candidate.length, entry.normalized.length)
    if (!best || score > best.score) {
      best = { name: entry.name, score, matchedLength: entry.normalized.length }
    }
  }

  return best
}

function toNormalizedNames(cards: Array<string | OcrCardCandidate>): NormalizedName[] {
  const entries: NormalizedName[] = []

  for (const card of cards) {
    const candidate: OcrCardCandidate = typeof card === 'string' ? { name: card } : card
    entries.push({ name: candidate.name, normalized: normalize(candidate.name) })
    // Face names resolve to the parent card, so front and back collapse to one row.
    for (const alias of candidate.matchNames ?? []) {
      entries.push({ name: candidate.name, normalized: normalize(alias) })
    }
  }

  return entries
}

const MIN_SCORE = 0.72
// How close two candidate readings must be before the longer card name wins.
const SCORE_TIE_BAND = 0.08

export function parseOcrLines(lines: string[], cards: Array<string | OcrCardCandidate>): OcrMatch[] {
  const normalizedNames = toNormalizedNames(cards)
  const results: OcrMatch[] = []
  const seen = new Set<string>()

  for (const rawLine of lines) {
    const raw = rawLine.trim()
    if (!raw) continue

    // Quantity sits at either end depending on the source: trackers put it on the
    // right, Arena-style lists on the left.
    let working = raw.replace(/[|[\])(]+/g, ' ')
    let quantity = 1

    const trailing = working.match(/\s(\d{1,2})\s*$/)
    const leading = working.match(/^\s*(\d{1,2})\s+/)

    if (trailing) {
      quantity = Number(trailing[1])
      working = working.slice(0, trailing.index)
    } else if (leading) {
      quantity = Number(leading[1])
      working = working.slice(leading[0].length)
    }

    const normalizedLine = normalize(working)
    if (normalizedLine.length < 4) continue

    // Art thumbnails and set symbols bleed a stray token or two onto the front of
    // the line, so try the line with its first tokens dropped as well.
    const tokens = normalizedLine.split(' ')
    const candidates = [normalizedLine]
    if (tokens.length > 1) candidates.push(tokens.slice(1).join(' '))
    if (tokens.length > 2) candidates.push(tokens.slice(2).join(' '))

    // Trimming leading tokens can over-trim: "Eispeth. storm slayer" also contains a
    // perfect match for a hypothetical shorter "Storm Slayer". When scores are close,
    // prefer the longer card name so the fuller reading wins.
    let best: { name: string; score: number; matchedLength: number } | null = null
    for (const candidate of candidates) {
      if (candidate.length < 4) continue
      const match = bestMatch(candidate, normalizedNames)
      if (!match) continue
      if (!best) {
        best = match
        continue
      }
      const clearlyBetter = match.score > best.score + SCORE_TIE_BAND
      // Compare what was actually matched, not the card's full name — a face match
      // carries the long combined name and would otherwise always look "fuller".
      const tiedButFuller = match.score > best.score - SCORE_TIE_BAND && match.matchedLength > best.matchedLength
      if (clearlyBetter || tiedButFuller) best = match
    }

    if (!best || best.score < MIN_SCORE) {
      results.push({ raw, name: null, quantity, score: best?.score ?? 0 })
      continue
    }

    // The same card can span two OCR lines; keep the higher count rather than summing.
    if (seen.has(best.name)) {
      const existing = results.find((item) => item.name === best.name)
      if (existing) existing.quantity = Math.max(existing.quantity, quantity)
      continue
    }

    seen.add(best.name)
    results.push({ raw, name: best.name, quantity, score: best.score })
  }

  return results
}
