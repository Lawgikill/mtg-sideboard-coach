import type { CardRecord, Deck, DeckEntry, MtgColor, Zone } from './types'

const CARD_LINE = /^(?:(\d+)x?\s+)?(.+?)(?:\s+\([^)]+\)\s+\d+)?$/
const COLOR_ORDER: MtgColor[] = ['W', 'U', 'B', 'R', 'G']

export type ArenaImportResult = {
  deck: Deck
  skipped: Array<{
    line: string
    name: string
    quantity: number
    reason: 'not_found'
  }>
}

export function normalizeCardName(name: string) {
  return name
    .toLowerCase()
    .replace(/\s+\/\/\s+/g, ' // ')
    .replace(/[^\p{L}\p{N}/' -]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function createId(prefix: string) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function parseArenaDecklist(
  text: string,
  cardIndex: Map<string, CardRecord>,
  fallbackName = 'Imported Deck',
): ArenaImportResult {
  const entries: DeckEntry[] = []
  const skipped: ArenaImportResult['skipped'] = []
  let zone: Zone = 'main'
  let deckName = fallbackName

  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim()
    if (!line) return

    const lowered = line.toLowerCase()
    if (lowered === 'about') {
      return
    }
    if (lowered === 'deck') {
      zone = 'main'
      return
    }
    if (lowered === 'sideboard') {
      zone = 'sideboard'
      return
    }
    if (lowered.startsWith('name ')) {
      deckName = line.slice(5).trim() || fallbackName
      return
    }
    if (lowered === 'companion' || lowered === 'commander') {
      zone = 'sideboard'
      return
    }

    const match = line.match(CARD_LINE)
    if (!match) return

    const quantity = Number(match[1] ?? 1)
    const name = match[2].trim()
    const card = cardIndex.get(normalizeCardName(name))

    if (!card) {
      skipped.push({
        line,
        name,
        quantity,
        reason: 'not_found',
      })
      return
    }

    entries.push({
      id: createId('entry'),
      cardId: card.id,
      name: card.name,
      quantity,
      zone,
    })
  })

  const colorProfile = inferDeckColorProfile(entries, cardIndex)
  const deck: Deck = {
    id: createId('deck'),
    name: deckName,
    colors: colorProfile.colors,
    splashColors: colorProfile.splash,
    entries,
    matchups: [],
    updatedAt: new Date().toISOString(),
  }

  return { deck, skipped }
}

// `entries` lets the caller pass a sorted copy — ordering lives in App.tsx next to
// the display logic, so exports and the on-screen lists stay in the same order.
export function serializeArenaDecklist(deck: Deck, entries: DeckEntry[] = deck.entries) {
  const main = entries.filter((entry) => entry.zone === 'main')
  const sideboard = entries.filter((entry) => entry.zone === 'sideboard')

  const lines = ['Deck', ...main.map(formatEntry)]

  if (sideboard.length > 0) {
    lines.push('', 'Sideboard', ...sideboard.map(formatEntry))
  }

  return lines.join('\n')
}

export type DeckColorProfile = {
  colors: MtgColor[]
  splash: MtgColor[]
}

// A color is a splash when its share of the deck's colored mana pips is small.
// Pip share (not card count) is the standard measure of color commitment — it's
// what actually drives a mana base. 4x {B}{B}{B} is a far heavier black
// commitment than 4x {2}{B}, and pip counting captures that; card counting doesn't.
const SPLASH_PIP_SHARE = 0.15
// A color carried by only a card or two is a splash even at a slightly higher
// share — catches the single-card splash (e.g. 4x Leyline Binding in a Jeskai deck).
const FEW_CARD_SPLASH_SHARE = 0.25
const FEW_CARD_THRESHOLD = 2
// Below this many total pips the sample is too small for shares to mean anything.
const MIN_PIPS_FOR_SPLASH = 10

export function inferDeckColorProfile(
  entries: DeckEntry[],
  cardIndex: Map<string, CardRecord>,
): DeckColorProfile {
  const pipsByColor = new Map<MtgColor, number>()
  const cardsByColor = new Map<MtgColor, Set<string>>()
  let totalPips = 0

  entries.forEach((entry) => {
    const card = entry.cardId ? cardIndex.get(entry.cardId) : cardIndex.get(normalizeCardName(entry.name))
    if (!card) return

    // Unlike type grouping and mana-value sorting (which use the front face),
    // color identity counts every face: a deck running a DFC with a black back
    // face still needs black mana to play it.
    getManaCostPips(card.manaCost ?? '').forEach((pips, color) => {
      const weighted = pips * entry.quantity
      pipsByColor.set(color, (pipsByColor.get(color) ?? 0) + weighted)
      totalPips += weighted

      const cards = cardsByColor.get(color) ?? new Set<string>()
      cards.add(card.name)
      cardsByColor.set(color, cards)
    })
  })

  const colors = COLOR_ORDER.filter((color) => (pipsByColor.get(color) ?? 0) > 0)

  if (colors.length <= 1 || totalPips < MIN_PIPS_FOR_SPLASH) {
    return { colors, splash: [] }
  }

  const splash = colors.filter((color) => {
    const share = (pipsByColor.get(color) ?? 0) / totalPips
    const distinctCards = cardsByColor.get(color)?.size ?? 0

    if (share < SPLASH_PIP_SHARE) return true
    return distinctCards <= FEW_CARD_THRESHOLD && share < FEW_CARD_SPLASH_SHARE
  })

  // Every color being a splash is meaningless — fall back to treating them all as main.
  return splash.length === colors.length ? { colors, splash: [] } : { colors, splash }
}

export function inferDeckColors(entries: DeckEntry[], cardIndex: Map<string, CardRecord>) {
  return inferDeckColorProfile(entries, cardIndex).colors
}

// Returns colored pips per single copy of a card. Hybrid symbols split their
// weight across the colors they offer, since either one can pay the cost.
function getManaCostPips(manaCost: string) {
  const pips = new Map<MtgColor, number>()

  Array.from(manaCost.matchAll(/\{([^}]+)\}/g), (match) => match[1].toUpperCase()).forEach((symbol) => {
    const symbolColors = COLOR_ORDER.filter((color) => symbol.includes(color))
    if (symbolColors.length === 0) return

    const weight = 1 / symbolColors.length
    symbolColors.forEach((color) => pips.set(color, (pips.get(color) ?? 0) + weight))
  })

  return pips
}

function formatEntry(entry: DeckEntry) {
  return `${entry.quantity} ${entry.name}`
}
