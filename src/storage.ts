import type { CardDatabase, Deck } from './types'

const DECKS_KEY = 'mtg-sideboard-coach:decks'
const CARDS_KEY = 'mtg-sideboard-coach:standard-cards'

export function loadDecks(): Deck[] {
  return readJson<Deck[]>(DECKS_KEY, [])
}

export function saveDecks(decks: Deck[]) {
  const json = JSON.stringify(decks)
  localStorage.setItem(DECKS_KEY, json)
  window.electronAPI?.saveDecksBackup(json)
}

export function loadCardDatabase(): CardDatabase {
  return readJson<CardDatabase>(CARDS_KEY, { cards: [] })
}

export function saveCardDatabase(database: CardDatabase) {
  localStorage.setItem(CARDS_KEY, JSON.stringify(database))
}

function readJson<T>(key: string, fallback: T): T {
  const value = localStorage.getItem(key)
  if (!value) return fallback

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
