export type OcrWord = {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}

// Trackers often show the opponent's cards in two side-by-side columns. Tesseract's
// own line grouping runs straight across the image and staples a left-column card to
// a right-column one ("Cori Mountain Monastery 1 5 Three Steps Ahead 1"), which no
// amount of fuzzy matching can recover. Rebuilding lines from word geometry instead
// splits the columns first, then groups each one into rows.

const MIN_GAP_RATIO = 0.025
const MIN_GAP_PX = 16
// Swept against real screenshots: below 0.6 a card's quantity splits onto its own
// row, above 0.7 adjacent rows start merging. 0.65 sits in the middle of the plateau.
const ROW_TOLERANCE_RATIO = 0.65

function hasWords(text: string) {
  return /[a-zA-Z]{3}/.test(text)
}

// Vertical whitespace corridors that no word crosses are candidate column splits.
function findColumnBounds(words: OcrWord[], minGap: number) {
  const spans = words
    .map((word) => [word.x0, word.x1] as [number, number])
    .sort((a, b) => a[0] - b[0])

  const merged: Array<[number, number]> = []
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }

  const groups: Array<[number, number]> = []
  for (const span of merged) {
    const last = groups[groups.length - 1]
    if (last && span[0] - last[1] < minGap) last[1] = Math.max(last[1], span[1])
    else groups.push([span[0], span[1]])
  }

  return groups
}

function centreY(word: OcrWord) {
  return (word.y0 + word.y1) / 2
}

function groupIntoLines(words: OcrWord[], rowToleranceRatio: number) {
  const sorted = [...words].sort((a, b) => centreY(a) - centreY(b))

  // Median height, not per-word height: fragments of card art come through as tall
  // "words", and sizing the tolerance off those merges neighbouring rows into one.
  const heights = sorted.map((word) => word.y1 - word.y0).sort((a, b) => a - b)
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10
  const tolerance = medianHeight * rowToleranceRatio

  const lines: OcrWord[][] = []
  // Anchored on the row's first word rather than its last, so a run of slightly
  // drifting words cannot walk the line down into the row below.
  let anchor = Number.NEGATIVE_INFINITY

  for (const word of sorted) {
    const centre = centreY(word)
    if (lines.length === 0 || centre - anchor > tolerance) {
      lines.push([word])
      anchor = centre
      continue
    }
    lines[lines.length - 1].push(word)
  }

  return lines.map((line) => [...line].sort((a, b) => a.x0 - b.x0))
}

export function linesFromWords(words: OcrWord[], rowToleranceRatio = ROW_TOLERANCE_RATIO): string[] {
  const usable = words.filter((word) => word.text.trim().length > 0)
  if (usable.length === 0) return []

  const left = Math.min(...usable.map((word) => word.x0))
  const right = Math.max(...usable.map((word) => word.x1))
  const minGap = Math.max(MIN_GAP_PX, (right - left) * MIN_GAP_RATIO)

  const bounds = findColumnBounds(usable, minGap)

  // A strip holding only digits is the quantity gutter beside a column, not a column
  // of its own — folding it back in is what keeps each count attached to its card.
  const columns: OcrWord[][] = []
  for (const [start, end] of bounds) {
    const slice = usable.filter((word) => {
      const centre = (word.x0 + word.x1) / 2
      return centre >= start && centre <= end
    })
    if (slice.length === 0) continue

    const textBearing = slice.filter((word) => hasWords(word.text)).length >= 2
    if (!textBearing && columns.length > 0) {
      columns[columns.length - 1].push(...slice)
      continue
    }
    columns.push(slice)
  }

  return columns.flatMap((column) =>
    groupIntoLines(column, rowToleranceRatio).map((line) => line.map((word) => word.text).join(' ').trim()),
  )
}
