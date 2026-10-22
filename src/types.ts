export type MtgColor = 'W' | 'U' | 'B' | 'R' | 'G'

export type Zone = 'main' | 'sideboard'

export type PlanDirection = 'in' | 'out'

export type PlanSection = 'primary' | `situational:${string}`

export type CardImageUris = {
  small?: string
  normal?: string
  large?: string
  art_crop?: string
}

export type CardFace = {
  name: string
  manaCost?: string
  typeLine: string
  oracleText: string
  power?: string
  toughness?: string
  loyalty?: string
}

export type CardRecord = {
  id: string
  oracleId: string
  name: string
  normalizedName: string
  aliases?: string[]
  manaCost: string
  typeLine: string
  oracleText: string
  colors: MtgColor[]
  colorIdentity: MtgColor[]
  power?: string
  toughness?: string
  loyalty?: string
  faces?: CardFace[]
  imageUris: CardImageUris
  faceImageUris?: CardImageUris[]
  set: string
  collectorNumber: string
  rarity: string
  // Tokens are synced alongside real cards so they can be previewed, but they are
  // not deck-legal and must lose a name collision to the real card.
  isToken?: boolean
}

export type DeckEntry = {
  id: string
  cardId?: string
  name: string
  quantity: number
  zone: Zone
}

export type Matchup = {
  id: string
  name: string
  colors: MtgColor[]
  splashColors?: MtgColor[]
  notes: string
  plan: PlanEntry[]
  situationalSections?: SituationalSection[]
  situationalNotes?: string
  situationalPlan?: PlanEntry[]
  opponentEntries?: DeckEntry[]
  opponentVariantEntries?: DeckEntry[]
}

export type SituationalSection = {
  id: string
  notes: string
  plan: PlanEntry[]
}

export type PlanEntry = {
  id: string
  entryId: string
  cardId?: string
  name: string
  quantity: number
  direction: PlanDirection
}

export type MatchResult = 'win' | 'loss' | 'draw'

export type GameLog = {
  id: string
  result: MatchResult | ''
  // Undefined means "derive it from the previous game's result" rather than unknown,
  // so a value only gets stored once the player overrides the inferred one.
  start?: 'play' | 'draw'
  notes: string
}

export type MatchLog = {
  id: string
  opponent: string
  date: string
  games: GameLog[]
  // The MTGA matchID this was imported from, when it came out of the Replay tab.
  // Stable and unique, so it is what stops the same match being imported twice —
  // from either direction.
  replayMatchId?: string
}

export type Deck = {
  id: string
  name: string
  // Free-form, match-unspecific journal notes. Undefined means untouched, which is
  // what makes the prompt template show through until the player writes something.
  journalNotes?: string
  colors: MtgColor[]
  splashColors?: MtgColor[]
  entries: DeckEntry[]
  matchups: Matchup[]
  matchLogs?: MatchLog[]
  // Which archetype the opponent was playing in a given parsed MTGA match, keyed by
  // the log's matchID. Stores the matchup *name* rather than its id, matching how
  // the journal records an opponent: a matchup that is later renamed or deleted
  // leaves the record readable instead of dangling.
  replayOpponents?: Record<string, string>
  updatedAt: string
}

export type CardDatabase = {
  cards: CardRecord[]
  updatedAt?: string
  sourceUpdatedAt?: string
  exportedAt?: string
}
