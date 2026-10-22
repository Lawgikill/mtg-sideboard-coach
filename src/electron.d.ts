type MtgaGameEvent = {
  turn: number
  kind: string
  text: string
  seat?: number
  card?: string | null
  cards?: string[]
  // The zone a card came from, where the event is a zone transfer. Hand and library
  // are hidden, so leaving one is how a distinct copy becomes known.
  fromZone?: string
  // The card that caused this, when one is known. It is also appended to `cards` so
  // the attribution is hoverable, which is why anything reading `cards` for
  // ownership has to exclude it — a cause can belong to either player.
  source?: string | null
  // What each line folded into a merged one contributed. Merging sets `card` to null
  // and keeps a single `fromZone`, so without this the cards it named are lost to
  // anything reading the narration for ownership.
  origins?: Array<{ card?: string | null; seat?: number; fromZone?: string; kind?: string }>
}

type MtgaGame = {
  gameNumber: number
  maxTurn: number
  won: boolean | null
  onThePlay: boolean | null
  endReason: string | null
  truncated: boolean
  result: { winningTeamId: number; reason: string } | null
  events: MtgaGameEvent[]
  // What we boarded in and out before this game, read from our own deck submission.
  // Null for game one, and for any game whose submission the log did not carry.
  sideboarding: { in: Array<{ name: string; count: number }>; out: Array<{ name: string; count: number }> } | null
}

type MtgaMatch = {
  matchId: string | null
  source: string
  playedAt: string
  opponent: string
  seatNames: Record<number, string>
  localSeat: number | null
  deckId: string | null
  deckName: string | null
  deckScore: number
  matchWinCondition: string | null
  completedReason: string | null
  games: MtgaGame[]
}

interface Window {
  electronAPI?: {
    focusWindow: () => Promise<void>
    mtgaLoadGames: (decks: unknown) => Promise<MtgaMatch[]>
    mtgaArchiveNow: () => Promise<{ copied: Array<{ file: string; bytes: number }>; unchanged: string[]; failed: Array<{ file: string; reason: string }> }>
    mtgaListArchives: () => Promise<Array<{ filename: string; bytes: number; modifiedAt: string }>>
    mtgaPruneArchives: (days?: number) => Promise<number>
    ocrImage: (dataUrl: string) => Promise<Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>>
    openJournalWindow: (deckId: string) => Promise<void>
    notifyDecksChanged: () => void
    onDecksUpdated: (callback: () => void) => () => void
    reloadWindow: () => Promise<void>
    fetchUrl: (url: string) => Promise<string>
    fetchScryfallCards: (url: string) => Promise<string>
    saveDecksBackup: (json: string) => Promise<void>
    listBackups: () => Promise<Array<{ filename: string; modifiedAt: string }>>
    loadBackup: (filename: string) => Promise<string | null>
    clearOldBackups: (olderThanDays: number) => Promise<number>
  }
}
