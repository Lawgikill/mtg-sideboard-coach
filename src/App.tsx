import {
  closestCenter,
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { restrictToWindowEdges } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowDownToLine,
  ArrowLeft,
  Archive,
  ArrowUpFromLine,
  BarChart2,
  BookOpen,
  Layers,
  ChevronDown,
  ChevronRight,
  Check,
  Clipboard,
  ClipboardPaste,
  Eraser,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Import,
  Plus,
  Sparkles,
  Printer,
  RotateCcw,
  Search,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react'
import 'mana-font/css/mana.css'
import './App.css'
import { createId, inferDeckColorProfile, normalizeCardName, parseArenaDecklist, serializeArenaDecklist } from './arena'
import { buildJournalText, inferGameStart, JOURNAL_NOTES_PROMPTS, summarizeJournal, UNSPECIFIED_OPPONENT } from './journalExport'
import { buildReplaySummaries, buildReplayText, gameNotesFromReplay, describeEndReason, describeStart, formatMatchFormat, matchRecord, opponentLabel, replayFileName, summaryCardLabel } from './replayExport'
import type { ReplayDecklist, ReplaySummary } from './replayExport'
import { buildReplayHtml } from './replayHtml'
import { buildZip, uniqueNames } from './zip'
import { guessArchetype, observedOpponentCards } from './archetypeGuess'
import { linesFromWords } from './ocrLayout'
import { buildOcrCandidates, parseOcrLines, type OcrMatch } from './ocrParse'
import { createCardIndexes, fetchStandardCards, type SyncProgress } from './scryfall'
import { loadCardDatabase, loadDecks, saveCardDatabase, saveDecks } from './storage'
import type { CardDatabase, CardRecord, Deck, DeckEntry, GameLog, MatchLog, MatchResult, Matchup, MtgColor, PlanDirection, PlanEntry, PlanSection, SituationalSection, Zone } from './types'

const COLORS: Array<{ id: MtgColor; label: string }> = [
  { id: 'W', label: 'W' },
  { id: 'U', label: 'U' },
  { id: 'B', label: 'B' },
  { id: 'R', label: 'R' },
  { id: 'G', label: 'G' },
]

type PreviewPlacement = 'left' | 'right'

type CopiedPlan = {
  sourceName: string
  notes: string
  plan: PlanEntry[]
  situationalSections: SituationalSection[]
}

const SAMPLE_DECK = ''

// Electron's native confirm()/alert() can leave the renderer without keyboard
// focus after they close: the window looks focused and the mouse still works,
// but nothing typed reaches the page until a focus change (opening DevTools,
// alt-tabbing) jolts it loose. Every native dialog goes through these wrappers
// so the main process can hand focus back to the web contents.
// The dialog finishes tearing down *after* confirm() returns, so refocusing
// immediately gets undone by that teardown. Re-assert it on later ticks too.
function restoreWindowFocus() {
  window.electronAPI?.focusWindow()
  setTimeout(() => window.electronAPI?.focusWindow(), 50)
  setTimeout(() => window.electronAPI?.focusWindow(), 250)
}

function confirmAction(message: string) {
  const accepted = confirm(message)
  restoreWindowFocus()
  return accepted
}

function alertMessage(message: string) {
  alert(message)
  restoreWindowFocus()
}

// A popped-out Journal window loads the same index.html with `#journal=<deckId>`,
// since Electron denies window.open() and routes it to the OS shell instead.
function getJournalDeckId() {
  const match = /(?:^|[#&])journal=([^&]+)/.exec(window.location.hash)
  return match ? decodeURIComponent(match[1]) : null
}

function App() {
  const journalDeckId = getJournalDeckId()
  return journalDeckId ? <JournalWindow deckId={journalDeckId} /> : <MainApp />
}

function JournalWindow({ deckId }: { deckId: string }) {
  const [decks, setDecks] = useState<Deck[]>(() => loadDecks())
  // Skips the save on mount, and again whenever state came from another window —
  // without it this window would immediately write back what it just read.
  const skipNextSave = useRef(true)

  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    saveDecks(decks)
    window.electronAPI?.notifyDecksChanged()
  }, [decks])

  useEffect(() => window.electronAPI?.onDecksUpdated(() => {
    skipNextSave.current = true
    setDecks(loadDecks())
  }), [])

  const deck = decks.find((item) => item.id === deckId) ?? null

  // This window has no workspace around it, so it reads the card database itself.
  // Parsed once: the import's note pre-fill needs to know a token from a land.
  const cardByName = useMemo(() => createCardIndexes(loadCardDatabase().cards).byName, [])

  function updateDeck(updater: (deck: Deck) => Deck) {
    setDecks((current) => current.map((item) => (item.id === deckId ? updater(item) : item)))
  }

  return (
    <main className="app-shell">
      <section className="library-layout journal-window">
        {deck ? (
          <>
            <header className="topbar">
              <div>
                <p className="eyebrow">Match Journal</p>
                <h1>{deck.name}</h1>
              </div>
            </header>
            <JournalView deck={deck} cardByName={cardByName} onUpdateDeck={updateDeck} standalone />
          </>
        ) : (
          <p className="journal-empty">This deck is no longer available.</p>
        )}
      </section>
    </main>
  )
}

function MainApp() {
  const [cardDatabase, setCardDatabase] = useState<CardDatabase>(() => loadCardDatabase())
  const [decks, setDecks] = useState<Deck[]>(() => syncGlobalMatchups(normalizeDeckColors(loadDecks(), cardDatabase.cards)))
  const [selectedDeckId, setSelectedDeckId] = useState<string | null>(null)
  const [deckSearch, setDeckSearch] = useState('')
  const [deckColors, setDeckColors] = useState<MtgColor[]>([])
  const [deckColorsExact, setDeckColorsExact] = useState(false)
  const [matchupSearch, setMatchupSearch] = useState('')
  const [matchupColors, setMatchupColors] = useState<MtgColor[]>([])
  const [matchupColorsExact, setMatchupColorsExact] = useState(false)
  const [selectedMatchupId, setSelectedMatchupId] = useState<string | null>(null)
  const [copiedPlan, setCopiedPlan] = useState<CopiedPlan | null>(null)
  const [importText, setImportText] = useState(SAMPLE_DECK)
  const [importSkipped, setImportSkipped] = useState<ReturnType<typeof parseArenaDecklist>['skipped']>([])
  const [importComplete, setImportComplete] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [reimportMode, setReimportMode] = useState(false)
  const [showBackups, setShowBackups] = useState(false)
  const [backupList, setBackupList] = useState<Array<{ filename: string; modifiedAt: string }>>([])
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'error'>('idle')
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [syncError, setSyncError] = useState('')
  // See JournalWindow: suppresses the mount save and echoes from other windows.
  const skipNextSave = useRef(true)

  const indexes = useMemo(() => createCardIndexes(cardDatabase.cards), [cardDatabase.cards])
  const selectedDeck = decks.find((deck) => deck.id === selectedDeckId) ?? null
  const selectedMatchup = selectedDeck?.matchups.find((matchup) => matchup.id === selectedMatchupId) ?? null

  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    saveDecks(decks)
    window.electronAPI?.notifyDecksChanged()
  }, [decks])

  useEffect(() => window.electronAPI?.onDecksUpdated(() => {
    skipNextSave.current = true
    setDecks(loadDecks())
  }), [])

  useEffect(() => {
    saveCardDatabase(cardDatabase)
  }, [cardDatabase])

  const filteredDecks = useMemo(() => {
    return decks
      .filter((deck) => deck.name.toLowerCase().includes(deckSearch.toLowerCase()))
      .filter((deck) => matchesColorFilter(deck.colors, deckColors, deckColorsExact))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [deckColors, deckColorsExact, deckSearch, decks])

  function updateDeck(deckId: string, updater: (deck: Deck) => Deck) {
    setDecks((current) => current.map((deck) => (deck.id === deckId ? updater(deck) : deck)))
  }

  function addGlobalMatchup(matchup: Matchup) {
    setDecks((current) =>
      syncGlobalMatchups(current.map((deck) => ({
        ...deck,
        matchups: deck.matchups.some((item) => item.id === matchup.id)
          ? deck.matchups
          : [...deck.matchups, createBlankMatchupFromDefinition(matchup)],
        updatedAt: new Date().toISOString(),
      }))),
    )
  }

  function updateGlobalMatchup(matchupId: string, updater: (matchup: Matchup) => Matchup) {
    setDecks((current) =>
      syncGlobalMatchups(current.map((deck) => ({
        ...deck,
        matchups: deck.matchups.map((matchup) => {
          if (matchup.id !== matchupId) return matchup
          const updated = updater(matchup)
          return {
            ...matchup,
            name: updated.name,
            colors: updated.colors,
            splashColors: updated.splashColors,
            opponentEntries: updated.opponentEntries,
            opponentVariantEntries: updated.opponentVariantEntries,
          }
        }),
        updatedAt: new Date().toISOString(),
      }))),
    )
  }

  function deleteGlobalMatchup(matchupId: string) {
    setDecks((current) =>
      current.map((deck) => ({
        ...deck,
        matchups: deck.matchups.filter((matchup) => matchup.id !== matchupId),
        updatedAt: new Date().toISOString(),
      })),
    )
  }

  function deleteAllGlobalMatchups() {
    setDecks((current) =>
      current.map((deck) => ({ ...deck, matchups: [], updatedAt: new Date().toISOString() })),
    )
  }

  function importDeck() {
    if (reimportMode && selectedDeck) {
      const { deck, skipped } = parseArenaDecklist(importText, indexes.byName, selectedDeck.name)
      setImportSkipped(skipped)
      setImportComplete(false)

      if (deck.entries.length === 0) return

      updateDeck(selectedDeck.id, (current) => {
        const updated = { ...current, entries: deck.entries, colors: deck.colors, updatedAt: new Date().toISOString() }
        return { ...updated, matchups: updated.matchups.map((m) => normalizeMatchupPlans(updated, m)) }
      })

      if (skipped.length === 0) {
        setShowImport(false)
      } else {
        setImportComplete(true)
      }
      return
    }

    const { deck, skipped } = parseArenaDecklist(importText, indexes.byName, `Deck ${decks.length + 1}`)
    setImportSkipped(skipped)
    setImportComplete(false)

    if (deck.entries.length === 0) {
      return
    }

    setDecks((current) => syncGlobalMatchups([deck, ...current]))
    setSelectedDeckId(deck.id)
    setSelectedMatchupId(null)
    if (skipped.length === 0) {
      setShowImport(false)
    } else {
      setImportComplete(true)
    }
  }

  function openImportModal() {
    setReimportMode(false)
    setImportSkipped([])
    setImportComplete(false)
    setShowImport(true)
  }

  function openReimportModal() {
    setReimportMode(true)
    setImportText('')
    setImportSkipped([])
    setImportComplete(false)
    setShowImport(true)
  }

  function closeImportModal() {
    setShowImport(false)
    setImportComplete(false)
  }

  async function syncCards() {
    setSyncState('syncing')
    setSyncError('')
    setSyncProgress({ stage: 'metadata', label: 'Starting Scryfall sync', percent: 0 })

    try {
      const nextDatabase = await fetchStandardCards(setSyncProgress)
      setSyncProgress({ stage: 'saving', label: 'Saving card database locally', percent: 99 })
      setCardDatabase(nextDatabase)
      setDecks((current) => {
        const cardIndex = createCardIndexes(nextDatabase.cards).byName
        return current.map((deck) => {
          const profile = inferDeckColorProfile(deck.entries, cardIndex)
          return { ...deck, colors: profile.colors, splashColors: profile.splash }
        })
      })
      setSyncProgress({ stage: 'complete', label: `Synced ${nextDatabase.cards.length.toLocaleString()} Standard cards`, percent: 100 })
      setSyncState('idle')
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Scryfall sync failed.')
      setSyncState('error')
      setSyncProgress(null)
    }
  }

  function exportStandardJson() {
    downloadFile(
      'standard-cards-scryfall.json',
      JSON.stringify({ ...cardDatabase, exportedAt: new Date().toISOString() }, null, 2),
      'application/json',
    )
  }

  function exportCompactJson() {
    const referencedIds = new Set<string>()
    const referencedNames = new Set<string>()

    decks.forEach((deck) => {
      deck.entries.forEach((entry) => {
        if (entry.cardId) referencedIds.add(entry.cardId)
        referencedNames.add(normalizeCardName(entry.name))
      })
      deck.matchups.forEach((matchup) => {
        matchup.opponentEntries?.forEach((entry) => {
          if (entry.cardId) referencedIds.add(entry.cardId)
          referencedNames.add(normalizeCardName(entry.name))
        })
      })
    })

    const compactCards = cardDatabase.cards.filter(
      (card) => referencedIds.has(card.id) || referencedNames.has(card.normalizedName),
    )

    downloadFile(
      'compact-cards.json',
      JSON.stringify({ ...cardDatabase, cards: compactCards, exportedAt: new Date().toISOString() }, null, 2),
      'application/json',
    )
  }

  async function openBackupsModal() {
    const list = await window.electronAPI?.listBackups() ?? []
    setBackupList(list)
    setShowBackups(true)
  }

  async function restoreBackup(filename: string) {
    if (!confirmAction('Restore this backup? Your current decks and plans will be replaced.')) return
    const json = await window.electronAPI?.loadBackup(filename)
    if (!json) return
    try {
      const restored = JSON.parse(json) as Deck[]
      const prepared = syncGlobalMatchups(normalizeDeckColors(restored, cardDatabase.cards))

      if (window.electronAPI?.reloadWindow) {
        // Write straight to storage and rebuild the page. The reload picks up the
        // restored decks on its own and — unlike a React state update — reliably
        // clears the keyboard focus the native confirm() dialog strands.
        saveDecks(prepared)
        window.electronAPI.reloadWindow()
        return
      }

      setDecks(prepared)
      // The restore swaps out every deck, so any selection from the previous data
      // set is stale — a leftover matchup id makes the plan panel auto-open a
      // matchup whose row then toggles *off* on the first click.
      setSelectedDeckId(null)
      setSelectedMatchupId(null)
      setShowBackups(false)
    } catch {
      alertMessage(`Backup "${filename}" could not be read — the file may be corrupted.`)
    }
  }

  async function clearOldBackups() {
    if (!confirmAction('Delete all backup files older than 7 days?')) return
    await window.electronAPI?.clearOldBackups(7)
    const list = await window.electronAPI?.listBackups() ?? []
    setBackupList(list)
  }

  return (
    <main className="app-shell">
      {!selectedDeck ? (
        <DeckLibrary
          cardById={indexes.byId}
          cardByName={indexes.byName}
          cardsCount={cardDatabase.cards.length}
          deckColors={deckColors}
          deckColorsExact={deckColorsExact}
          deckSearch={deckSearch}
          decks={filteredDecks}
          onColorToggle={(color) => setDeckColors(toggleColor(deckColors, color))}
          onExactToggle={() => setDeckColorsExact((current) => !current)}
          onCreateDeck={openImportModal}
          onDeckSearch={setDeckSearch}
          onDeleteDeck={(id) => setDecks((current) => current.filter((deck) => deck.id !== id))}
          onDeleteAllDecks={() => {
            if (confirmAction('Delete ALL decks? This cannot be undone.')) setDecks([])
          }}
          onExportCards={exportStandardJson}
          onImportDeck={openImportModal}
          onOpenBackups={window.electronAPI ? openBackupsModal : undefined}
          onSelectDeck={setSelectedDeckId}
          onSyncCards={syncCards}
          sourceUpdatedAt={cardDatabase.sourceUpdatedAt}
          syncError={syncError}
          syncProgress={syncProgress}
          syncState={syncState}
        />
      ) : (
        <DeckWorkspace
          allDecks={decks}
          cardById={indexes.byId}
          cardByName={indexes.byName}
          deck={selectedDeck}
          matchupColorsExact={matchupColorsExact}
          matchupColors={matchupColors}
          matchupSearch={matchupSearch}
          onBack={() => setSelectedDeckId(null)}
          onExportCompactCards={exportCompactJson}
          onReimportDeck={openReimportModal}
          onDeleteDeck={() => {
            setDecks((current) => current.filter((deck) => deck.id !== selectedDeck.id))
            setSelectedDeckId(null)
          }}
          onExportDeck={() => downloadFile(
            `${selectedDeck.name}.txt`,
            serializeArenaDecklist(selectedDeck, sortEntriesForExport(selectedDeck.entries, indexes.byId, indexes.byName)),
            'text/plain',
          )}
          onCopyDeck={() => navigator.clipboard.writeText(
            serializeArenaDecklist(selectedDeck, sortEntriesForExport(selectedDeck.entries, indexes.byId, indexes.byName)),
          )}
          onMatchupColorToggle={(color) => setMatchupColors(toggleColor(matchupColors, color))}
          onMatchupExactToggle={() => setMatchupColorsExact((current) => !current)}
          onMatchupSearch={setMatchupSearch}
          onAddMatchup={addGlobalMatchup}
          onSelectMatchup={(id) => setSelectedMatchupId((current) => (current === id ? null : id))}
          onUpdateDeck={(updater) => updateDeck(selectedDeck.id, updater)}
          onUpdateMatchupDefinition={(matchupId, updater) => updateGlobalMatchup(matchupId, updater)}
          onDeleteMatchup={(matchupId) => {
            deleteGlobalMatchup(matchupId)
            setSelectedMatchupId((current) => (current === matchupId ? null : current))
          }}
          onDeleteAllMatchups={() => {
            deleteAllGlobalMatchups()
            setSelectedMatchupId(null)
          }}
          copiedPlan={copiedPlan}
          onCopyPlan={setCopiedPlan}
          selectedMatchup={selectedMatchup}
        />
      )}

      {showBackups ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowBackups(false)}>
          <section className="modal backup-modal" role="dialog" aria-modal="true" aria-label="Backups" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <h2>Backups</h2>
              <button className="icon-button" type="button" onClick={() => setShowBackups(false)} title="Close">
                <Trash2 size={18} />
              </button>
            </header>
            {backupList.length === 0 ? (
              <p className="backup-empty">No backups yet. The app saves a backup automatically every hour when changes have been made.</p>
            ) : (
              <ul className="backup-list">
                {backupList.map((backup) => (
                  <li key={backup.filename} className="backup-item">
                    <span className="backup-date">{formatBackupDate(backup.modifiedAt)}</span>
                    <span className="backup-age">{formatRelativeTime(backup.modifiedAt)}</span>
                    <button className="secondary-button" type="button" onClick={() => restoreBackup(backup.filename)}>
                      <RotateCcw size={15} />
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={clearOldBackups} disabled={backupList.length === 0}>
                Clear older than 7 days
              </button>
              <button className="primary-button" type="button" onClick={() => setShowBackups(false)}>
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showImport ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeImportModal}>
          <section className="modal" role="dialog" aria-modal="true" aria-label="Import deck" onMouseDown={(event) => event.stopPropagation()}>
            <header className="modal-header">
              <h2>{reimportMode ? 'Re-import Deck' : 'Import Deck'}</h2>
              <button className="icon-button" type="button" onClick={closeImportModal} title="Close">
                <Trash2 size={18} />
              </button>
            </header>
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Paste Arena decklist…" spellCheck={false} />
            {importSkipped.length > 0 ? (
              <section className="import-skipped">
                <strong>{importSkipped.length} skipped</strong>
                <ul>
                  {importSkipped.slice(0, 8).map((item) => (
                    <li key={`${item.line}-${item.name}`}>
                      {item.quantity} {item.name}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setImportText('')
                  setImportSkipped([])
                  setImportComplete(false)
                }}
              >
                Clear
              </button>
              {importComplete ? (
                <button className="primary-button" type="button" onClick={closeImportModal}>
                  OK
                </button>
              ) : (
                <button className="primary-button" type="button" onClick={importDeck}>
                  <Import size={17} />
                  {reimportMode ? 'Re-import' : 'Import'}
                </button>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}

type DeckLibraryProps = {
  cardById: Map<string, CardRecord>
  cardByName: Map<string, CardRecord>
  cardsCount: number
  deckColors: MtgColor[]
  deckColorsExact: boolean
  deckSearch: string
  decks: Deck[]
  onColorToggle: (color: MtgColor) => void
  onExactToggle: () => void
  onCreateDeck: () => void
  onDeckSearch: (value: string) => void
  onDeleteDeck: (id: string) => void
  onDeleteAllDecks: () => void
  onExportCards: () => void
  onImportDeck: () => void
  onOpenBackups?: () => void
  onSelectDeck: (id: string) => void
  onSyncCards: () => void
  sourceUpdatedAt?: string
  syncError: string
  syncProgress: SyncProgress | null
  syncState: 'idle' | 'syncing' | 'error'
}

function DeckLibrary(props: DeckLibraryProps) {
  return (
    <section className="library-layout">
      <header className="topbar">
        <div>
          <h1 className="app-title">MTG Sideboard Coach</h1>
        </div>
        <div className="toolbar">
          <button className="secondary-button" type="button" onClick={props.onSyncCards} disabled={props.syncState === 'syncing'}>
            <UploadCloud size={17} />
            {props.syncState === 'syncing' ? 'Syncing' : 'Sync Standard'}
          </button>
          <button className="secondary-button" type="button" onClick={props.onExportCards} disabled={props.cardsCount === 0}>
            <Download size={17} />
            Cards JSON
          </button>
          {props.onOpenBackups ? (
            <button className="secondary-button" type="button" onClick={props.onOpenBackups}>
              <RotateCcw size={17} />
              Backups
            </button>
          ) : null}
          <button className="primary-button" type="button" onClick={props.onImportDeck}>
            <Import size={17} />
            Import Deck
          </button>
        </div>
      </header>

      <section className="status-row">
        <span>{props.cardsCount.toLocaleString()} Standard cards</span>
        <span>{props.sourceUpdatedAt ? `Scryfall ${formatDate(props.sourceUpdatedAt)}` : 'No Scryfall sync yet'}</span>
        {props.syncError ? <span className="error-text">{props.syncError}</span> : null}
      </section>

      {props.syncProgress ? <SyncProgressBar progress={props.syncProgress} state={props.syncState} /> : null}

      <div className="section-title-row">
        <h2 className="section-title">Decks</h2>
        {props.decks.length > 0 ? (
          <button className="icon-button tiny" type="button" title="Delete all decks" onClick={props.onDeleteAllDecks}>
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>

      <section className="filter-bar">
        <label className="search-field">
          <Search size={17} />
          <input value={props.deckSearch} onChange={(event) => props.onDeckSearch(event.target.value)} placeholder="Search decks" />
        </label>
        <ColorFilter exact={props.deckColorsExact} selected={props.deckColors} onExactToggle={props.onExactToggle} onToggle={props.onColorToggle} />
      </section>

      <section className="deck-grid">
        {props.decks.map((deck) => {
          const coverImage = getDeckCoverImage(deck, props.cardById, props.cardByName)

          return (
            <div className="deck-card" key={deck.id}>
              <button className="deck-card-body" type="button" onClick={() => props.onSelectDeck(deck.id)}>
                {coverImage ? (
                  <span className="deck-card-art" aria-hidden="true">
                    <img src={coverImage} alt="" loading="lazy" />
                  </span>
                ) : null}
                <span className="deck-card-content">
                  <span className="deck-title">{deck.name}</span>
                  <ManaPips colors={deck.colors} splash={deck.splashColors} />
                </span>
              </button>
              <button
                className="icon-button tiny deck-delete-btn"
                type="button"
                title="Delete deck"
                onClick={() => {
                  if (confirmAction(`Delete "${deck.name}"?`)) props.onDeleteDeck(deck.id)
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          )
        })}
        <button className="deck-card add-card" type="button" onClick={props.onCreateDeck}>
          <Plus size={22} />
          New Deck
        </button>
      </section>
    </section>
  )
}

function SyncProgressBar({ progress, state }: { progress: SyncProgress; state: 'idle' | 'syncing' | 'error' }) {
  const percent = progress.percent
  const isIndeterminate = state === 'syncing' && percent === undefined

  return (
    <section className="sync-progress" aria-live="polite">
      <div className="sync-progress-header">
        <span>{progress.label}</span>
        <span>{percent !== undefined ? `${Math.round(percent)}%` : formatBytesProgress(progress.receivedBytes, progress.totalBytes)}</span>
      </div>
      <div className={`progress-track ${isIndeterminate ? 'indeterminate' : ''}`}>
        <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, percent ?? 35))}%` }} />
      </div>
      {progress.receivedBytes ? (
        <p className="sync-detail">
          {formatBytes(progress.receivedBytes)}
          {progress.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : ''}
        </p>
      ) : null}
    </section>
  )
}

type DeckWorkspaceProps = {
  allDecks: Deck[]
  cardById: Map<string, CardRecord>
  cardByName: Map<string, CardRecord>
  deck: Deck
  matchupColors: MtgColor[]
  matchupColorsExact: boolean
  matchupSearch: string
  onBack: () => void
  onDeleteDeck: () => void
  onExportCompactCards: () => void
  onExportDeck: () => void
  onCopyDeck: () => void
  onReimportDeck: () => void
  onMatchupColorToggle: (color: MtgColor) => void
  onMatchupExactToggle: () => void
  onMatchupSearch: (value: string) => void
  onAddMatchup: (matchup: Matchup) => void
  onSelectMatchup: (id: string) => void
  onDeleteMatchup: (id: string) => void
  onDeleteAllMatchups: () => void
  onUpdateDeck: (updater: (deck: Deck) => Deck) => void
  onUpdateMatchupDefinition: (matchupId: string, updater: (matchup: Matchup) => Matchup) => void
  copiedPlan: CopiedPlan | null
  onCopyPlan: (plan: CopiedPlan) => void
  selectedMatchup: Matchup | null
}

function DeckWorkspace(props: DeckWorkspaceProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [arenaCopied, markArenaCopied] = useCopyFeedback()
  const [activeTab, setActiveTab] = useState<'plans' | 'journal' | 'replay'>('plans')
  const [activeDragEntryId, setActiveDragEntryId] = useState<string | null>(null)
  const [showStats, setShowStats] = useState(false)
  const activeDragEntry = props.deck.entries.find((e) => e.id === activeDragEntryId) ?? null
  const main = props.deck.entries.filter((entry) => entry.zone === 'main')
  const sideboard = props.deck.entries.filter((entry) => entry.zone === 'sideboard')
  const sideboardTotal = sideboard.reduce((total, entry) => total + entry.quantity, 0)
  const deckCopyViolations = findCopyLimitViolations(props.deck.entries, props.cardById, props.cardByName)
  const deckFlaggedNames = new Set(deckCopyViolations.map((item) => item.name))
  const [opponentFilterCards, setOpponentFilterCards] = useState<CardRecord[]>([])
  const matchups = props.deck.matchups
    .filter((matchup) => matchup.name.toLowerCase().includes(props.matchupSearch.toLowerCase()))
    .filter((matchup) => matchesColorFilter(matchup.colors, props.matchupColors, props.matchupColorsExact))
    .filter((matchup) => opponentFilterCards.every((fc) =>
      matchup.opponentEntries?.some((e) => e.cardId === fc.id || e.name === fc.name) ?? false,
    ))
    .sort((a, b) => a.name.localeCompare(b.name))

  function addMatchup() {
    const matchup: Matchup = {
      id: createId('matchup'),
      name: `Matchup ${props.deck.matchups.length + 1}`,
      colors: [],
      notes: '',
      plan: [],
    }

    props.onAddMatchup(matchup)
    props.onSelectMatchup(matchup.id)
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current
    if (data?.kind === 'deck-entry') {
      setActiveDragEntryId(data.entryId as string)
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragEntryId(null)
    const { active, over } = event
    if (!over) return

    const activeData = active.data.current
    if (activeData?.kind !== 'deck-entry') return

    const entryId = activeData.entryId as string
    const overId = String(over.id)

    const planTarget = parsePlanDropTarget(overId)
    if (planTarget) {
      addPlanEntry(entryId, planTarget.section, planTarget.direction)
    }
  }

  function addCardToZone(zone: 'main' | 'sideboard', card: CardRecord) {
    props.onUpdateDeck((deck) => {
      const existing = deck.entries.find((e) => e.zone === zone && e.cardId === card.id)
      const entries = existing
        ? deck.entries.map((e) => (e.id === existing.id ? { ...e, quantity: e.quantity + 1 } : e))
        : [...deck.entries, { id: createId('entry'), cardId: card.id, name: card.name, quantity: 1, zone }]
      const profile = inferDeckColorProfile(entries, props.cardById)
      return { ...deck, entries, colors: profile.colors, splashColors: profile.splash, updatedAt: new Date().toISOString() }
    })
  }

  function changeEntryQuantity(entryId: string, delta: number) {
    props.onUpdateDeck((deck) => {
      const entry = deck.entries.find((e) => e.id === entryId)
      if (!entry) return deck
      const newQty = entry.quantity + delta
      const entries = newQty <= 0
        ? deck.entries.filter((e) => e.id !== entryId)
        : deck.entries.map((e) => (e.id === entryId ? { ...e, quantity: newQty } : e))
      const profile = inferDeckColorProfile(entries, props.cardById)
      const updated = { ...deck, entries, colors: profile.colors, splashColors: profile.splash, updatedAt: new Date().toISOString() }
      return { ...updated, matchups: updated.matchups.map((m) => normalizeMatchupPlans(updated, m)) }
    })
  }

  function handleCardClick(entry: DeckEntry) {
    addPlanEntry(entry.id, 'primary', entry.zone === 'sideboard' ? 'in' : 'out')
  }

  function addPlanEntry(entryId: string, section: PlanSection, direction: PlanDirection) {
    if (!props.selectedMatchup) return
    const deckEntry = props.deck.entries.find((entry) => entry.id === entryId)
    if (!deckEntry) return
    const sourceEntry = resolvePlanSourceEntry(props.deck, deckEntry, direction)
    if (!sourceEntry) return

    props.onUpdateDeck((deck) => ({
      ...deck,
      matchups: deck.matchups.map((matchup) => {
        if (matchup.id !== props.selectedMatchup?.id) return matchup
        const currentPlan = getMatchupPlan(matchup, section)
        const normalizedPlan = normalizePlanEntries(deck, currentPlan)
        const availableQuantity = getEntryPoolQuantity(deck, sourceEntry, direction)
        const existing = normalizedPlan.find((entry) => entry.entryId === sourceEntry.id && entry.direction === direction)
        const plan = existing
          ? normalizedPlan.map((entry) => (entry.id === existing.id ? { ...entry, quantity: Math.min(entry.quantity + 1, availableQuantity) } : entry))
          : [
              ...normalizedPlan,
              {
                id: createId('plan'),
                entryId: sourceEntry.id,
                cardId: sourceEntry.cardId,
                name: sourceEntry.name,
                quantity: 1,
                direction,
              },
            ]

        return setMatchupPlan(matchup, section, plan)
      }),
      updatedAt: new Date().toISOString(),
    }))
  }

  function printSideboardGuide() {
    const COLOR_ICON: Record<string, string> = {
      W: '<i class="ms ms-w ms-cost" style="font-size:0.9em"></i>',
      U: '<i class="ms ms-u ms-cost" style="font-size:0.9em"></i>',
      B: '<i class="ms ms-b ms-cost" style="font-size:0.9em"></i>',
      R: '<i class="ms ms-r ms-cost" style="font-size:0.9em"></i>',
      G: '<i class="ms ms-g ms-cost" style="font-size:0.9em"></i>',
    }

    const planned = [...props.deck.matchups]
      .filter((m) => m.plan.length > 0 || getSituationalSections(m).some((s) => s.plan.length > 0))
      .sort((a, b) => a.name.localeCompare(b.name))

    if (planned.length === 0) {
      alertMessage('No matchups have sideboard plans yet.')
      return
    }

    // Scale font up when fewer matchups, floor at 7.5pt, cap at 12pt
    const fontSize = Math.max(7.5, Math.min(12, 7.5 * 18 / planned.length))
    const fs = (scale: number) => `${(fontSize * scale).toFixed(1)}pt`

    function planCols(plan: PlanEntry[]) {
      const ins = plan.filter((e) => e.direction === 'in')
      const outs = plan.filter((e) => e.direction === 'out')
      const inLines = ins.map((e) => `<div class="sg-cl"><b>${e.quantity}</b> ${e.name}</div>`).join('')
      const outLines = outs.map((e) => `<div class="sg-cl"><b>${e.quantity}</b> ${e.name}</div>`).join('')
      return `<div class="sg-pc"><div><div class="sg-ph">IN</div>${inLines || '<div class="sg-em">—</div>'}</div><div><div class="sg-ph">OUT</div>${outLines || '<div class="sg-em">—</div>'}</div></div>`
    }

    const blocks = planned.map((m) => {
      const colorHtml = m.colors.length
        ? ` <span class="sg-colors">${m.colors.map((c) => COLOR_ICON[c] ?? c).join('')}</span>`
        : ''
      const notesHtml = m.notes.trim() ? `<div class="sg-notes">${m.notes.trim()}</div>` : ''
      const sitHtml = getSituationalSections(m)
        .filter((s) => s.plan.length > 0)
        .map((s) => `<div class="sg-sit">${s.notes.trim() ? `<div class="sg-sl">${s.notes.trim()}</div>` : ''}${planCols(s.plan)}</div>`)
        .join('')
      return `<div class="sg-mu"><div class="sg-mn">${m.name}${colorHtml}</div>${notesHtml}${planCols(m.plan)}${sitHtml}</div>`
    }).join('')

    const existingChildren = Array.from(document.body.children) as HTMLElement[]
    existingChildren.forEach((el) => el.style.setProperty('display', 'none', 'important'))

    const container = document.createElement('div')
    container.style.cssText = `font: ${fs(1)}/1.3 Arial,sans-serif; color: #000; padding: 6px; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact`
    container.innerHTML = `
      <style>
        .sg-h1{font-size:${fs(1.33)};font-weight:700;margin-bottom:1px}
        .sg-sub{font-size:${fs(0.87)};color:#555;margin-bottom:5px}
        .sg-guide{columns:3;column-gap:6px}
        .sg-mu{break-inside:avoid;border:1px solid #bbb;padding:4px 5px;margin-bottom:4px;display:inline-block;width:100%}
        .sg-mn{font-weight:700;font-size:${fs(1.07)};border-bottom:1px solid #ddd;margin-bottom:3px;padding-bottom:1px;display:flex;align-items:center;gap:3px}
        .sg-colors{display:inline-flex;gap:2px;flex-shrink:0}
        .sg-notes{font-size:${fs(0.87)};color:#555;font-style:italic;margin-bottom:2px;white-space:pre-wrap}
        .sg-pc{display:grid;grid-template-columns:1fr 1fr;gap:3px}
        .sg-pc>div{min-width:0;overflow:hidden}
        .sg-ph{font-size:${fs(0.8)};font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.05em;margin-bottom:1px}
        .sg-cl{display:block;font-size:${fs(1)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
        .sg-em{font-size:${fs(0.87)};color:#bbb}
        .sg-sit{border-top:1px dashed #ccc;margin-top:3px;padding-top:3px}
        .sg-sl{font-size:${fs(0.87)};color:#555;font-style:italic;margin-bottom:2px}
        @page{margin:.45in}
      </style>
      <div class="sg-h1">${props.deck.name} — Sideboard Guide</div>
      <div class="sg-sub">Printed ${new Date().toLocaleDateString()} · ${planned.length} matchup${planned.length !== 1 ? 's' : ''}</div>
      <div class="sg-guide">${blocks}</div>`

    document.body.appendChild(container)

    const originalTitle = document.title
    document.title = `${props.deck.name} Sideboard Guide`

    function cleanup() {
      existingChildren.forEach((el) => el.style.removeProperty('display'))
      document.body.removeChild(container)
      document.title = originalTitle
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.print()
        cleanup()
      })
    })
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <DragOverlay modifiers={[restrictToWindowEdges]}>
        {activeDragEntry ? (
          <CardOverlay entry={activeDragEntry} card={findCardForEntry(activeDragEntry, props.cardById, props.cardByName)} />
        ) : null}
      </DragOverlay>
      <section className="workspace-layout">
        <header className="topbar workspace-topbar">
          <div className="title-line">
            <button className="icon-button" type="button" onClick={props.onBack} title="Back to decks">
              <ArrowLeft size={20} />
            </button>
            <div className="deck-name-wrapper">
              <p className="eyebrow">Deck</p>
              <input
                className="deck-name-input"
                value={props.deck.name}
                onChange={(event) => props.onUpdateDeck((deck) => ({ ...deck, name: event.target.value, updatedAt: new Date().toISOString() }))}
                spellCheck={false}
              />
            </div>
            <ManaPips colors={props.deck.colors} splash={props.deck.splashColors} />
          </div>
          <div className="toolbar">
            <button className="secondary-button" type="button" onClick={() => setShowStats(true)}>
              <BarChart2 size={17} />
              Stats
            </button>
            <button className="secondary-button" type="button" onClick={printSideboardGuide}>
              <Printer size={17} />
              Print Guide
            </button>
            <button className="secondary-button" type="button" onClick={props.onExportCompactCards}>
              <Download size={17} />
              Filtered JSON
            </button>
            <button className="secondary-button" type="button" onClick={props.onReimportDeck}>
              <Import size={17} />
              Re-import
            </button>
            {/* Pasting into Arena's importer is what this list is actually for, so the
                labelled action copies; the file download stays as a secondary icon. */}
            <button
              className="secondary-button"
              type="button"
              title="Copy the decklist in Arena format"
              onClick={() => { props.onCopyDeck(); markArenaCopied() }}
            >
              <Clipboard size={17} />
              {arenaCopied ? 'Copied' : 'Arena'}
            </button>
            <button className="icon-button" type="button" title="Download the decklist as a .txt file" onClick={props.onExportDeck}>
              <Download size={17} />
            </button>
          </div>
        </header>
        <nav className="workspace-tabs">
          <button className={`tab-button ${activeTab === 'plans' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('plans')}>Plans</button>
          <button className={`tab-button ${activeTab === 'journal' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('journal')}>Journal</button>
          <button className={`tab-button ${activeTab === 'replay' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('replay')}>Replay</button>
        </nav>

        {activeTab === 'plans' ? (
          <>
            {sideboardTotal > 15 ? (
              <div className="deck-warning" role="alert">
                Sideboard has {sideboardTotal} cards. Maximum is 15.
              </div>
            ) : null}

            {deckCopyViolations.length > 0 ? (
              <div className="deck-warning" role="alert">
                More than 4 copies across main and sideboard: {describeCopyViolations(deckCopyViolations)}
              </div>
            ) : null}

            <div className="workspace-grid">
              <section className="deck-columns">
                <CardZone
                  title="Main"
                  entries={main}
                  cardById={props.cardById}
                  cardByName={props.cardByName}
                  onChangeQuantity={changeEntryQuantity}
                  onCardClick={handleCardClick}
                  onAddCard={(card) => addCardToZone('main', card)}
                  grouped
                  flaggedNames={deckFlaggedNames}
                />
                <CardZone
                  title="Sideboard"
                  entries={sideboard}
                  cardById={props.cardById}
                  cardByName={props.cardByName}
                  onChangeQuantity={changeEntryQuantity}
                  onCardClick={handleCardClick}
                  onAddCard={(card) => addCardToZone('sideboard', card)}
                  flaggedNames={deckFlaggedNames}
                />
              </section>

              <aside className="matchup-panel">
                <header className="panel-header">
                  <h2>Matchups</h2>
                  <div className="panel-actions">
                    {props.deck.matchups.length > 0 ? (
                      <button
                        className="icon-button"
                        type="button"
                        title="Delete all matchups"
                        onClick={() => {
                          if (confirmAction(`Delete all ${props.deck.matchups.length} matchups? This affects every deck.`)) {
                            props.onDeleteAllMatchups()
                          }
                        }}
                      >
                        <Trash2 size={18} />
                      </button>
                    ) : null}
                    <button className="icon-button" type="button" onClick={addMatchup} title="Add matchup">
                      <Plus size={18} />
                    </button>
                  </div>
                </header>
                <label className="search-field">
                  <Search size={17} />
                  <input value={props.matchupSearch} onChange={(event) => props.onMatchupSearch(event.target.value)} placeholder="Search matchups" />
                </label>
                <ColorFilter exact={props.matchupColorsExact} selected={props.matchupColors} onExactToggle={props.onMatchupExactToggle} onToggle={props.onMatchupColorToggle} />
                <div className="opponent-card-filter">
                  {opponentFilterCards.length > 0 ? (
                    <div className="opponent-filter-chips">
                      {opponentFilterCards.map((card) => (
                        <span key={card.id} className="opponent-filter-chip">
                          {card.imageUris.art_crop ? (
                            <img src={card.imageUris.art_crop} alt={card.name} className="opponent-filter-chip-img" />
                          ) : null}
                          <span className="opponent-filter-chip-name">{card.name}</span>
                          <button
                            className="opponent-filter-chip-remove"
                            type="button"
                            title={`Remove ${card.name} filter`}
                            onClick={() => setOpponentFilterCards((prev) => prev.filter((c) => c.id !== card.id))}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <CardAddInput
                    cardByName={props.cardByName}
                    placeholder="Filter by opponent card…"
                    onAdd={(card) => {
                      if (!opponentFilterCards.some((c) => c.id === card.id)) {
                        setOpponentFilterCards((prev) => [...prev, card])
                      }
                    }}
                  />
                </div>
                <div className="matchup-list">
                  {matchups.map((matchup) => (
                    <button
                      className={`matchup-row ${matchup.id === props.selectedMatchup?.id ? 'active' : ''}`}
                      type="button"
                      key={matchup.id}
                      onClick={() => props.onSelectMatchup(matchup.id)}
                    >
                      <span>{matchup.name}</span>
                      <ManaPips colors={matchup.colors} splash={matchup.splashColors} />
                    </button>
                  ))}
                </div>
              </aside>

              <PlanEditor
                allDecks={props.allDecks}
                cardById={props.cardById}
                cardByName={props.cardByName}
                deck={props.deck}
                matchup={props.selectedMatchup}
                opponentFilterCards={opponentFilterCards}
                onDeleteMatchup={props.onDeleteMatchup}
                onUpdateDeck={props.onUpdateDeck}
                onUpdateMatchupDefinition={props.onUpdateMatchupDefinition}
                copiedPlan={props.copiedPlan}
                onCopyPlan={props.onCopyPlan}
              />
            </div>
          </>
        ) : activeTab === 'journal' ? (
          <JournalView deck={props.deck} cardByName={props.cardByName} onUpdateDeck={props.onUpdateDeck} />
        ) : (
          <ReplayView
            deck={props.deck}
            allDecks={props.allDecks}
            cardById={props.cardById}
            cardByName={props.cardByName}
            onUpdateDeck={props.onUpdateDeck}
            onUpdateMatchupDefinition={props.onUpdateMatchupDefinition}
          />
        )}
      </section>
      {showStats ? (
        <StatsModal
          deck={props.deck}
          cardById={props.cardById}
          cardByName={props.cardByName}
          onClose={() => setShowStats(false)}
        />
      ) : null}
    </DndContext>
  )
}

type StatEntry = { name: string; cardId?: string; totalQty: number; matchupCount: number }

function buildStatEntries(deck: Deck, direction: 'in' | 'out'): StatEntry[] {
  const map = new Map<string, { cardId?: string; totalQty: number; matchupIds: Set<string> }>()
  deck.matchups.forEach((matchup) => {
    const plans = [matchup.plan, ...(matchup.situationalSections ?? []).map((s) => s.plan)]
    plans.forEach((plan) => {
      plan.forEach((entry) => {
        if (entry.direction !== direction) return
        const existing = map.get(entry.name)
        if (existing) {
          existing.totalQty += entry.quantity
          existing.matchupIds.add(matchup.id)
        } else {
          map.set(entry.name, { cardId: entry.cardId, totalQty: entry.quantity, matchupIds: new Set([matchup.id]) })
        }
      })
    })
  })
  return Array.from(map.entries())
    .map(([name, v]) => ({ name, cardId: v.cardId, totalQty: v.totalQty, matchupCount: v.matchupIds.size }))
    .sort((a, b) => b.totalQty - a.totalQty || a.name.localeCompare(b.name))
}

function StatsModal({
  deck,
  cardById,
  cardByName,
  onClose,
}: {
  deck: Deck
  cardById: Map<string, CardRecord>
  cardByName: Map<string, CardRecord>
  onClose: () => void
}) {
  const inEntries = buildStatEntries(deck, 'in')
  const outEntries = buildStatEntries(deck, 'out')
  const plannedMatchupCount = deck.matchups.filter(
    (m) => m.plan.length > 0 || (m.situationalSections ?? []).some((s) => s.plan.length > 0),
  ).length

  function getCard(entry: StatEntry) {
    return (entry.cardId ? cardById.get(entry.cardId) : undefined) ?? cardByName.get(normalizeCardName(entry.name))
  }

  function StatRow({ entry }: { entry: StatEntry }) {
    const card = getCard(entry)
    const imgSrc = card?.faceImageUris?.[0]?.art_crop ?? card?.imageUris?.art_crop
    return (
      <div className="stats-row">
        {imgSrc ? <img className="stats-thumb" src={imgSrc} alt="" /> : <div className="stats-thumb stats-thumb-placeholder" />}
        <span className="stats-name">{entry.name}</span>
        <span className="stats-matchups" title={`${entry.matchupCount} matchup${entry.matchupCount !== 1 ? 's' : ''}`}>
          ×{entry.totalQty} <span className="stats-matchup-badge">{entry.matchupCount}mu</span>
        </span>
      </div>
    )
  }

  return (
    <div className="stats-overlay" onClick={onClose}>
      <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
        <header className="stats-modal-header">
          <div>
            <h2 className="stats-modal-title">Sideboard Stats</h2>
            <p className="stats-modal-sub">{deck.name} · {plannedMatchupCount} matchup{plannedMatchupCount !== 1 ? 's' : ''} with plans</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </header>
        <div className="stats-columns">
          <section className="stats-col">
            <h3 className="stats-col-title">
              <ArrowDownToLine size={13} />
              Coming In <span className="stats-col-count">{inEntries.length} cards</span>
            </h3>
            {inEntries.length === 0 ? (
              <p className="stats-empty">No cards planned in.</p>
            ) : (
              inEntries.map((entry) => <StatRow key={entry.name} entry={entry} />)
            )}
          </section>
          <section className="stats-col">
            <h3 className="stats-col-title">
              <ArrowUpFromLine size={13} />
              Going Out <span className="stats-col-count">{outEntries.length} cards</span>
            </h3>
            {outEntries.length === 0 ? (
              <p className="stats-empty">No cards planned out.</p>
            ) : (
              outEntries.map((entry) => <StatRow key={entry.name} entry={entry} />)
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

const TYPE_GROUPS = ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Instant', 'Sorcery', 'Land'] as const
type TypeGroup = (typeof TYPE_GROUPS)[number]

function getTypeGroup(card?: CardRecord): TypeGroup {
  const t = card?.faces?.[0]?.typeLine ?? card?.typeLine ?? ''
  if (t.includes('Creature')) return 'Creature'
  if (t.includes('Artifact')) return 'Artifact'
  if (t.includes('Enchantment')) return 'Enchantment'
  if (t.includes('Planeswalker')) return 'Planeswalker'
  if (t.includes('Instant')) return 'Instant'
  if (t.includes('Sorcery')) return 'Sorcery'
  return 'Land'
}

// Single source of truth for main-deck ordering: mana value then name, bucketed
// into type groups, with basic lands first among lands. Both the on-screen lists
// and the clipboard exports run through this, so the two can't drift apart.
function groupEntriesByType<T extends { cardId?: string; name: string }>(
  entries: T[],
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
): Array<{ group: TypeGroup; entries: T[] }> {
  const byGroup = new Map<TypeGroup, T[]>()

  for (const entry of [...entries].sort((a, b) => compareCardEntries(a, b, cardById, cardByName))) {
    const group = getTypeGroup(findCardForEntry(entry, cardById, cardByName))
    const bucket = byGroup.get(group)
    if (bucket) bucket.push(entry)
    else byGroup.set(group, [entry])
  }

  const sections: Array<{ group: TypeGroup; entries: T[] }> = []

  for (const group of TYPE_GROUPS) {
    const groupEntries = byGroup.get(group)
    if (!groupEntries?.length) continue

    if (group === 'Land') {
      sections.push({
        group,
        entries: [...groupEntries].sort((a, b) => {
          const aBasic = findCardForEntry(a, cardById, cardByName)?.typeLine.includes('Basic') ? 0 : 1
          const bBasic = findCardForEntry(b, cardById, cardByName)?.typeLine.includes('Basic') ? 0 : 1
          if (aBasic !== bBasic) return aBasic - bBasic
          return a.name.localeCompare(b.name)
        }),
      })
      continue
    }

    sections.push({ group, entries: groupEntries })
  }

  return sections
}

// Export order mirrors the panels: main deck grouped by type, sideboard flat by
// mana value. Without this, exports come out in raw insertion order — the order
// the list was first pasted in, with later additions tacked on the end.
function sortEntriesForExport(
  entries: DeckEntry[],
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
): DeckEntry[] {
  const main = entries.filter((entry) => entry.zone === 'main')
  const sideboard = entries.filter((entry) => entry.zone === 'sideboard')

  return [
    ...groupEntriesByType(main, cardById, cardByName).flatMap((section) => section.entries),
    ...[...sideboard].sort((a, b) => compareCardEntries(a, b, cardById, cardByName)),
  ]
}

function CardZone({
  title,
  entries,
  cardById,
  cardByName,
  onChangeQuantity,
  onCardClick,
  onAddCard,
  grouped,
  flaggedNames,
}: {
  title: string
  entries: DeckEntry[]
  cardById: Map<string, CardRecord>
  cardByName: Map<string, CardRecord>
  onChangeQuantity?: (entryId: string, delta: number) => void
  onCardClick?: (entry: DeckEntry) => void
  onAddCard?: (card: CardRecord) => void
  grouped?: boolean
  flaggedNames?: Set<string>
}) {
  const sortedEntries = [...entries].sort((left, right) =>
    compareDeckEntries(left, right, cardById, cardByName),
  )

  const renderRow = (entry: DeckEntry) => (
    <DraggableCardRow
      key={entry.id}
      entry={entry}
      card={findCardForEntry(entry, cardById, cardByName)}
      onDecrement={onChangeQuantity ? () => onChangeQuantity(entry.id, -1) : undefined}
      onIncrement={onChangeQuantity ? () => onChangeQuantity(entry.id, 1) : undefined}
      onClick={onCardClick ? () => onCardClick(entry) : undefined}
      flagged={flaggedNames?.has(entry.name)}
    />
  )

  let cardListContent: React.ReactNode

  if (grouped) {
    cardListContent = groupEntriesByType(sortedEntries, cardById, cardByName).flatMap(
      ({ group, entries: groupEntries }) => [
        <div key={`header-${group}`} className="zone-type-header">{group}<span>{groupEntries.reduce((s, e) => s + e.quantity, 0)}</span></div>,
        ...groupEntries.map(renderRow),
      ],
    )
  } else {
    cardListContent = sortedEntries.map(renderRow)
  }

  return (
    <section className="zone">
      <header className="zone-header">
        <h2>{title}</h2>
        <span>{entries.reduce((sum, entry) => sum + entry.quantity, 0)}</span>
      </header>
      <div className="card-list">
        {cardListContent}
      </div>
      {onAddCard ? <CardAddInput cardByName={cardByName} onAdd={onAddCard} /> : null}
    </section>
  )
}

function DraggableCardRow({
  entry,
  card,
  onDecrement,
  onIncrement,
  onClick,
  flagged,
}: {
  entry: DeckEntry
  card?: CardRecord
  onDecrement?: () => void
  onIncrement?: () => void
  onClick?: () => void
  flagged?: boolean
}) {
  const [previewStyle, setPreviewStyle] = useState<CSSProperties>({})
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `entry-${entry.id}`,
    data: { kind: 'deck-entry', entryId: entry.id, zone: entry.zone },
  })

  return (
    <div
      ref={setNodeRef}
      className={`card-row zone-${entry.zone} ${isDragging ? 'dragging' : ''}${flagged ? ' copy-violation' : ''}`}
      style={isDragging ? undefined : { transform: CSS.Translate.toString(transform) }}
      onPointerEnter={(event) => setPreviewStyle(getPreviewPosition(event.currentTarget, 'right', card))}
      onClick={onClick}
      title={onClick ? (entry.zone === 'sideboard' ? 'Click to add to In' : 'Click to add to Out') : undefined}
      {...attributes}
      {...listeners}
    >
      <CardDetails name={entry.name} card={card} previewStyle={previewStyle} />
      <div className="entry-quantity" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {onDecrement ? (
          <button className="tiny-button entry-qty-btn" type="button" onClick={onDecrement} title="Remove one">−</button>
        ) : null}
        <span className="quantity">{entry.quantity}</span>
        {onIncrement ? (
          <button className="tiny-button entry-qty-btn" type="button" onClick={onIncrement} title="Add one">+</button>
        ) : null}
      </div>
    </div>
  )
}

function CardOverlay({ entry, card }: { entry: DeckEntry; card?: CardRecord }) {
  return (
    <div className="card-row card-drag-overlay">
      <CardDetails name={entry.name} card={card} />
      <div className="entry-quantity">
        <span className="quantity">{entry.quantity}</span>
      </div>
    </div>
  )
}

function CardAddInput({
  cardByName,
  onAdd,
  placeholder = 'Add card…',
}: {
  cardByName: Map<string, CardRecord>
  onAdd: (card: CardRecord) => void
  placeholder?: string
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => searchCards(query, cardByName), [query, cardByName])

  function select(card: CardRecord) {
    onAdd(card)
    setQuery('')
    setOpen(false)
    inputRef.current?.focus()
  }

  return (
    <div className="card-add-wrapper">
      <input
        ref={inputRef}
        className="card-add-input"
        value={query}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results.length > 0) select(results[0])
          if (e.key === 'Escape') { setQuery(''); setOpen(false) }
        }}
      />
      {open && results.length > 0 ? (
        <ul className="card-add-dropdown" role="listbox">
          {results.map((card) => (
            <li key={card.id} className="card-add-option" role="option" onMouseDown={() => select(card)}>
              {card.name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function PlanEditor({
  allDecks,
  cardById,
  cardByName,
  deck,
  matchup,
  opponentFilterCards,
  onDeleteMatchup,
  onUpdateDeck,
  onUpdateMatchupDefinition,
  copiedPlan,
  onCopyPlan,
}: {
  allDecks: Deck[]
  cardById: Map<string, CardRecord>
  cardByName: Map<string, CardRecord>
  deck: Deck
  matchup: Matchup | null
  opponentFilterCards: CardRecord[]
  onDeleteMatchup: (matchupId: string) => void
  onUpdateDeck: (updater: (deck: Deck) => Deck) => void
  onUpdateMatchupDefinition: (matchupId: string, updater: (matchup: Matchup) => Matchup) => void
  copiedPlan: CopiedPlan | null
  onCopyPlan: (plan: CopiedPlan) => void
}) {
  const [opponentOpen, setOpponentOpen] = useState(false)
  const [opponentCopied, markOpponentCopied] = useCopyFeedback()
  const [planCopied, markPlanCopied] = useCopyFeedback()
  const [opponentImportText, setOpponentImportText] = useState('')
  const [showOpponentImport, setShowOpponentImport] = useState(false)
  const [ocrSkipped, setOcrSkipped] = useState(0)
  const opponentFileInputRef = useRef<HTMLInputElement>(null)
  const opponentOcr = useScreenshotOcr(cardById, cardByName, (matches) => {
    const recognised = matches.filter((match) => match.name)
    setOcrSkipped(matches.length - recognised.length)
    const block = recognised.map((match) => `${match.quantity} ${match.name}`).join('\n')
    // Appends rather than replaces, so two screenshots (or a screenshot plus typed
    // "Sideboard" header) build up one list before importing.
    setOpponentImportText((current) => (current.trim() ? `${current.trimEnd()}\n${block}` : block))
  })
  const [variantImportText, setVariantImportText] = useState('')
  const [showVariantImport, setShowVariantImport] = useState(false)

  if (!matchup) {
    return (
      <section className="plan-panel empty-state">
        <h2>Sideboard Plan</h2>
      </section>
    )
  }

  const activeMatchup = matchup
  const donorDecks = allDecks.filter(
    (d) => d.id !== deck.id && d.matchups.some((m) => m.id === matchup.id && m.plan.length > 0),
  )
  const opponentEntries = matchup.opponentEntries ?? []
  const opponentMain = opponentEntries.filter((e) => e.zone === 'main')
  const opponentSideboard = opponentEntries.filter((e) => e.zone === 'sideboard')
  const opponentCopyViolations = findCopyLimitViolations(opponentEntries, cardById, cardByName)
  const opponentFlaggedNames = new Set(opponentCopyViolations.map((item) => item.name))
  const opponentVariantEntries = matchup.opponentVariantEntries ?? []
  const alsoSeenEntries = computeAlsoSeenEntries(opponentEntries, opponentVariantEntries)
  const situationalSections = getSituationalSections(matchup)
  const normalizedPlan = normalizePlanEntries(deck, getMatchupPlan(matchup, 'primary'))
  const cardsIn = normalizedPlan.filter((entry) => entry.direction === 'in')
  const cardsOut = normalizedPlan.filter((entry) => entry.direction === 'out')
  const cardsInTotal = sumPlanQuantity(cardsIn)
  const cardsOutTotal = sumPlanQuantity(cardsOut)
  const startingSideboardTotal = deck.entries
    .filter((entry) => entry.zone === 'sideboard')
    .reduce((total, entry) => total + entry.quantity, 0)
  const postSideboardTotal = startingSideboardTotal - cardsInTotal + cardsOutTotal
  const situationalPlanViews = situationalSections.map((section) => {
    const sectionKey = getSituationalSectionKey(section.id)
    const normalizedSectionPlan = normalizePlanEntries(deck, section.plan)
    const sectionCardsIn = normalizedSectionPlan.filter((entry) => entry.direction === 'in')
    const sectionCardsOut = normalizedSectionPlan.filter((entry) => entry.direction === 'out')
    const sectionPostSideboardTotal = postSideboardTotal - sumPlanQuantity(sectionCardsIn) + sumPlanQuantity(sectionCardsOut)

    return {
      ...section,
      key: sectionKey,
      cardsIn: sectionCardsIn,
      cardsOut: sectionCardsOut,
      postSideboardTotal: sectionPostSideboardTotal,
    }
  })

  function updateMatchup(updater: (matchup: Matchup) => Matchup) {
    onUpdateDeck((current) => ({
      ...current,
      matchups: current.matchups.map((item) => {
        if (item.id !== activeMatchup.id) return item
        const updated = updater(item)
        return normalizeMatchupPlans(deck, updated)
      }),
      updatedAt: new Date().toISOString(),
    }))
  }

  function rename(name: string) {
    onUpdateMatchupDefinition(activeMatchup.id, (item) => ({ ...item, name }))
  }

  // Manual pip clicks override the inferred identity: a color the user turns on is
  // a main color, and one they turn off drops its splash marking with it.
  function setColors(color: MtgColor) {
    onUpdateMatchupDefinition(activeMatchup.id, (item) => {
      const colors = toggleColor(item.colors, color)
      return {
        ...item,
        colors,
        splashColors: (item.splashColors ?? []).filter((c) => c !== color && colors.includes(c)),
      }
    })
  }

  function importOpponentDeck() {
    const { deck } = parseArenaDecklist(opponentImportText, cardByName, activeMatchup.name)
    if (deck.entries.length === 0) return
    const profile = inferOpponentColorProfile(deck.entries, opponentVariantEntries, cardByName)
    onUpdateMatchupDefinition(activeMatchup.id, (item) => ({
      ...item,
      opponentEntries: deck.entries,
      colors: profile.colors,
      splashColors: profile.splash,
    }))
    setShowOpponentImport(false)
    setOpponentImportText('')
    setOcrSkipped(0)
    setOpponentOpen(true)
  }

  function updateOpponentEntries(entries: DeckEntry[]) {
    const profile = inferOpponentColorProfile(entries, opponentVariantEntries, cardByName)
    onUpdateMatchupDefinition(activeMatchup.id, (item) => ({
      ...item,
      opponentEntries: entries,
      colors: profile.colors,
      splashColors: profile.splash,
    }))
  }

  // Matched on name AND zone: the same card legitimately appears in both the
  // maindeck and the sideboard, and those counts are tracked separately.
  function addOpponentCard(card: CardRecord, zone: Zone) {
    const existing = opponentEntries.find((entry) => entry.name === card.name && entry.zone === zone)
    updateOpponentEntries(existing
      ? opponentEntries.map((entry) => (entry === existing ? { ...entry, quantity: entry.quantity + 1 } : entry))
      : [...opponentEntries, { id: createId('entry'), cardId: card.id, name: card.name, quantity: 1, zone }])
  }

  function adjustOpponentCard(entryId: string, delta: number) {
    updateOpponentEntries(opponentEntries.flatMap((entry) => {
      if (entry.id !== entryId) return [entry]
      const quantity = entry.quantity + delta
      return quantity > 0 ? [{ ...entry, quantity }] : []
    }))
  }

  function clearOpponentDeck() {
    onUpdateMatchupDefinition(activeMatchup.id, (item) => ({ ...item, opponentEntries: [] }))
    setShowOpponentImport(false)
  }

  function updateVariantEntries(rawEntries: DeckEntry[]) {
    onUpdateMatchupDefinition(activeMatchup.id, (item) => (
      applyVariantEntries(item, rawEntries, cardById, cardByName)
    ))
  }

  function importVariantDeck() {
    const { deck } = parseArenaDecklist(variantImportText, cardByName, activeMatchup.name)
    if (deck.entries.length === 0) return
    updateVariantEntries(mergeVariantEntries(opponentVariantEntries, deck.entries))
    setShowVariantImport(false)
    setVariantImportText('')
    setOpponentOpen(true)
  }

  function addVariantCard(card: CardRecord) {
    // Counts are stored raw and displayed net of the conventional 75, so bump a
    // card already in that 75 past its count — otherwise the first click adds
    // nothing visible.
    const conventionalQty = opponentEntries
      .filter((entry) => entry.name === card.name)
      .reduce((total, entry) => total + entry.quantity, 0)
    const existing = opponentVariantEntries.find((entry) => entry.name === card.name)
    const nextQuantity = Math.max((existing?.quantity ?? 0) + 1, conventionalQty + 1)

    const entries: DeckEntry[] = existing
      ? opponentVariantEntries.map((entry) =>
          entry.name === card.name ? { ...entry, quantity: nextQuantity } : entry,
        )
      : [
          ...opponentVariantEntries,
          { id: createId('entry'), cardId: card.id, name: card.name, quantity: nextQuantity, zone: 'main' },
        ]

    updateVariantEntries(entries)
  }

  function clearVariantDeck() {
    onUpdateMatchupDefinition(activeMatchup.id, (item) => ({ ...item, opponentVariantEntries: [] }))
    setShowVariantImport(false)
  }

  function copyOpponentDeck() {
    const sorted = sortEntriesForExport(opponentEntries, cardById, cardByName)
    const main = sorted.filter((e) => e.zone === 'main')
    const side = sorted.filter((e) => e.zone === 'sideboard')
    const alsoSeen = [...alsoSeenEntries].sort((a, b) => compareCardEntries(a, b, cardById, cardByName))

    const lines = ['Deck', ...main.map((e) => `${e.quantity} ${e.name}`)]
    if (side.length > 0) lines.push('', 'Sideboard', ...side.map((e) => `${e.quantity} ${e.name}`))
    if (alsoSeen.length > 0) lines.push('', 'Also Seen', ...alsoSeen.map((e) => `${e.quantity} ${e.name}`))
    navigator.clipboard.writeText(lines.join('\n'))
    markOpponentCopied()
  }

  function copyFromDeck(sourceDeckId: string) {
    const source = allDecks.find((d) => d.id === sourceDeckId)
    const sourceMatchup = source?.matchups.find((m) => m.id === activeMatchup.id)
    if (!sourceMatchup) return
    updateMatchup((item) => ({
      ...item,
      notes: sourceMatchup.notes,
      plan: clonePlanEntries(normalizePlanEntries(source!, getMatchupPlan(sourceMatchup, 'primary'))),
      situationalSections: getSituationalSections(sourceMatchup).map((section) => ({
        id: createId('situational'),
        notes: section.notes,
        plan: clonePlanEntries(section.plan),
      })),
    }))
  }

  function addSituationalSection() {
    updateMatchup((item) => ({
      ...item,
      situationalSections: [
        ...getSituationalSections(item),
        {
          id: createId('situational'),
          notes: '',
          plan: [],
        },
      ],
    }))
  }

  function removeSituationalSection(sectionId: string) {
    updateMatchup((item) => ({
      ...item,
      situationalSections: getSituationalSections(item).filter((section) => section.id !== sectionId),
    }))
  }

  function updateSituationalNotes(sectionId: string, notes: string) {
    updateMatchup((item) => ({
      ...item,
      situationalSections: getSituationalSections(item).map((section) => (
        section.id === sectionId ? { ...section, notes } : section
      )),
    }))
  }

  function updateQuantity(section: PlanSection, entryId: string, delta: number) {
    updateMatchup((item) => {
      const plan = normalizePlanEntries(deck, getMatchupPlan(item, section))
        .map((entry) => {
          if (entry.id !== entryId) return entry
          const sourceEntry = deck.entries.find((deckEntry) => deckEntry.id === entry.entryId)
          const availableQuantity = sourceEntry ? getEntryPoolQuantity(deck, sourceEntry, entry.direction) : entry.quantity
          const nextQuantity = entry.quantity + delta

          if (nextQuantity <= 0) {
            return { ...entry, quantity: 0 }
          }

          return { ...entry, quantity: Math.min(availableQuantity, nextQuantity) }
        })
        .filter((entry) => entry.quantity > 0)

      return setMatchupPlan(item, section, plan)
    })
  }

  function clearPlan() {
    updateMatchup((item) => ({
      ...item,
      notes: '',
      plan: [],
      situationalSections: [],
    }))
  }

  function removeMatchup() {
    onDeleteMatchup(activeMatchup.id)
  }

  function copyPlan() {
    // Two destinations, deliberately: the in-app clipboard keeps the full object
    // (notes and situational sections) for Paste, while the system clipboard gets
    // readable text. Round-tripping text back would lose everything but the cards.
    const blocks = [formatPlanLines(normalizedPlan, cardById, cardByName).join('\n')].filter(Boolean)

    for (const section of situationalSections) {
      const sectionLines = formatPlanLines(normalizePlanEntries(deck, section.plan), cardById, cardByName)
      if (sectionLines.length === 0) continue
      const label = section.notes.trim() || 'Situational:'
      blocks.push([label, ...sectionLines].join('\n'))
    }

    if (blocks.length > 0) navigator.clipboard.writeText(blocks.join('\n\n'))
    markPlanCopied()

    onCopyPlan({
      sourceName: activeMatchup.name,
      notes: activeMatchup.notes,
      plan: clonePlanEntries(normalizedPlan),
      situationalSections: situationalSections.map((section) => ({
        id: createId('situational'),
        notes: section.notes,
        plan: clonePlanEntries(normalizePlanEntries(deck, section.plan)),
      })),
    })
  }

  function pastePlan() {
    if (!copiedPlan) return

    updateMatchup((item) => ({
      ...item,
      notes: copiedPlan.notes,
      plan: clonePlanEntries(copiedPlan.plan),
      situationalSections: copiedPlan.situationalSections.map((section) => ({
        id: createId('situational'),
        notes: section.notes,
        plan: clonePlanEntries(section.plan),
      })),
    }))
  }

  return (
    <section className="plan-panel">
      <header className="panel-header">
        <h2>Sideboard Plan</h2>
        {donorDecks.length > 0 ? (
          <select
            className="copy-from-select"
            value=""
            onChange={(e) => { if (e.target.value) copyFromDeck(e.target.value) }}
            title="Copy sideboard plan from another deck"
          >
            <option value="" disabled>Copy plan from…</option>
            {donorDecks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) : null}
        <div className="panel-actions">
          <button
            className="icon-button"
            type="button"
            onClick={copyPlan}
            title={planCopied ? 'Copied' : 'Copy sideboard plan (also copies as text)'}
          >
            {planCopied ? <Check size={17} className="copy-confirmed" /> : <Clipboard size={17} />}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={pastePlan}
            title={copiedPlan ? `Paste sideboard plan from ${copiedPlan.sourceName}` : 'Paste sideboard plan'}
            disabled={!copiedPlan}
          >
            <ClipboardPaste size={17} />
          </button>
          <button className="icon-button" type="button" onClick={clearPlan} title="Clear sideboard plan">
            <Eraser size={17} />
          </button>
          <button className="icon-button" type="button" onClick={removeMatchup} title="Delete matchup">
            <Trash2 size={18} />
          </button>
        </div>
      </header>
      <input className="matchup-name" value={matchup.name} onChange={(event) => rename(event.target.value)} />
      <ColorFilter selected={matchup.colors} onToggle={setColors} />
      <div className="opponent-deck">
        <header className="opponent-deck-header" onClick={() => setOpponentOpen((o) => !o)}>
          <span className="opponent-deck-title">
            <ChevronDown size={14} className={`opponent-chevron ${opponentOpen ? '' : 'collapsed'}`} />
            Opponent Deck
            {opponentEntries.length > 0 ? (
              <span className="opponent-count">{opponentEntries.reduce((s, e) => s + e.quantity, 0)}</span>
            ) : null}
          </span>
          <div className="opponent-deck-actions" onClick={(e) => e.stopPropagation()}>
            {opponentEntries.length > 0 ? (
              <>
                <button
                  className="icon-button tiny"
                  type="button"
                  title={opponentCopied ? 'Copied' : 'Copy opponent deck to clipboard'}
                  onClick={copyOpponentDeck}
                >
                  {opponentCopied ? <Check size={14} className="copy-confirmed" /> : <Clipboard size={14} />}
                </button>
                <button className="icon-button tiny" type="button" title="Clear opponent deck" onClick={clearOpponentDeck}>
                  <Trash2 size={14} />
                </button>
              </>
            ) : null}
            <button
              className="icon-button tiny"
              type="button"
              title="Import opponent deck"
              onClick={() => { setShowOpponentImport((v) => !v); setOpponentOpen(true) }}
            >
              <Import size={14} />
            </button>
          </div>
        </header>
        {opponentOpen ? (
          <div className="opponent-deck-body">
            {showOpponentImport ? (
              <div className="opponent-import">
                <textarea
                  value={opponentImportText}
                  onChange={(e) => setOpponentImportText(e.target.value)}
                  onPaste={opponentOcr.handlePaste}
                  onDrop={opponentOcr.handleDrop}
                  onDragOver={(event) => event.preventDefault()}
                  placeholder={opponentOcr.canOcr
                    ? 'Paste an Arena decklist, or paste a screenshot to read it into text…'
                    : 'Paste Arena decklist…'}
                  spellCheck={false}
                  rows={5}
                />
                {opponentOcr.ocrError ? <p className="scout-ocr-error">{opponentOcr.ocrError}</p> : null}
                {ocrSkipped > 0 ? (
                  <p className="opponent-import-note">
                    {ocrSkipped} line{ocrSkipped === 1 ? '' : 's'} could not be matched to a card and were left out —
                    check the list before importing.
                  </p>
                ) : null}
                <div className="opponent-import-actions">
                  {opponentOcr.canOcr ? (
                    <>
                      <input
                        ref={opponentFileInputRef}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(event) => {
                          const file = event.target.files?.[0]
                          if (file) opponentOcr.readImageFile(file)
                          event.target.value = ''
                        }}
                      />
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => opponentFileInputRef.current?.click()}
                        disabled={opponentOcr.ocrBusy}
                      >
                        <ImageIcon size={15} />
                        {opponentOcr.ocrBusy ? 'Reading…' : 'Screenshot'}
                      </button>
                    </>
                  ) : null}
                  <button className="secondary-button" type="button" onClick={() => { setShowOpponentImport(false); setOpponentImportText(''); setOcrSkipped(0) }}>
                    Cancel
                  </button>
                  <button className="primary-button" type="button" onClick={importOpponentDeck}>
                    <Import size={15} />
                    Import
                  </button>
                </div>
              </div>
            ) : null}
            {!showOpponentImport && opponentEntries.length === 0 ? (
              <p className="opponent-empty">No opponent deck imported — paste one above, or add cards below.</p>
            ) : null}
            {!showOpponentImport && opponentCopyViolations.length > 0 ? (
              <div className="plan-warning opponent-warning" role="alert">
                More than 4 across main and sideboard: {describeCopyViolations(opponentCopyViolations)}
              </div>
            ) : null}
            {!showOpponentImport ? (
              <div className="opponent-zone">
                <div className="opponent-zone-header">
                  Main <span>{opponentMain.reduce((s, e) => s + e.quantity, 0)}</span>
                </div>
                {groupEntriesByType(opponentMain, cardById, cardByName).flatMap(
                  ({ group, entries: groupEntries }) => [
                    <div key={`header-${group}`} className="opponent-type-header">{group}<span>{groupEntries.reduce((s, e) => s + e.quantity, 0)}</span></div>,
                    ...groupEntries.map((entry) => (
                      <OpponentCardRow key={entry.id} entry={entry} cardById={cardById} cardByName={cardByName} highlighted={opponentFilterCards.some((fc) => fc.id === entry.cardId || fc.name === entry.name)} flagged={opponentFlaggedNames.has(entry.name)} onQuantity={(delta) => adjustOpponentCard(entry.id, delta)} />
                    )),
                  ],
                )}
              </div>
            ) : null}
            {!showOpponentImport ? (
              <CardAddInput cardByName={cardByName} placeholder="Add to main deck…" onAdd={(card) => addOpponentCard(card, 'main')} />
            ) : null}
            {!showOpponentImport ? (
              <div className="opponent-zone">
                <div className="opponent-zone-header">
                  Sideboard <span>{opponentSideboard.reduce((s, e) => s + e.quantity, 0)}</span>
                </div>
                {[...opponentSideboard]
                  .sort((a, b) => compareCardEntries(a, b, cardById, cardByName))
                  .map((entry) => (
                    <OpponentCardRow key={entry.id} entry={entry} cardById={cardById} cardByName={cardByName} highlighted={opponentFilterCards.some((fc) => fc.id === entry.cardId || fc.name === entry.name)} flagged={opponentFlaggedNames.has(entry.name)} onQuantity={(delta) => adjustOpponentCard(entry.id, delta)} />
                  ))}
              </div>
            ) : null}
            {!showOpponentImport ? (
              <CardAddInput cardByName={cardByName} placeholder="Add to sideboard…" onAdd={(card) => addOpponentCard(card, 'sideboard')} />
            ) : null}
            <div className="also-seen-section">
              <div className="also-seen-header">
                <span className="also-seen-title">
                  Also Seen
                  {alsoSeenEntries.length > 0 ? (
                    <span className="opponent-count">{alsoSeenEntries.reduce((s, e) => s + e.quantity, 0)}</span>
                  ) : null}
                </span>
                <div className="opponent-deck-actions" onClick={(e) => e.stopPropagation()}>
                  {opponentVariantEntries.length > 0 ? (
                    <button className="icon-button tiny" type="button" title="Clear also seen" onClick={clearVariantDeck}>
                      <Trash2 size={14} />
                    </button>
                  ) : null}
                  <button
                    className="icon-button tiny"
                    type="button"
                    title="Import cards seen in play"
                    onClick={() => setShowVariantImport((v) => !v)}
                  >
                    <Import size={14} />
                  </button>
                </div>
              </div>
              {showVariantImport ? (
                <div className="opponent-import">
                  <textarea
                    value={variantImportText}
                    onChange={(e) => setVariantImportText(e.target.value)}
                    placeholder="Paste cards from your actual game… (merged with what's already here)"
                    spellCheck={false}
                    rows={5}
                  />
                  <div className="opponent-import-actions">
                    <button className="secondary-button" type="button" onClick={() => { setShowVariantImport(false); setVariantImportText('') }}>
                      Cancel
                    </button>
                    <button className="primary-button" type="button" onClick={importVariantDeck}>
                      <Import size={15} />
                      Add
                    </button>
                  </div>
                </div>
              ) : null}
              {!showVariantImport && alsoSeenEntries.length === 0 ? (
                <p className="opponent-empty">Cards seen in play beyond the conventional 75.</p>
              ) : null}
              {!showVariantImport && alsoSeenEntries.length > 0 ? (
                <div className="opponent-zone also-seen-grid">
                  {[...alsoSeenEntries]
                    .sort((a, b) => compareCardEntries(a, b, cardById, cardByName))
                    .map((entry) => (
                      <OpponentCardRow
                        key={entry.id}
                        entry={entry}
                        cardById={cardById}
                        cardByName={cardByName}
                      />
                    ))}
                </div>
              ) : null}
              {!showVariantImport ? (
                <div className="also-seen-add">
                  <CardAddInput cardByName={cardByName} placeholder="Add a card you saw…" onAdd={addVariantCard} />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <AutoGrowTextarea className="notes" value={matchup.notes} onChange={(value) => updateMatchup((item) => ({ ...item, notes: value }))} placeholder="Notes" />
      {postSideboardTotal > 15 ? (
        <div className="plan-warning" role="alert">
          Sideboard would be {postSideboardTotal} cards after sideboarding. Maximum is 15.
        </div>
      ) : null}
      <PlanColumns section="primary" cardsIn={cardsIn} cardsOut={cardsOut} cardById={cardById} cardByName={cardByName} onQuantity={updateQuantity} />
      {situationalPlanViews.map((section) => (
        <section className="situational-section" key={section.id}>
          <header className="situational-header">
            <h3>Situational Sideboarding</h3>
            <button className="icon-button tiny" type="button" onClick={() => removeSituationalSection(section.id)} title="Remove situational sideboarding">
              <Trash2 size={15} />
            </button>
          </header>
          <AutoGrowTextarea className="notes situational-notes" value={section.notes} onChange={(value) => updateSituationalNotes(section.id, value)} placeholder="Notes for situational sideboarding" />
          {section.postSideboardTotal > 15 ? (
            <div className="plan-warning" role="alert">
              Situational sideboard would be {section.postSideboardTotal} cards after sideboarding. Maximum is 15.
            </div>
          ) : null}
          <PlanColumns section={section.key} cardsIn={section.cardsIn} cardsOut={section.cardsOut} cardById={cardById} cardByName={cardByName} onQuantity={updateQuantity} />
        </section>
      ))}
      <button className="add-situational-button" type="button" onClick={addSituationalSection}>
        <Plus size={17} />
        Situational Sideboarding
      </button>
    </section>
  )
}

// Reads what the opponent brought in after game one by diffing the cards you
// actually saw against their assumed maindeck. Deliberately only reports what came
// IN: not seeing a card is no evidence it was cut, so the "out" side can't be
// derived from a partial observation.


// A parsed MTGA match as a journal entry. Everything the journal asks for is already
// known: who, when, each game's result, and who was on the play — the latter stored
// explicitly rather than left to be inferred, since the log actually says.
//
// Notes carry answers to the two prompts the log can answer: what we boarded (exact)
// and what they appear to have boarded (inferred). The rest is left blank, because
// the replay is the record of what happened and the journal is for what you thought
// about it.
function matchLogFromReplay(
  match: MtgaMatch,
  archetype: string,
  notes: { cardByName: Map<string, CardRecord>; opponentEntries: DeckEntry[]; ownBoarding: boolean },
): MatchLog {
  return {
    id: createId('match'),
    // Blank rather than the MTGA screen name when uncategorised: the journal's
    // opponent field is a matchup picker, and a player name is not a matchup.
    opponent: archetype,
    date: match.playedAt,
    replayMatchId: match.matchId ?? undefined,
    games: match.games.map((game) => ({
      id: createId('game'),
      result: game.won === null ? '' : game.won ? 'win' : 'loss',
      ...(game.onThePlay === null ? {} : { start: game.onThePlay ? 'play' as const : 'draw' as const }),
      notes: gameNotesFromReplay(
        match, game, notes.cardByName, notes.opponentEntries, notes.ownBoarding,
      ),
    })),
  }
}

// Only matches that carry a matchID can be deduplicated, so only those are offered.
function replayMatchesToImport(deck: Deck, matches: MtgaMatch[]): MtgaMatch[] {
  const already = new Set((deck.matchLogs ?? []).map((log) => log.replayMatchId).filter(Boolean))
  return matches.filter((match) => match.matchId && !already.has(match.matchId))
}

function addMatchLogs(deck: Deck, logs: MatchLog[]): Deck {
  if (logs.length === 0) return deck
  // The journal is newest first, and an import can bring several at once.
  const merged = [...logs, ...(deck.matchLogs ?? [])]
    .sort((a, b) => b.date.localeCompare(a.date))
  return { ...deck, matchLogs: merged, updatedAt: new Date().toISOString() }
}

function formatPercent(value: number | null) {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

function toGameRate(wins: number, losses: number) {
  return wins + losses === 0 ? null : wins / (wins + losses)
}

function winRateClass(value: number | null) {
  if (value === null) return ''
  if (value >= 0.6) return ' is-good'
  if (value < 0.45) return ' is-bad'
  return ''
}

function JournalStatsModal({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const stats = summarizeJournal(deck)
  const decided = stats.matchWins + stats.matchLosses

  return (
    <div className="stats-overlay" onClick={onClose}>
      <div className="stats-modal" onClick={(event) => event.stopPropagation()}>
        <header className="stats-modal-header">
          <div>
            <h2 className="stats-modal-title">Match Stats</h2>
            <p className="stats-modal-sub">{deck.name}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </header>

        <div className="jstat-tiles">
          <div className="jstat-tile" title="Share of decided matches won">
            <span className="jstat-label">Winrate</span>
            <span className={`jstat-value${winRateClass(stats.winRate)}`}>{formatPercent(stats.winRate)}</span>
            <span className="jstat-sub">{stats.matchWins} – {stats.matchLosses} matches</span>
          </div>
          <div className="jstat-tile" title="Individual games won and lost">
            <span className="jstat-label">Games</span>
            <span className="jstat-value">{stats.gameWins} – {stats.gameLosses}</span>
            <span className="jstat-sub">{formatPercent(toGameRate(stats.gameWins, stats.gameLosses))} of games</span>
          </div>
          <div className="jstat-tile" title="Games won when on the play (per game, not per match)">
            <span className="jstat-label">On the play</span>
            <span className={`jstat-value${winRateClass(stats.onPlay.winRate)}`}>{formatPercent(stats.onPlay.winRate)}</span>
            <span className="jstat-sub">{stats.onPlay.wins} – {stats.onPlay.losses} games</span>
          </div>
          <div className="jstat-tile" title="Games won when on the draw (per game, not per match)">
            <span className="jstat-label">On the draw</span>
            <span className={`jstat-value${winRateClass(stats.onDraw.winRate)}`}>{formatPercent(stats.onDraw.winRate)}</span>
            <span className="jstat-sub">{stats.onDraw.wins} – {stats.onDraw.losses} games</span>
          </div>
        </div>

        {stats.matches.length === 0 ? (
          <p className="stats-empty">No matches logged yet.</p>
        ) : (
          <div className="jstat-table">
            <div className="jstat-row jstat-head">
              <span>Matchup</span>
              <span>Winrate</span>
              <span>Matches</span>
              <span />
            </div>
            {stats.byMatchup.map((row) => {
              const total = Math.max(row.wins + row.losses, 1)
              return (
                <div className="jstat-row" key={row.name}>
                  <span className="jstat-name">{row.name}</span>
                  <span className={`jstat-rate${winRateClass(row.winRate)}`}>{formatPercent(row.winRate)}</span>
                  <span className="jstat-record">{row.wins} – {row.losses}</span>
                  <span className="jstat-bar" aria-hidden="true">
                    {row.wins > 0 ? <i className="jstat-bar-win" style={{ flexGrow: row.wins / total }} /> : null}
                    {row.losses > 0 ? <i className="jstat-bar-loss" style={{ flexGrow: row.losses / total }} /> : null}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {stats.onPlay.wins + stats.onPlay.losses + stats.onDraw.wins + stats.onDraw.losses === 0 ? (
          <p className="jstat-foot">
            No play/draw recorded yet — set it per game in the Journal and those tiles fill in.
          </p>
        ) : null}
        {decided < stats.matches.length ? (
          <p className="jstat-foot">
            {stats.matches.length - decided} match{stats.matches.length - decided === 1 ? '' : 'es'} not counted in
            winrate (drawn or no result recorded).
          </p>
        ) : null}
      </div>
    </div>
  )
}

// Four is the deck-building limit, and an OCR misread is far likelier than a real
// fifth copy (a tracker screenshot produced "Ashling x7" from row chrome). The two
// genuine exceptions are basic lands — which every deck runs 20+ of, and which you
// will routinely see five of in one game — and cards whose own text lifts the limit.
const MAX_COPIES = 4

function cardAllowsAnyNumber(card?: CardRecord) {
  if (!card) return false
  if (card.typeLine.includes('Basic')) return true
  return /any number of cards named/i.test(card.oracleText)
}

function maxCopiesFor(
  entry: { cardId?: string; name: string },
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
) {
  return cardAllowsAnyNumber(findCardForEntry(entry, cardById, cardByName))
    ? Number.POSITIVE_INFINITY
    : MAX_COPIES
}

function clampCopies(
  entries: DeckEntry[],
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
): DeckEntry[] {
  return entries.map((entry) => {
    const max = maxCopiesFor(entry, cardById, cardByName)
    return entry.quantity > max ? { ...entry, quantity: max } : entry
  })
}

// Counts copies by name across BOTH zones — the deck-building limit is four per
// deck, not four per zone, so 3 main plus 2 sideboard is already illegal. Reported
// rather than clamped: an imported list is authoritative, and silently rewriting it
// would hide the mistake instead of showing it.
function findCopyLimitViolations(
  entries: DeckEntry[],
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
) {
  const totals = new Map<string, { name: string; quantity: number; max: number }>()

  for (const entry of entries) {
    const existing = totals.get(entry.name)
    if (existing) {
      existing.quantity += entry.quantity
      continue
    }
    totals.set(entry.name, {
      name: entry.name,
      quantity: entry.quantity,
      max: maxCopiesFor(entry, cardById, cardByName),
    })
  }

  return Array.from(totals.values())
    .filter((total) => total.quantity > total.max)
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
}

function describeCopyViolations(violations: Array<{ name: string; quantity: number }>) {
  return violations.map((item) => `${item.name} (${item.quantity})`).join(', ')
}

// Screenshot OCR for the Opponent Deck importer. Quantities are clamped here so an
// OCR misread cannot present an illegal count anywhere it is used.
//
// Kept as a hook although only one caller is left: it was shared with Scout's capture
// panel, and the clamping is the part that must not be reimplemented by the next
// importer that wants a screenshot.
function useScreenshotOcr(
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
  onMatches: (matches: OcrMatch[]) => void,
) {
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrError, setOcrError] = useState('')

  const canOcr = Boolean(window.electronAPI?.ocrImage)

  async function runOcr(dataUrl: string) {
    setOcrBusy(true)
    setOcrError('')
    try {
      const words = await window.electronAPI!.ocrImage(dataUrl)
      const matches = parseOcrLines(linesFromWords(words), buildOcrCandidates(cardById.values())).map((match) => {
        const allowsAny = match.name && cardAllowsAnyNumber(cardByName.get(normalizeCardName(match.name)))
        const max = allowsAny ? Number.POSITIVE_INFINITY : MAX_COPIES
        return match.quantity > max ? { ...match, quantity: max } : match
      })
      if (matches.every((match) => !match.name)) {
        setOcrError('No card names were recognised in that image.')
        return
      }
      onMatches(matches)
    } catch (error) {
      setOcrError(error instanceof Error ? error.message : 'Could not read that image.')
    } finally {
      setOcrBusy(false)
    }
  }

  function readImageFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => runOcr(String(reader.result))
    reader.readAsDataURL(file)
  }

  function handlePaste(event: React.ClipboardEvent) {
    const file = Array.from(event.clipboardData.files).find((item) => item.type.startsWith('image/'))
    if (!file) return
    event.preventDefault()
    readImageFile(file)
  }

  function handleDrop(event: React.DragEvent) {
    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/'))
    if (!file) return
    event.preventDefault()
    readImageFile(file)
  }

  return { canOcr, ocrBusy, ocrError, setOcrError, readImageFile, handlePaste, handleDrop }
}

// A clipboard write gives no visible sign it worked. Every copy action in the app
// confirms briefly, and sharing one hook keeps that timing identical everywhere.
function useCopyFeedback(duration = 1600) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), duration)
    return () => clearTimeout(timer)
  }, [copied, duration])

  return [copied, () => setCopied(true)] as const
}

// Renders a plan as readable text for the system clipboard. Sorted the same way the
// In/Out columns are, so what gets pasted matches what was on screen.
function formatPlanLines(
  entries: PlanEntry[],
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
) {
  const lines: string[] = []

  for (const [label, direction] of [['IN', 'in'], ['OUT', 'out']] as const) {
    const side = entries
      .filter((entry) => entry.direction === direction)
      .sort((a, b) => compareCardEntries(a, b, cardById, cardByName))
    if (side.length === 0) continue
    lines.push(`${label}: ${side.map((entry) => `${entry.quantity} ${entry.name}`).join('; ')}`)
  }

  return lines
}

// Archetype names reach the filename, so keep it to characters every filesystem
// accepts rather than trusting whatever was typed into a matchup name.
function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9 ,'()-]+/g, '-').trim() || 'filtered'
}

// Reads parsed MTGA games for this deck. Parsing happens in the main process, which
// is the only side that can reach the archived logs and MTGA's card database.
const ALL_GAMES = 'all'

function ReplayView({
  deck,
  allDecks,
  cardById,
  cardByName,
  onUpdateDeck,
  onUpdateMatchupDefinition,
}: {
  deck: Deck
  allDecks: Deck[]
  cardById: Map<string, CardRecord>
  cardByName: Map<string, CardRecord>
  onUpdateDeck: (updater: (deck: Deck) => Deck) => void
  // Also Seen is globally synced, so the push needs the matchup-level write rather
  // than this deck's own copy.
  onUpdateMatchupDefinition: (matchupId: string, updater: (matchup: Matchup) => Matchup) => void
}) {
  const [matches, setMatches] = useState<MtgaMatch[] | null>(null)
  const [error, setError] = useState('')
  const [selectedMatch, setSelectedMatch] = useState('')
  const [selectedGame, setSelectedGame] = useState(ALL_GAMES)
  const [search, setSearch] = useState('')
  const [showSummary, setShowSummary] = useState(true)
  const [showBoarding, setShowBoarding] = useState(true)
  const [pushed, setPushed] = useState('')
  const [activeHit, setActiveHit] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  // Line index -> element, so a hit can be scrolled to. A ref rather than state:
  // it is written during render, and reading it must not trigger another one.
  const lineRefs = useRef(new Map<number, HTMLElement>())

  // Electron has no find bar of its own, and Chromium's would only highlight —
  // a replay runs to pages, so stepping between hits is the point.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (event.key === 'Escape' && document.activeElement === searchRef.current) {
        setSearch('')
        searchRef.current?.blur()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // The push reports what it did, so the message outlives a plain copy confirmation.
  useEffect(() => {
    if (!pushed) return
    const timer = setTimeout(() => setPushed(''), 3200)
    return () => clearTimeout(timer)
  }, [pushed])

  const available = Boolean(window.electronAPI?.mtgaLoadGames)

  useEffect(() => {
    if (!available) return
    let cancelled = false

    window.electronAPI!.mtgaLoadGames(allDecks)
      .then((found) => { if (!cancelled) setMatches(found) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not read games.') })

    return () => { cancelled = true }
  }, [available, allDecks])

  if (!available) return <p className="scout-placeholder">Game replays are only available in the desktop app.</p>
  if (error) return <p className="scout-placeholder">{error}</p>
  if (!matches) return <p className="scout-placeholder">Reading archived MTGA logs…</p>

  const mine = matches.filter((match) => match.deckId === deck.id)
  const unassigned = matches.filter((match) => !match.deckId)

  if (mine.length === 0) {
    return (
      <p className="scout-placeholder">
        No games found for this deck yet.
        {unassigned.length > 0
          ? ` ${unassigned.length} match${unassigned.length === 1 ? '' : 'es'} could not be matched to any deck — play a match with this deck, or check the decklist still matches what you play on Arena.`
          : ' Play a match on Arena with Coach open and it will appear here.'}
      </p>
    )
  }

  const matchOptions = mine.map((match, index) => {
    const record = matchRecord(match.games)
    const key = match.matchId || `${match.source}:${index}`
    const archetype = deck.replayOpponents?.[key] || ''
    return {
      key,
      match,
      archetype,
      label: `${formatDate(match.playedAt)} — vs ${opponentLabel(match.opponent, archetype)} — ${record.outcome} ${record.wins}-${record.losses}`,
    }
  })

  const currentMatch = matchOptions.find((option) => option.key === selectedMatch) || matchOptions[0]
  const games = currentMatch.match.games
  // A game number held over from a previously selected match would not exist here,
  // so anything that does not resolve falls back to showing the whole match.
  const currentGame = games.find((game) => String(game.gameNumber) === selectedGame)
  const shown = currentGame ? [currentGame] : games
  const record = matchRecord(games)

  // One flat numbering across every rendered game, so a hit can be stepped to
  // without caring which game it came from.
  let lineCounter = 0
  const rendered = shown.map((game) => ({
    game,
    lines: game.events.map((event) => ({ event, index: lineCounter++ })),
  }))

  const needle = search.trim().toLowerCase()
  const hits = needle
    ? rendered.flatMap((entry) => entry.lines
      .filter((line) => line.event.text.toLowerCase().includes(needle))
      .map((line) => line.index))
    : []
  const hitPosition = hits.length > 0 ? Math.min(activeHit, hits.length - 1) : 0
  const currentHit = hits.length > 0 ? hits[hitPosition] : -1

  function stepHit(delta: number) {
    if (hits.length === 0) return
    const next = (hitPosition + delta + hits.length) % hits.length
    setActiveHit(next)
    lineRefs.current.get(hits[next])?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const matchupNames = deck.matchups.map((matchup) => matchup.name)
  const assignedArchetype = currentMatch.archetype

  // Only offered while nothing is chosen. Once categorised, the player's answer
  // stands and a second opinion on screen is just clutter.
  const guess = assignedArchetype ? null : guessArchetype(currentMatch.match, deck.matchups)

  // Built once and shared by the on-screen blocks, the decklist's seen-marking and both
  // export formats, so a file cannot disagree with the screen it was taken from.
  // Undefined while the toggle is off, which is what keeps it out of the exports.


  // Also Seen belongs to a matchup, so the push is only possible once the opponent
  // has been categorised — the archetype names which matchup these cards describe.
  const pushTarget = assignedArchetype
    ? deck.matchups.find((item) => item.name === assignedArchetype) ?? null
    : null

  // Declared after the matchup, because the boarding analysis reads its list on file.
  // Passing an empty list is not a failure case: a match with no archetype still gets
  // the game-one-only reading, which needs no list at all.
  const summaries = showSummary
    ? buildReplaySummaries(currentMatch.match, cardByName, pushTarget?.opponentEntries ?? [])
    : undefined

  // Everything the opponent was seen to hold across the match, as "Also Seen" entries.
  // Counts are the per-game maximum `observedOpponentCards` already computes, which is
  // the same rule Also Seen merges on, so the two agree by construction.
  function pushToAlsoSeen() {
    if (!pushTarget) return

    const entries: DeckEntry[] = []
    const unknown: string[] = []

    for (const [name, count] of observedOpponentCards(currentMatch.match)) {
      const card = cardByName.get(normalizeCardName(name))
      // A token is not a card in their deck — the same exclusion the summary makes.
      if (card?.isToken) continue
      // MTGA's name for a card the synced database does not know cannot become an
      // entry at all, since an entry carries a card id. Reported rather than dropped.
      if (!card) {
        unknown.push(name)
        continue
      }
      entries.push({
        id: createId('entry'),
        cardId: card.id,
        name: card.name,
        quantity: count,
        zone: 'main',
      })
    }

    if (entries.length === 0 && unknown.length === 0) {
      setPushed('Nothing seen to push.')
      return
    }

    // Merged against the matchup's current list inside the updater, never a copy read
    // out here: the merge keeps the higher count per card, so pushing the same match
    // twice is a no-op rather than a doubling.
    onUpdateMatchupDefinition(pushTarget.id, (item) => applyVariantEntries(
      item,
      mergeVariantEntries(item.opponentVariantEntries ?? [], entries),
      cardById,
      cardByName,
    ))

    const added = `Pushed ${entries.length} card${entries.length === 1 ? '' : 's'} to ${pushTarget.name}`
    setPushed(unknown.length > 0
      ? `${added} — ${unknown.length} unrecognised: ${unknown.join('; ')}`
      : `${added}.`)
  }

  // Shares the summary toggle and the push's archetype gate: without an archetype there
  // is no way to know whose list to show, on screen or in a file.
  const decklist = summaries && pushTarget
    ? buildReplayDecklist(pushTarget, cardById, cardByName)
    : undefined

  // One object for every optional block, so a file carries exactly what the toggles
  // show and no export site can forget one.
  const extras = { summaries, decklist, boarding: showBoarding }

  // Every match on file against the same archetype. Deck-scoped, like the rest of the
  // tab: the match list it draws from is this deck's.
  const sameArchetype = assignedArchetype
    ? matchOptions.filter((option) => option.archetype === assignedArchetype)
    : []

  // One .html per match, zipped. Each match gets its **own** summaries — they describe
  // what happened in that match — while the decklist is shared, being a property of the
  // archetype rather than of any one game.
  function exportArchetypeZip() {
    const files = sameArchetype.map((option) => ({
      name: replayFileName(option.match, undefined, 'html'),
      contents: buildReplayHtml(option.match, undefined, option.archetype, cardByName, {
        summaries: showSummary
          ? buildReplaySummaries(option.match, cardByName, pushTarget?.opponentEntries ?? [])
          : undefined,
        decklist,
        boarding: showBoarding,
      }),
    }))

    const stamp = new Date().toISOString().slice(0, 10)
    downloadBlob(
      `replays-vs-${safeFilePart(assignedArchetype)}-${stamp}.zip`,
      // Deduped first: two matches on one day against one opponent name the same file,
      // and a zip with duplicate names cannot be fully extracted.
      buildZip(uniqueNames(files)),
    )
  }

  const inJournal = Boolean(currentMatch.match.matchId)
    && (deck.matchLogs ?? []).some((log) => log.replayMatchId === currentMatch.match.matchId)

  // Clearing the selection removes the key rather than storing an empty string, so
  // an uncategorised match leaves nothing behind in the saved deck.
  function setArchetype(key: string, name: string) {
    onUpdateDeck((current) => {
      const next = { ...(current.replayOpponents || {}) }
      if (name) next[key] = name
      else delete next[key]
      return { ...current, replayOpponents: next }
    })
  }

  return (
    <div className="replay">
      <div className="replay-bar">
        <label className="scout-field">
          Match
          <select
            className="scout-select replay-select"
            value={currentMatch.key}
            onChange={(event) => {
              setSelectedMatch(event.target.value)
              // Games are numbered per match, so a held-over selection would point
              // at a different game entirely. Every match opens on the full replay.
              setSelectedGame(ALL_GAMES)
            }}
          >
            {matchOptions.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="scout-field">
          Game
          <select
            className="scout-select replay-game-select"
            value={currentGame ? String(currentGame.gameNumber) : ALL_GAMES}
            onChange={(event) => setSelectedGame(event.target.value)}
          >
            <option value={ALL_GAMES}>Show All Games</option>
            {games.map((game) => (
              <option key={game.gameNumber} value={String(game.gameNumber)}>
                {gameOptionLabel(game)}
              </option>
            ))}
          </select>
        </label>

        <label className="scout-field">
          Opponent deck
          <select
            className="scout-select replay-archetype-select"
            value={assignedArchetype}
            onChange={(event) => setArchetype(currentMatch.key, event.target.value)}
          >
            <option value="">Not categorised…</option>
            {matchupNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
            {/* A matchup since renamed or deleted still shows, so categorising a
                match can never be silently undone by editing the matchup list. */}
            {assignedArchetype && !matchupNames.includes(assignedArchetype) ? (
              <option value={assignedArchetype}>{assignedArchetype} (not a current matchup)</option>
            ) : null}
          </select>
        </label>

        {/* A suggestion, never an assignment: nothing is written until it is
            clicked, so opening the tab cannot quietly edit the deck. */}
        {guess ? (
          <button
            className="replay-guess"
            type="button"
            title={`${guess.cardsSeen} cards seen · ${Math.round(guess.score * 100)}% match, ${Math.round(guess.margin * 100)} points clear of the next archetype`}
            onClick={() => setArchetype(currentMatch.key, guess.name)}
          >
            <Sparkles size={13} />
            Looks like {guess.name}
            <span className="replay-guess-score">{Math.round(guess.score * 100)}%</span>
          </button>
        ) : null}

        <label className="replay-toggle" title="Show what the opponent was seen to have, and their decklist on file">
          <input
            type="checkbox"
            checked={showSummary}
            onChange={(event) => setShowSummary(event.target.checked)}
          />
          Summary
        </label>

        {/* Separate from Summary on purpose: one is about them and is inferred, the
            other is about us and is exact, and they are wanted at different times. */}
        <label className="replay-toggle" title="Show what you boarded in and out before each game">
          <input
            type="checkbox"
            checked={showBoarding}
            onChange={(event) => setShowBoarding(event.target.checked)}
          />
          My sideboarding
        </label>

        <label className="scout-field replay-find-field">
          Find
          <input
            ref={searchRef}
            className="scout-select replay-find"
            type="search"
            value={search}
            // Short enough never to truncate: the field is narrow, and the "Find"
            // label beside it already says what it is for.
            placeholder="Search…"
            title="Search this replay (Ctrl+F)"
            onChange={(event) => { setSearch(event.target.value); setActiveHit(0) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              stepHit(event.shiftKey ? -1 : 1)
            }}
          />
          {needle ? (
            <span className="replay-find-count">
              {hits.length === 0 ? 'no matches' : `${hitPosition + 1} of ${hits.length}`}
            </span>
          ) : null}
          {hits.length > 1 ? (
            <>
              <button className="tiny-button" type="button" title="Previous match (Shift+Enter)" onClick={() => stepHit(-1)}>↑</button>
              <button className="tiny-button" type="button" title="Next match (Enter)" onClick={() => stepHit(1)}>↓</button>
            </>
          ) : null}
        </label>

        {/* Showing the whole match offers every game's export alongside the match's,
            so a single game can be pulled out without first narrowing to it. */}
        <div className="replay-actions">
          {/* Dedup is on the MTGA matchID, so the same match cannot be added twice
              however it is reached — from here or from the Journal's own import. */}
          <button
            className="secondary-button"
            type="button"
            disabled={inJournal}
            title={inJournal
              ? 'This match is already in the Journal'
              : 'Add this match to the Journal with its results and play/draw filled in'}
            onClick={() => onUpdateDeck((current) => addMatchLogs(current, [
              matchLogFromReplay(currentMatch.match, assignedArchetype, {
                cardByName,
                opponentEntries: pushTarget?.opponentEntries ?? [],
                // Follows the toggle, so the notes carry exactly what the tab shows.
                ownBoarding: showBoarding,
              }),
            ]))}
          >
            <BookOpen size={15} />
            {inJournal ? 'In Journal' : 'To Journal'}
          </button>

          <button
            className="secondary-button"
            type="button"
            disabled={!pushTarget}
            title={pushTarget
              ? `Add every card seen this match to ${pushTarget.name}'s Also Seen list`
              : assignedArchetype
                ? `"${assignedArchetype}" is not a current matchup, so there is nowhere to push these cards`
                : 'Pick the opponent deck first — Also Seen belongs to a matchup'}
            onClick={pushToAlsoSeen}
          >
            <Layers size={15} />
            To Also Seen
          </button>

          {/* Shown whenever an archetype is assigned, even for a single match. Hiding
              it below two would mean knowing how many matches are on file before
              knowing whether the control exists — the count on the button is how you
              find that out. */}
          {sameArchetype.length > 0 ? (
            <button
              className="secondary-button"
              type="button"
              title={`Download every match against ${assignedArchetype} as one zip of HTML files`}
              onClick={exportArchetypeZip}
            >
              <Archive size={15} />
              All vs {assignedArchetype} ({sameArchetype.length})
            </button>
          ) : null}

          <ReplayExportPair
            label="Match"
            copyTitle="Copy every game of this match as text"
            downloadTitle="Download the whole match as a .txt file"
            text={() => buildReplayText(currentMatch.match, undefined, assignedArchetype, extras)}
            html={() => buildReplayHtml(currentMatch.match, undefined, assignedArchetype, cardByName, extras)}
            filename={(ext) => replayFileName(currentMatch.match, undefined, ext)}
          />
          {shown.map((game) => (
            <ReplayExportPair
              key={game.gameNumber}
              label={`Game ${game.gameNumber}`}
              copyTitle={`Copy game ${game.gameNumber} as text`}
              downloadTitle={`Download game ${game.gameNumber} as a .txt file`}
              text={() => buildReplayText(currentMatch.match, game, assignedArchetype, extras)}
              html={() => buildReplayHtml(currentMatch.match, game, assignedArchetype, cardByName, extras)}
              filename={(ext) => replayFileName(currentMatch.match, game, ext)}
            />
          ))}
        </div>
      </div>

      {pushed ? <p className="replay-pushed">{pushed}</p> : null}

      <div className="replay-body">
        <header className="replay-header">
          <span className={`replay-verdict${verdictClass(currentGame ? currentGame.won : recordVerdict(record))}`}>
            {currentGame
              ? (currentGame.won === null ? 'Unfinished' : currentGame.won ? 'Won' : 'Lost')
              : `${record.wins}-${record.losses}`}
          </span>
          <span className="replay-meta">
            {currentGame
              ? `Game ${currentGame.gameNumber}${describeStart(currentGame) ? ` · ${describeStart(currentGame)}` : ''} · ${currentGame.maxTurn} turns`
              : `${games.length} game${games.length === 1 ? '' : 's'}`}
            {` · vs ${opponentLabel(currentMatch.match.opponent, assignedArchetype)}`}
            {currentMatch.match.matchWinCondition
              ? ` · ${formatMatchFormat(currentMatch.match.matchWinCondition)}`
              : ''}
            {describeEndReason(currentMatch.match.completedReason)
              ? ` · ended by ${describeEndReason(currentMatch.match.completedReason)}`
              : ''}
          </span>
        </header>

        {/* Across the whole match, not per game: the counts are the highest seen in
            any one game rather than a sum, since casting Opt in both games is
            evidence of one or two copies, never four. */}
        {summaries && games.length > 1 ? (
          <OpponentSummary summary={summaries.match} cardByName={cardByName} className=" is-match" />
        ) : null}

        {/* The list on file for whoever they were playing, beside what they showed of
            it. Needs the archetype for the same reason the push does: it is what says
            which matchup's list this is. */}
        {summaries && decklist ? (
          <MatchupDecklist decklist={decklist} seen={summaries.match.cards} cardByName={cardByName} />
        ) : null}

        <div className="replay-log">
          {rendered.map(({ game, lines }) => (
            <Fragment key={game.gameNumber}>
              {/* Only when several games run together: with one game on screen the
                  header above already names it, and this would merely repeat it. */}
              {shown.length > 1 ? (
                <h2 className="replay-game-heading">
                  Game {game.gameNumber}
                  {describeStart(game) ? (
                    <span className="replay-game-start">{describeStart(game)}</span>
                  ) : null}
                  <span className={`replay-game-verdict${verdictClass(game.won)}`}>
                    {game.won === null ? 'unfinished' : game.won ? 'won' : 'lost'}
                    {describeEndReason(game.endReason) ? ` by ${describeEndReason(game.endReason)}` : ''}
                    {` · ${game.maxTurn} turns`}
                  </span>
                </h2>
              ) : null}
              {showBoarding ? <MySideboarding game={game} cardByName={cardByName} /> : null}
              {summaries?.games.get(game.gameNumber) ? (
                <OpponentSummary summary={summaries.games.get(game.gameNumber)!} cardByName={cardByName} />
              ) : null}
              {lines.map(({ event, index }) => {
                const hit = Boolean(needle) && event.text.toLowerCase().includes(needle)
                const marks = hit ? ` replay-hit${index === currentHit ? ' is-current' : ''}` : ''
                const keep = (node: HTMLElement | null) => {
                  if (node) lineRefs.current.set(index, node)
                  else lineRefs.current.delete(index)
                }

                return event.kind === 'turn'
                  ? <h3 className={`replay-turn${marks}`} key={index} ref={keep}>{event.text}</h3>
                  : (
                    <p className={`replay-event replay-${event.kind}${marks}`} key={index} ref={keep}>
                      <ReplayText event={event} cardByName={cardByName} />
                    </p>
                  )
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}

// Date and opponent are already on the match picker beside this one, so the game
// options carry only what distinguishes them.
// What the opponent was seen to have, at the top of whatever it describes — the
// question you open a replay with, rather than something to scroll to. Used for a
// single game and for the match, which differ only in the counts handed to it.
//
// Tokens are excluded: a Treasure they made is not a card in their deck, and this
// list is about the deck.
function OpponentSummary({ summary, cardByName, className = '' }: {
  summary: ReplaySummary
  cardByName: Map<string, CardRecord>
  className?: string
}) {
  if (summary.cards.length === 0 && !summary.boarded) return null

  return (
    <>
      {summary.cards.length > 0 ? (
        <div className={`replay-summary${className}`}>
          <span className="replay-summary-label">{summary.label}</span>
          <span className="replay-summary-cards">
            {summary.cards.map(([name, count]) => (
              <ReplayCardName
                key={name}
                name={summaryCardLabel(name, count)}
                card={cardByName.get(normalizeCardName(name))}
              />
            ))}
          </span>
        </div>
      ) : null}

      {/* A sibling block rather than a second row inside the first: the two make
          different claims, one observed and one inferred, and they should not read as
          one list. */}
      {summary.boarded ? (
        <div className="replay-summary is-boarded" title={summary.boarded.basis}>
          <span className="replay-summary-label">{summary.boarded.label}</span>
          <span className="replay-summary-cards">
            {summary.boarded.cards.map((entry) => (
              <ReplayCardName
                key={entry.name}
                name={`${summaryCardLabel(entry.name, entry.count)}${entry.unlisted ? ' *' : ''}`}
                card={cardByName.get(normalizeCardName(entry.name))}
                className={entry.unlisted ? 'is-unlisted' : ''}
              />
            ))}
          </span>
          {summary.boarded.note ? (
            <span className="replay-summary-note">{summary.boarded.note}</span>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

// The opponent's list as it stands on file, for reference beside what they actually
// showed. The seen summary answers "what did they have"; this answers "what else do
// they have" — the gap is the whole point, and against a 75-card list it is most of it.
//
// Collapsed by default: a replay is opened to read the narration, and a full decklist
// above it would push that down the screen every time. The header still states the
// counts, so a list on file is never invisible.
// Prepared once and handed to both the on-screen block and the exports, so a file
// cannot list the deck differently from the tab it came from. Grouped and sorted by
// the same helpers the Plans panel and the clipboard exports use, so no two renderings
// of the same cards can come out in a different order.
//
// Built here rather than in replayExport.ts because the type grouping lives here; it
// crosses over as plain data, leaving the exporters knowing nothing about decks.
function buildReplayDecklist(
  matchup: Matchup,
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
): ReplayDecklist | undefined {
  const entries = matchup.opponentEntries ?? []
  const main = entries.filter((entry) => entry.zone === 'main')
  const sideboard = entries.filter((entry) => entry.zone === 'sideboard')
  const alsoSeen = computeAlsoSeenEntries(entries, matchup.opponentVariantEntries ?? [])

  if (main.length === 0 && sideboard.length === 0 && alsoSeen.length === 0) return undefined

  const total = (list: DeckEntry[]) => list.reduce((sum, entry) => sum + entry.quantity, 0)
  const cards = (list: DeckEntry[]): Array<[string, number]> =>
    list.map((entry) => [entry.name, entry.quantity])

  const sections = groupEntriesByType(main, cardById, cardByName)
    .map(({ group, entries: section }) => ({
      heading: `${group} (${total(section)})`,
      cards: cards(section),
    }))

  if (sideboard.length > 0) {
    sections.push({
      heading: `Sideboard (${total(sideboard)})`,
      cards: cards(sortEntriesForExport(sideboard, cardById, cardByName)),
    })
  }
  if (alsoSeen.length > 0) {
    sections.push({
      heading: `Also Seen (${total(alsoSeen)})`,
      cards: cards(sortEntriesForExport(alsoSeen, cardById, cardByName)),
    })
  }

  return {
    label: `${matchup.name} decklist`,
    counts: [
      `${total(main)} main`,
      sideboard.length > 0 ? `${total(sideboard)} sideboard` : '',
      alsoSeen.length > 0 ? `${total(alsoSeen)} also seen` : '',
    ].filter(Boolean).join(' · '),
    sections,
  }
}

function MatchupDecklist({ decklist, seen, cardByName }: {
  decklist: ReplayDecklist
  seen: Array<[string, number]>
  cardByName: Map<string, CardRecord>
}) {
  const [open, setOpen] = useState(false)

  // Marked against the names seen this match, so the list reads as "of everything they
  // run, this is what I faced". Normalised on both sides because MTGA's name for a card
  // need not match the database's spelling.
  const seenNames = new Set(seen.map(([name]) => normalizeCardName(name)))

  return (
    <div className="replay-decklist">
      <button className="replay-decklist-toggle" type="button" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="replay-summary-label">{decklist.label}</span>
        <span className="replay-decklist-counts">{decklist.counts}</span>
      </button>

      {open ? (
        <div className="replay-decklist-body">
          {decklist.sections.map((section) => (
            <div className="replay-decklist-section" key={section.heading}>
              <span className="replay-decklist-heading">{section.heading}</span>
              <span className="replay-summary-cards">
                {section.cards.map(([name, quantity]) => (
                  <ReplayCardName
                    key={name}
                    name={`${quantity} ${name}`}
                    card={cardByName.get(normalizeCardName(name))}
                    className={seenNames.has(normalizeCardName(name)) ? 'is-seen' : ''}
                  />
                ))}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// What we boarded before this game, read from our own deck submission. Stated plainly
// — unlike the opponent's block, which can only ever say "possibly", this is our own
// list before and after, so there is nothing to hedge.
function MySideboarding({ game, cardByName }: {
  game: MtgaGame
  cardByName: Map<string, CardRecord>
}) {
  if (!game.sideboarding) return null

  const row = (label: string, cards: Array<{ name: string; count: number }>) => {
    if (cards.length === 0) return null
    const copies = cards.reduce((sum, card) => sum + card.count, 0)
    return (
      <>
        <span className="replay-summary-label">
          {label} — {copies} card{copies === 1 ? '' : 's'}
        </span>
        <span className="replay-summary-cards">
          {cards.map((card) => (
            <ReplayCardName
              key={card.name}
              name={summaryCardLabel(card.name, card.count)}
              card={cardByName.get(normalizeCardName(card.name))}
            />
          ))}
        </span>
      </>
    )
  }

  const boardedIn = row('You boarded in', game.sideboarding.in)
  const boardedOut = row('You boarded out', game.sideboarding.out)
  if (!boardedIn && !boardedOut) return null

  return (
    <div className="replay-summary is-mine">
      {boardedIn}
      {boardedOut}
    </div>
  )
}

function gameOptionLabel(game: MtgaGame) {
  const outcome = game.won === null ? '' : game.won ? ' (won)' : ' (lost)'
  return `Game ${game.gameNumber}${outcome}`
}

function recordVerdict(record: { outcome: string }) {
  if (record.outcome === 'won') return true
  if (record.outcome === 'lost') return false
  return null
}

function verdictClass(won: boolean | null) {
  if (won === true) return ' is-win'
  if (won === false) return ' is-loss'
  return ''
}

// One copy/download pair. Each instance owns its own confirmation, which is what
// lets the all-games view show four of them without one press lighting up the rest.
function ReplayExportPair({ label, copyTitle, downloadTitle, text, filename, html }: {
  label: string
  copyTitle: string
  downloadTitle: string
  text: () => string
  filename: (extension: string) => string
  html: () => string
}) {
  const [copied, markCopied] = useCopyFeedback()

  return (
    <span className="replay-action-group">
      <span className="replay-action-label">{label}</span>
      <button
        className="secondary-button"
        type="button"
        title={copyTitle}
        onClick={() => { navigator.clipboard.writeText(text()); markCopied() }}
      >
        <Clipboard size={15} />
        {copied ? 'Copied' : 'Copy'}
      </button>
      {/* One download, and it is the HTML: colours, per-kind styling and working
          card previews. There is no .txt download because Copy already puts the
          plain text on the clipboard — a second file would only be the same words
          with less in them. */}
      <button
        className="icon-button"
        type="button"
        title={`${downloadTitle} — keeps colours and card previews`}
        onClick={() => downloadFile(filename('html'), html(), 'text/html')}
      >
        <Download size={15} />
      </button>
    </span>
  )
}

// Card names inside a narration line become hoverable, reusing the same preview box
// the deck columns use. The names come from the event's own card fields rather than
// being searched for across the whole database: the parser already knows exactly
// which cards it named, so there is nothing to guess and no risk of a stray word in
// the prose lighting up as a card.
function ReplayText({ event, cardByName }: { event: MtgaGameEvent; cardByName: Map<string, CardRecord> }) {
  const names = useMemo(() => {
    const named = [...(event.cards ?? []), ...(event.card ? [event.card] : [])].filter(Boolean)
    // Longest first, so a name containing a shorter one is matched whole.
    return [...new Set(named)].sort((a, b) => b.length - a.length)
  }, [event])

  if (names.length === 0) return <>{event.text}</>

  const parts: ReactNode[] = []
  let plain = ''
  let at = 0

  while (at < event.text.length) {
    const hit = names.find((name) => event.text.startsWith(name, at))
    if (!hit) {
      plain += event.text[at]
      at += 1
      continue
    }
    if (plain) {
      parts.push(plain)
      plain = ''
    }
    parts.push(<ReplayCardName name={hit} card={cardByName.get(normalizeCardName(hit))} key={parts.length} />)
    at += hit.length
  }
  if (plain) parts.push(plain)

  return <>{parts}</>
}

function ReplayCardName({ name, card, className = '' }: {
  name: string
  card?: CardRecord
  className?: string
}) {
  const [previewStyle, setPreviewStyle] = useState<CSSProperties | undefined>(undefined)
  const previewImages = getPreviewImages(card)

  // A card the database does not know has no image to show, so it stays plain text
  // rather than advertising a hover that would open an empty box. It keeps the class
  // either way, so a marked card does not lose its marking for want of an image.
  if (previewImages.length === 0) return <span className={className}>{name}</span>

  return (
    <span
      className={`replay-card${className ? ` ${className}` : ''}`}
      onPointerEnter={(hover) => setPreviewStyle(getPreviewPosition(hover.currentTarget, 'right', card))}
    >
      {name}
      <span className="card-preview" style={previewStyle} role="presentation">
        {previewImages.map((imageUrl) => <img src={imageUrl} alt="" loading="lazy" key={imageUrl} />)}
      </span>
    </span>
  )
}

function JournalView({
  deck,
  cardByName,
  onUpdateDeck,
  standalone,
}: {
  deck: Deck
  // Needed to pre-fill imported notes: the opponent's boarding analysis drops tokens
  // and lands, which it cannot do without knowing what a card is.
  cardByName: Map<string, CardRecord>
  onUpdateDeck: (updater: (deck: Deck) => Deck) => void
  standalone?: boolean
}) {
  // Loaded here rather than handed down, so the popped-out Journal window — which
  // has no workspace around it — can import too.
  const [replayMatches, setReplayMatches] = useState<MtgaMatch[]>([])

  useEffect(() => {
    if (!window.electronAPI?.mtgaLoadGames) return
    let cancelled = false

    window.electronAPI.mtgaLoadGames([deck])
      .then((found) => {
        if (!cancelled) setReplayMatches(found.filter((match) => match.deckId === deck.id))
      })
      .catch(() => { /* the Journal works without it; the Replay tab reports failures */ })

    return () => { cancelled = true }
  }, [deck])

  const importable = replayMatchesToImport(deck, replayMatches)

  function importFromReplay() {
    onUpdateDeck((current) => addMatchLogs(current, replayMatchesToImport(current, replayMatches).map(
      (match) => {
        const archetype = current.replayOpponents?.[match.matchId ?? ''] ?? ''
        return matchLogFromReplay(match, archetype, {
          cardByName,
          opponentEntries: current.matchups.find((item) => item.name === archetype)?.opponentEntries ?? [],
          // No toggle on this side of the app, so it follows the Replay tab's default.
          ownBoarding: true,
        })
      },
    )))
  }

  const matchLogs = deck.matchLogs ?? []
  const matchupNames = [...deck.matchups].map((m) => m.name).sort((a, b) => a.localeCompare(b))
  const [showStats, setShowStats] = useState(false)
  const [notesOpen, setNotesOpen] = useState(true)
  const [opponentFilter, setOpponentFilter] = useState('')
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  // Ctrl+F is intercepted because Chromium's own find skips the contents of form
  // controls — every note here lives in a textarea, so a native find would match
  // nothing. Searching the underlying data is the only thing that actually works.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (event.key === 'Escape' && document.activeElement === searchRef.current) {
        setSearch('')
        searchRef.current?.blur()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Built from the matches actually logged, not the deck's matchup list, so every
  // option has something behind it — including archetypes typed before the opponent
  // field became a dropdown, and blank ones bucketed as "Unspecified".
  const archetypeOf = (match: MatchLog) => match.opponent.trim() || UNSPECIFIED_OPPONENT
  const archetypeCounts = new Map<string, number>()
  matchLogs.forEach((match) => {
    const key = archetypeOf(match)
    archetypeCounts.set(key, (archetypeCounts.get(key) ?? 0) + 1)
  })
  // Keep a selected archetype listed even once its last match is deleted, so the
  // dropdown never shows a blank value with the filter still applied.
  if (opponentFilter && !archetypeCounts.has(opponentFilter)) archetypeCounts.set(opponentFilter, 0)
  const archetypeOptions = Array.from(archetypeCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  const query = search.trim().toLowerCase()
  const gameMatchesSearch = (game: GameLog) => query.length > 0 && game.notes.toLowerCase().includes(query)
  const matchesSearch = (match: MatchLog) =>
    match.opponent.toLowerCase().includes(query) || match.games.some((game) => game.notes.toLowerCase().includes(query))

  const visibleMatches = matchLogs
    .filter((match) => !opponentFilter || archetypeOf(match) === opponentFilter)
    .filter((match) => !query || matchesSearch(match))
  // Undefined notes fall through to the prompts, so they are there to write under
  // without ever being written to storage until something is actually typed.
  const notes = deck.journalNotes ?? JOURNAL_NOTES_PROMPTS
  // The notes box is always on screen, so rather than filtering it, just say when
  // the term is in there too — otherwise a hit in General Notes looks like no hit.
  const notesMatchSearch = query.length > 0 && notes.toLowerCase().includes(query)

  function addMatch() {
    const newMatch: MatchLog = {
      id: createId('match'),
      opponent: '',
      date: new Date().toISOString(),
      games: [{ id: createId('game'), result: '', notes: '' }],
    }
    onUpdateDeck((d) => ({ ...d, matchLogs: [newMatch, ...(d.matchLogs ?? [])], updatedAt: new Date().toISOString() }))
  }

  function updateMatch(matchId: string, updater: (m: MatchLog) => MatchLog) {
    onUpdateDeck((d) => ({
      ...d,
      matchLogs: (d.matchLogs ?? []).map((m) => (m.id === matchId ? updater(m) : m)),
      updatedAt: new Date().toISOString(),
    }))
  }

  function deleteMatch(matchId: string) {
    if (!confirmAction('Delete this match?')) return
    onUpdateDeck((d) => ({
      ...d,
      matchLogs: (d.matchLogs ?? []).filter((m) => m.id !== matchId),
      updatedAt: new Date().toISOString(),
    }))
  }

  return (
    <div className="journal">
      <div className="journal-toolbar">
        <button className="primary-button" type="button" onClick={addMatch}>
          <Plus size={16} />
          New Match
        </button>
        {/* Only offered when there is something new to bring in: matches already
            imported are filtered out by their matchID, so the count is the honest
            number and pressing it can never duplicate anything. */}
        {importable.length > 0 ? (
          <button
            className="secondary-button"
            type="button"
            title="Add matches played on Arena that are not in this journal yet"
            onClick={importFromReplay}
          >
            <BookOpen size={16} />
            Import from Replay ({importable.length})
          </button>
        ) : null}
        {!standalone && window.electronAPI?.openJournalWindow ? (
          <button
            className="secondary-button"
            type="button"
            title="Open the journal in its own window"
            onClick={() => window.electronAPI?.openJournalWindow(deck.id)}
          >
            <ExternalLink size={16} />
            Pop Out
          </button>
        ) : null}
        <button
          className="secondary-button"
          type="button"
          title="Win rates for this deck"
          disabled={matchLogs.length === 0}
          onClick={() => setShowStats(true)}
        >
          <BarChart2 size={16} />
          Stats
        </button>
        <button
          className="secondary-button"
          type="button"
          title="Export the full journal as a text file"
          disabled={matchLogs.length === 0}
          onClick={() => downloadFile(`${deck.name} Journal.txt`, buildJournalText(deck), 'text/plain')}
        >
          <Download size={16} />
          Export
        </button>
      </div>
      <section className="journal-notes-panel">
        <header className="journal-notes-header" onClick={() => setNotesOpen((open) => !open)}>
          <span className="journal-notes-title">
            <ChevronDown size={14} className={`opponent-chevron ${notesOpen ? '' : 'collapsed'}`} />
            General Notes
          </span>
          {notesOpen && notes !== JOURNAL_NOTES_PROMPTS ? (
            <button
              className="icon-button tiny"
              type="button"
              title="Restore the prompt questions"
              onClick={(event) => {
                event.stopPropagation()
                if (confirmAction('Replace these notes with the prompt questions?')) {
                  onUpdateDeck((d) => ({ ...d, journalNotes: JOURNAL_NOTES_PROMPTS, updatedAt: new Date().toISOString() }))
                }
              }}
            >
              <RotateCcw size={14} />
            </button>
          ) : null}
        </header>
        {notesOpen ? (
          <AutoGrowTextarea
            className="journal-notes"
            value={notes}
            onChange={(value) => onUpdateDeck((d) => ({ ...d, journalNotes: value, updatedAt: new Date().toISOString() }))}
            placeholder="General notes for this deck"
            maxLines={18}
          />
        ) : null}
      </section>
      {showStats ? <JournalStatsModal deck={deck} onClose={() => setShowStats(false)} /> : null}


      {matchLogs.length > 0 ? (
        <div className="journal-filter">
          <label className="search-field journal-search">
            <Search size={16} />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search notes (Ctrl+F)"
              spellCheck={false}
            />
          </label>
          <label className="scout-field">
            Matchup
            <select className="scout-select" value={opponentFilter} onChange={(event) => setOpponentFilter(event.target.value)}>
              <option value="">All matchups ({matchLogs.length})</option>
              {archetypeOptions.map(([name, count]) => (
                <option key={name} value={name}>{name} ({count})</option>
              ))}
            </select>
          </label>
          {opponentFilter ? (
            <>
              {visibleMatches.length > 0 ? (
                <button
                  className="secondary-button"
                  type="button"
                  title={`Export only the ${visibleMatches.length} ${opponentFilter} match${visibleMatches.length === 1 ? '' : 'es'}`}
                  onClick={() => downloadFile(
                    `${deck.name} Journal - ${safeFilePart(opponentFilter)}.txt`,
                    // A deck-shaped copy carrying only the filtered matches, so the
                    // summary header reports the record against this archetype alone.
                    buildJournalText({ ...deck, matchLogs: visibleMatches }, new Date(), opponentFilter),
                    'text/plain',
                  )}
                >
                  <Download size={15} />
                  Export filtered ({visibleMatches.length})
                </button>
              ) : null}
              <button className="secondary-button" type="button" onClick={() => setOpponentFilter('')}>
                <Eraser size={15} />
                Clear filter
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {query && notesMatchSearch ? (
        <p className="journal-search-note">&ldquo;{search.trim()}&rdquo; also appears in General Notes above.</p>
      ) : null}

      {matchLogs.length === 0 ? (
        <p className="journal-empty">No matches logged yet. Hit New Match to start tracking.</p>
      ) : visibleMatches.length === 0 ? (
        <p className="journal-empty">
          {query
            ? `Nothing matching "${search.trim()}"${opponentFilter ? ` against ${opponentFilter}` : ''}.`
            : `No matches logged against ${opponentFilter} yet.`}
        </p>
      ) : (
        <div className="match-list">
          {visibleMatches.map((match) => (
            <MatchEntry
              key={match.id}
              match={match}
              matchupNames={matchupNames}
              isGameMatch={gameMatchesSearch}
              onUpdate={(updater) => updateMatch(match.id, updater)}
              onDelete={() => deleteMatch(match.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MatchEntry({
  match,
  matchupNames,
  isGameMatch,
  onUpdate,
  onDelete,
}: {
  match: MatchLog
  matchupNames: string[]
  isGameMatch?: (game: GameLog) => boolean
  onUpdate: (updater: (m: MatchLog) => MatchLog) => void
  onDelete: () => void
}) {
  function addGame() {
    onUpdate((m) => ({ ...m, games: [...m.games, { id: createId('game'), result: '', notes: '' }] }))
  }

  function updateGame(gameId: string, updater: (g: GameLog) => GameLog) {
    onUpdate((m) => ({ ...m, games: m.games.map((g) => (g.id === gameId ? updater(g) : g)) }))
  }

  function removeGame(gameId: string) {
    onUpdate((m) => ({ ...m, games: m.games.filter((g) => g.id !== gameId) }))
  }

  const wins = match.games.filter((g) => g.result === 'win').length
  const losses = match.games.filter((g) => g.result === 'loss').length
  const hasRecord = wins > 0 || losses > 0

  return (
    <div className="match-entry">
      <div className="match-header">
        <span className="match-vs">vs.</span>
        <select
          className="match-opponent"
          value={match.opponent}
          onChange={(e) => onUpdate((m) => ({ ...m, opponent: e.target.value }))}
        >
          <option value="">Opponent deck…</option>
          {matchupNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
          {/* Keep whatever an older free-text entry held, or a since-renamed or
              deleted matchup, so selecting nothing never silently drops history. */}
          {match.opponent && !matchupNames.includes(match.opponent) ? (
            <option value={match.opponent}>{match.opponent} (not a current matchup)</option>
          ) : null}
        </select>
        {hasRecord ? <span className="match-record">{wins}-{losses}</span> : null}
        <span className="match-date">{formatDate(match.date)}</span>
        <button className="icon-button tiny" type="button" onClick={onDelete} title="Delete match">
          <Trash2 size={14} />
        </button>
      </div>
      <div className="match-games">
        {match.games.map((game, index) => (
          <div key={game.id} className={`game-row${isGameMatch?.(game) ? ' game-row-hit' : ''}`}>
            <span className="game-label">Game {index + 1}</span>
            <select
              className={`game-result game-result-${game.result || 'empty'}`}
              value={game.result}
              onChange={(e) => updateGame(game.id, (g) => ({ ...g, result: e.target.value as MatchResult | '' }))}
            >
              <option value="">—</option>
              <option value="win">Win</option>
              <option value="loss">Loss</option>
              <option value="draw">Draw</option>
            </select>
            {(() => {
              const inferred = inferGameStart(match.games, index)
              const value = game.start ?? inferred
              const isAuto = !game.start && Boolean(inferred)
              return (
                <select
                  className={`game-result game-start${isAuto ? ' is-auto' : ''}`}
                  value={value}
                  title={isAuto
                    ? 'Set from the previous game — the loser chooses, and usually plays'
                    : 'On the play or on the draw'}
                  onChange={(e) => updateGame(game.id, (g) => ({
                    ...g,
                    start: (e.target.value || undefined) as 'play' | 'draw' | undefined,
                  }))}
                >
                  {/* Blank is only offered where nothing can be inferred — game one,
                      or when the previous game has no result yet. */}
                  {inferred ? null : <option value="">—</option>}
                  <option value="play">Play</option>
                  <option value="draw">Draw</option>
                </select>
              )
            })()}
            <AutoGrowTextarea
              className="game-notes"
              value={game.notes}
              onChange={(notes) => updateGame(game.id, (g) => ({ ...g, notes }))}
              placeholder="Notes…"
              maxLines={10}
            />
            {match.games.length > 1 ? (
              <button className="icon-button tiny" type="button" onClick={() => removeGame(game.id)} title="Remove game">
                <Trash2 size={13} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <button className="add-game-button" type="button" onClick={addGame}>
        <Plus size={14} />
        Add Game
      </button>
    </div>
  )
}

function AutoGrowTextarea({
  className,
  onChange,
  placeholder,
  value,
  maxLines = 10,
}: {
  className: string
  onChange: (value: string) => void
  placeholder: string
  value: string
  maxLines?: number
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const lastWidth = useRef(0)

  const resize = useCallback(() => {
    const textarea = ref.current
    if (!textarea) return

    const styles = window.getComputedStyle(textarea)
    // A `line-height: normal` computes to the string "normal", not a length, so
    // fall back to a ratio of the font size rather than letting NaN through.
    const lineHeight = Number.parseFloat(styles.lineHeight) || Number.parseFloat(styles.fontSize) * 1.35
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
    const borderHeight = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth)
    const maxHeight = lineHeight * maxLines + verticalPadding + borderHeight

    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [maxLines])

  useEffect(() => { resize() }, [value, resize])

  // Widening the box rewraps the text onto fewer lines, but the height measured at
  // the old width stays applied and leaves dead space below. Re-measure whenever the
  // width changes — window resize, maximise, a panel opening beside it.
  useEffect(() => {
    const textarea = ref.current
    if (!textarea || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      // Height changes are this component's own doing; reacting to them would loop.
      if (width === lastWidth.current) return
      lastWidth.current = width
      resize()
    })

    observer.observe(textarea)
    return () => observer.disconnect()
  }, [resize])

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onChange(event.target.value)
  }

  return <textarea ref={ref} className={className} value={value} onChange={handleChange} placeholder={placeholder} rows={1} />
}

function PlanColumns({
  section,
  cardsIn,
  cardsOut,
  cardById,
  cardByName,
  onQuantity,
}: {
  section: PlanSection
  cardsIn: PlanEntry[]
  cardsOut: PlanEntry[]
  cardById: Map<string, CardRecord>
  cardByName: Map<string, CardRecord>
  onQuantity: (section: PlanSection, entryId: string, delta: number) => void
}) {
  return (
    <div className="plan-columns">
      <PlanDropZone section={section} direction="in" entries={cardsIn} icon={<ArrowDownToLine size={18} />} cardById={cardById} cardByName={cardByName} onQuantity={onQuantity} />
      <PlanDropZone section={section} direction="out" entries={cardsOut} icon={<ArrowUpFromLine size={18} />} cardById={cardById} cardByName={cardByName} onQuantity={onQuantity} />
    </div>
  )
}

function PlanDropZone({
  section,
  direction,
  entries,
  icon,
  cardById,
  cardByName,
  onQuantity,
}: {
  section: PlanSection
  direction: PlanDirection
  entries: PlanEntry[]
  icon: React.ReactNode
  cardById: Map<string, CardRecord>
  cardByName: Map<string, CardRecord>
  onQuantity: (section: PlanSection, entryId: string, delta: number) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: getPlanDropId(section, direction) })
  const sortedEntries = [...entries].sort((left, right) =>
    compareCardEntries(left, right, cardById, cardByName),
  )

  return (
    <section ref={setNodeRef} className={`plan-zone ${isOver ? 'over' : ''}`}>
      <header className="zone-header">
        <h2>
          {direction === 'in' ? 'In' : 'Out'}
          <span className="plan-total">{entries.reduce((total, entry) => total + entry.quantity, 0)}</span>
        </h2>
        {icon}
      </header>
      <div className="card-list">
        {sortedEntries.map((entry) => (
          <PlanRow
            key={entry.id}
            entry={entry}
            card={findCardForEntry(entry, cardById, cardByName)}
            previewPlacement={direction === 'out' ? 'left' : 'right'}
            onQuantity={(entryId, delta) => onQuantity(section, entryId, delta)}
          />
        ))}
      </div>
    </section>
  )
}

function PlanRow({
  entry,
  card,
  previewPlacement,
  onQuantity,
}: {
  entry: PlanEntry
  card?: CardRecord
  previewPlacement: PreviewPlacement
  onQuantity: (entryId: string, delta: number) => void
}) {
  const [previewStyle, setPreviewStyle] = useState<CSSProperties>({})

  return (
    <div
      className="card-row plan-row"
      onPointerEnter={(event) => setPreviewStyle(getPreviewPosition(event.currentTarget, previewPlacement, card))}
      onClick={() => onQuantity(entry.id, -1)}
      title="Click to decrease"
    >
      <CardDetails name={entry.name} card={card} previewStyle={previewStyle} />
      {/* Same −/count/+ group the deck columns use: one grid cell, hover-revealed
          buttons, count in the middle. Stepping to zero removes the entry, so no
          separate delete control is needed. */}
      <div className="entry-quantity" onClick={(e) => e.stopPropagation()}>
        <button className="tiny-button entry-qty-btn" type="button" onClick={() => onQuantity(entry.id, -1)} title="Remove one">
          −
        </button>
        <span className="quantity">{entry.quantity}</span>
        <button className="tiny-button entry-qty-btn" type="button" onClick={() => onQuantity(entry.id, 1)} title="Add one">
          +
        </button>
      </div>
    </div>
  )
}

function OpponentCardRow({
  entry,
  cardById,
  cardByName,
  highlighted,
  onQuantity,
  maxQuantity,
  flagged,
}: {
  entry: DeckEntry
  cardById: Map<string, CardRecord>
  cardByName: Map<string, CardRecord>
  highlighted?: boolean
  onQuantity?: (delta: number) => void
  maxQuantity?: number
  flagged?: boolean
}) {
  const [previewStyle, setPreviewStyle] = useState<CSSProperties>({})
  const card = findCardForEntry(entry, cardById, cardByName)

  return (
    <div
      className={`card-row opponent-card-row${highlighted ? ' opponent-card-highlight' : ''}${
        flagged ? ' copy-violation' : ''
      }${onQuantity ? ' opponent-card-editable' : ''}`}
      onPointerEnter={(e) => setPreviewStyle(getPreviewPosition(e.currentTarget, 'left', card))}
    >
      <CardDetails name={entry.name} card={card} previewStyle={previewStyle} />
      {onQuantity ? (
        <div className="entry-quantity">
          <button className="tiny-button entry-qty-btn" type="button" title="Remove one" onClick={() => onQuantity(-1)}>
            −
          </button>
          <span className="quantity">{entry.quantity}</span>
          <button
            className="tiny-button entry-qty-btn"
            type="button"
            title="Add one"
            disabled={maxQuantity !== undefined && entry.quantity >= maxQuantity}
            onClick={() => onQuantity(1)}
          >
            +
          </button>
        </div>
      ) : (
        <span className="quantity">{entry.quantity}</span>
      )}
    </div>
  )
}

function CardDetails({ name, card, previewStyle }: { name: string; card?: CardRecord; previewStyle?: CSSProperties }) {
  const previewImages = getPreviewImages(card)

  return (
    <span className="card-details">
      <CardThumbnail card={card} />
      <span className="card-copy">
        <CardName name={name} />
        <ManaCost cost={card?.manaCost ?? ''} compact />
      </span>
      {previewImages.length > 0 ? (
        <span className="card-preview" style={previewStyle} role="presentation">
          {previewImages.map((imageUrl) => (
            <img src={imageUrl} alt="" loading="lazy" key={imageUrl} />
          ))}
        </span>
      ) : null}
    </span>
  )
}

function CardThumbnail({ card }: { card?: CardRecord }) {
  const imageUrl = card?.imageUris.art_crop ?? card?.imageUris.small

  return (
    <span className="card-thumbnail" style={{ background: getThumbnailFrame(card) }} aria-hidden="true">
      <span className="card-thumbnail-inner">
        {imageUrl ? <img src={imageUrl} alt="" loading="lazy" /> : null}
      </span>
    </span>
  )
}

function CardName({ name }: { name: string }) {
  return <span className="card-name">{name}</span>
}

function getPreviewImages(card?: CardRecord) {
  const faceImages = card?.faceImageUris
    ?.map((imageUris) => imageUris.large ?? imageUris.normal)
    .filter((imageUrl): imageUrl is string => Boolean(imageUrl)) ?? []

  if (faceImages.length > 0) return Array.from(new Set(faceImages))

  const imageUrl = card?.imageUris.large ?? card?.imageUris.normal
  return imageUrl ? [imageUrl] : []
}

function getDeckCoverImage(
  deck: Deck,
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
) {
  const coverCandidates = deck.entries
    .filter((entry) => entry.zone === 'main')
    .map((entry) => ({ entry, card: findCardForEntry(entry, cardById, cardByName) }))
    .filter(({ card }) => card && !card.typeLine.toLowerCase().includes('land') && (card.imageUris.art_crop || card.imageUris.normal))

  const cover = coverCandidates
    .sort(compareDeckCoverCandidates)
    .at(-1)
  const coverCard = cover?.card

  return coverCard?.imageUris.art_crop ?? coverCard?.imageUris.normal
}

function compareDeckCoverCandidates(
  left: { entry: DeckEntry; card?: CardRecord },
  right: { entry: DeckEntry; card?: CardRecord },
) {
  const leftManaValue = getManaValueForSort(left.card?.manaCost ?? '')
  const rightManaValue = getManaValueForSort(right.card?.manaCost ?? '')

  if (left.entry.quantity !== right.entry.quantity) {
    return left.entry.quantity - right.entry.quantity
  }

  if (leftManaValue !== rightManaValue) {
    return leftManaValue - rightManaValue
  }

  return left.entry.name.localeCompare(right.entry.name)
}

function ColorFilter({
  exact = false,
  selected,
  onExactToggle,
  onToggle,
}: {
  exact?: boolean
  selected: MtgColor[]
  onExactToggle?: () => void
  onToggle: (color: MtgColor) => void
}) {
  return (
    <div className="color-filter" aria-label="Colors">
      {COLORS.map((color) => (
        <button
          className={`mana-filter ${selected.includes(color.id) ? 'selected' : ''}`}
          type="button"
          key={color.id}
          onClick={() => onToggle(color.id)}
          title={colorName(color.id)}
          aria-label={colorName(color.id)}
        >
          <ManaIcon color={color.id} />
        </button>
      ))}
      {onExactToggle ? (
        <button
          className={`mana-filter exact-filter ${exact ? 'selected' : ''}`}
          type="button"
          onClick={onExactToggle}
          title="Exact colors"
          aria-label="Exact colors"
          aria-pressed={exact}
        >
          <ExactColorIcon />
        </button>
      ) : null}
    </div>
  )
}

function ExactColorIcon() {
  return (
    <span className="exact-color-icon" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

function ManaPips({
  colors,
  compact = false,
  splash = [],
}: {
  colors: MtgColor[]
  compact?: boolean
  splash?: MtgColor[]
}) {
  if (colors.length === 0) {
    return (
      <span className={`mana-pips ${compact ? 'compact' : ''}`} aria-label="Colorless">
        <ManaIcon color="C" />
      </span>
    )
  }

  // Main colors first, splashes last — both keeping WUBRG order within their group.
  const orderedColors = [
    ...colors.filter((color) => !splash.includes(color)),
    ...colors.filter((color) => splash.includes(color)),
  ]

  const label = orderedColors
    .map((color) => (splash.includes(color) ? `${colorName(color)} (splash)` : colorName(color)))
    .join(', ')

  return (
    <span className={`mana-pips ${compact ? 'compact' : ''}`} aria-label={label}>
      {orderedColors.map((color) => (
        <span className={splash.includes(color) ? 'mana-pip-splash' : undefined} key={color}>
          <ManaIcon color={color} />
        </span>
      ))}
    </span>
  )
}

function ManaCost({ cost, compact = false }: { cost: string; compact?: boolean }) {
  const tokens = parseManaCost(cost)

  return (
    <span className={`mana-cost ${compact ? 'compact' : ''}`} aria-label={cost || 'No mana cost'}>
      {tokens.map((token, index) => (
        token.kind === 'separator' ? (
          <span className="mana-cost-separator" aria-hidden="true" key={`separator-${index}`}>
            //
          </span>
        ) : (
          <ManaSymbol symbol={token.value} key={`${token.value}-${index}`} />
        )
      ))}
    </span>
  )
}

function ManaSymbol({ symbol }: { symbol: string }) {
  return <i className={`ms ms-cost ms-${toManaClass(symbol)} mana-icon`} aria-hidden="true" />
}

function ManaIcon({ color }: { color: MtgColor | 'C' }) {
  return <i className={`ms ms-cost ms-${color.toLowerCase()} mana-icon`} aria-hidden="true" />
}

function parseManaCost(cost: string) {
  return Array.from(cost.matchAll(/\{([^}]+)\}|\/\//g), (match) => {
    if (match[0] === '//') {
      return { kind: 'separator' as const }
    }

    return { kind: 'symbol' as const, value: match[1] }
  })
}

function toManaClass(symbol: string) {
  return symbol.toLowerCase().replace('/', '')
}

function getThumbnailFrame(card?: CardRecord) {
  if (!card) return getColorFrame([])

  const isLand = card.typeLine.toLowerCase().includes('land') && getManaValueForSort(card.manaCost) === 0
  return getColorFrame(isLand ? card.colorIdentity : getCostColors(card.manaCost))
}

function getColorFrame(colors: MtgColor[]) {
  if (colors.length === 0) return '#a5abb2'
  if (colors.length === 1) return COST_FRAME_COLORS[colors[0]]

  const step = 100 / colors.length
  const stops = colors.flatMap((color, index) => {
    const start = Math.round(index * step)
    const end = Math.round((index + 1) * step)
    return [`${COST_FRAME_COLORS[color]} ${start}%`, `${COST_FRAME_COLORS[color]} ${end}%`]
  })

  return `linear-gradient(135deg, ${stops.join(', ')})`
}

function getCostColors(cost: string) {
  const colorSet = new Set<MtgColor>()

  Array.from(cost.matchAll(/\{([^}]+)\}/g), (match) => match[1]).forEach((symbol) => {
    COLORS.forEach((color) => {
      if (symbol.includes(color.id)) {
        colorSet.add(color.id)
      }
    })
  })

  return COLORS.map((color) => color.id).filter((color) => colorSet.has(color))
}

const COST_FRAME_COLORS: Record<MtgColor, string> = {
  W: '#d4d0c8',
  U: '#3f83bd',
  B: '#202020',
  R: '#c45734',
  G: '#4f8a4c',
}

function colorName(color: MtgColor | 'C') {
  const names: Record<MtgColor | 'C', string> = {
    W: 'White',
    U: 'Blue',
    B: 'Black',
    R: 'Red',
    G: 'Green',
    C: 'Colorless',
  }

  return names[color]
}

function toggleColor(colors: MtgColor[], color: MtgColor) {
  return colors.includes(color) ? colors.filter((item) => item !== color) : [...colors, color]
}

function matchesColorFilter(colors: MtgColor[], selected: MtgColor[], exact: boolean) {
  if (selected.length === 0) {
    return exact ? colors.length === 0 : true
  }

  if (exact) {
    return colors.length === selected.length && selected.every((color) => colors.includes(color))
  }

  return selected.some((color) => colors.includes(color))
}

function colorsEqual(left: MtgColor[], right: MtgColor[]) {
  return left.length === right.length && left.every((color, index) => color === right[index])
}

function sumPlanQuantity(entries: PlanEntry[]) {
  return entries.reduce((total, entry) => total + entry.quantity, 0)
}

function clonePlanEntries(entries: PlanEntry[]) {
  return entries.map((entry) => ({
    ...entry,
    id: createId('plan'),
  }))
}

function getPlanDropId(section: PlanSection, direction: PlanDirection) {
  return `plan-${section}-${direction}`
}

function parsePlanDropTarget(id: string) {
  const match = id.match(/^plan-(primary|situational:.+)-(in|out)$/)
  if (!match) return null

  return {
    section: match[1] as PlanSection,
    direction: match[2] as PlanDirection,
  }
}

function getMatchupPlan(matchup: Matchup, section: PlanSection) {
  if (section === 'primary') return matchup.plan

  const sectionId = getSituationalSectionId(section)
  return getSituationalSections(matchup).find((item) => item.id === sectionId)?.plan ?? []
}

function setMatchupPlan(matchup: Matchup, section: PlanSection, plan: PlanEntry[]) {
  if (section === 'primary') return { ...matchup, plan }

  const sectionId = getSituationalSectionId(section)
  return {
    ...matchup,
    situationalSections: getSituationalSections(matchup).map((item) => (
      item.id === sectionId ? { ...item, plan } : item
    )),
  }
}

function normalizeMatchupPlans(deck: Deck, matchup: Matchup): Matchup {
  return {
    ...matchup,
    plan: normalizePlanEntries(deck, matchup.plan),
    situationalSections: getSituationalSections(matchup).map((section) => ({
      ...section,
      plan: normalizePlanEntries(deck, section.plan),
    })),
  }
}

function getSituationalSections(matchup: Matchup): SituationalSection[] {
  if (matchup.situationalSections) return matchup.situationalSections

  if ((matchup.situationalNotes && matchup.situationalNotes.trim()) || (matchup.situationalPlan?.length ?? 0) > 0) {
    return [{
      id: 'legacy-situational',
      notes: matchup.situationalNotes ?? '',
      plan: matchup.situationalPlan ?? [],
    }]
  }

  return []
}

function getSituationalSectionKey(sectionId: string): PlanSection {
  return `situational:${sectionId}`
}

function getSituationalSectionId(section: PlanSection) {
  return section.startsWith('situational:') ? section.slice('situational:'.length) : ''
}

// Matches `.card-preview img`, plus the container's own 6px gap and 6px padding.
const PREVIEW_WIDTH = 270
const PREVIEW_INNER_GAP = 6
const PREVIEW_PADDING = 6
const PREVIEW_GAP = 12

// A double-faced card renders one image per face, so the box is twice as wide and
// clips at an edge unless the fit check knows how many faces it is about to show.
function measurePreviewWidth(card?: CardRecord) {
  const faces = Math.max(1, getPreviewImages(card).length)
  return faces * PREVIEW_WIDTH + (faces - 1) * PREVIEW_INNER_GAP + PREVIEW_PADDING * 2
}

function getPreviewPosition(
  row: HTMLElement,
  placement: PreviewPlacement = 'right',
  card?: CardRecord,
): CSSProperties {
  const rect = row.getBoundingClientRect()
  const margin = 16
  const estimatedPreviewHeight = Math.min(380, window.innerHeight * 0.72)
  const minTop = margin + estimatedPreviewHeight / 2
  const maxTop = window.innerHeight - margin - estimatedPreviewHeight / 2
  const naturalTop = rect.top + rect.height / 2
  const top = Math.max(minTop, Math.min(maxTop, naturalTop))

  // The requested side is only a preference. A leftmost column has nothing to its
  // left, and anchoring there puts the preview off-screen — visually it just never
  // appears. Fall back to the other side when the preferred one cannot fit.
  const needed = measurePreviewWidth(card) + PREVIEW_GAP + margin
  const fitsLeft = rect.left >= needed
  const fitsRight = window.innerWidth - rect.right >= needed
  const side = placement === 'left'
    ? (fitsLeft || !fitsRight ? 'left' : 'right')
    : (fitsRight || !fitsLeft ? 'right' : 'left')

  if (side === 'left') {
    return {
      right: window.innerWidth - rect.left + PREVIEW_GAP,
      top,
    }
  }

  return {
    left: rect.right + PREVIEW_GAP,
    top,
  }
}

function normalizeDeckColors(decks: Deck[], cards: CardRecord[]) {
  if (cards.length === 0) return decks

  const cardIndex = createCardIndexes(cards).byName
  return decks.map((deck) => {
    const { colors, splash } = inferDeckColorProfile(deck.entries, cardIndex)
    if (colorsEqual(colors, deck.colors) && colorsEqual(splash, deck.splashColors ?? [])) return deck
    return { ...deck, colors, splashColors: splash }
  })
}

function syncGlobalMatchups(decks: Deck[]) {
  const definitions = getGlobalMatchupDefinitions(decks)
  if (definitions.length === 0) return decks

  return decks.map((deck) => {
    const existingIds = new Set(deck.matchups.map((matchup) => matchup.id))
    const missingMatchups = definitions
      .filter((matchup) => !existingIds.has(matchup.id))
      .map(createBlankMatchupFromDefinition)

    if (missingMatchups.length === 0) return deck

    return {
      ...deck,
      matchups: [...deck.matchups, ...missingMatchups],
    }
  })
}

function getGlobalMatchupDefinitions(decks: Deck[]) {
  const definitions = new Map<string, Matchup>()

  decks.forEach((deck) => {
    deck.matchups.forEach((matchup) => {
      if (!definitions.has(matchup.id)) {
        definitions.set(matchup.id, matchup)
      }
    })
  })

  return Array.from(definitions.values())
}

function createBlankMatchupFromDefinition(matchup: Matchup): Matchup {
  return {
    id: matchup.id,
    name: matchup.name,
    colors: matchup.colors,
    splashColors: matchup.splashColors,
    notes: '',
    plan: [],
    situationalSections: [],
    opponentEntries: matchup.opponentEntries,
    opponentVariantEntries: matchup.opponentVariantEntries,
  }
}

// One definition of what writing "Also Seen" means: clamp to the four-copy limit,
// then recompute the matchup's colours from the net delta. Shared by the Opponent
// Deck panel and the Replay tab's push, so a card arriving from a parsed game is
// stored on exactly the same terms as one typed in by hand.
//
// The matchup is read from the updater's own argument rather than closed over, so a
// caller outside the plan editor needs nothing but the id.
function applyVariantEntries(
  matchup: Matchup,
  rawEntries: DeckEntry[],
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
): Matchup {
  const entries = clampCopies(rawEntries, cardById, cardByName)
  const profile = inferOpponentColorProfile(matchup.opponentEntries ?? [], entries, cardByName)
  return {
    ...matchup,
    opponentVariantEntries: entries,
    colors: profile.colors,
    splashColors: profile.splash,
  }
}

// Folding a new sighting into the existing ones keeps the *highest* count seen per
// card rather than summing: spotting 2 Duress across three games means the deck
// runs 2 of them, not 6.
function mergeVariantEntries(existing: DeckEntry[], incoming: DeckEntry[]): DeckEntry[] {
  const merged = existing.map((entry) => ({ ...entry }))

  incoming.forEach((entry) => {
    const match = merged.find((item) => item.name === entry.name)
    if (match) {
      match.quantity = Math.max(match.quantity, entry.quantity)
      return
    }
    merged.push({ ...entry })
  })

  return merged
}

// Net "Also Seen" cards: quantities beyond what the conventional 75 already contains.
function computeAlsoSeenEntries(opponentEntries: DeckEntry[], variantEntries: DeckEntry[]): DeckEntry[] {
  const conventionalQtyByName = new Map<string, number>()
  opponentEntries.forEach((entry) => {
    conventionalQtyByName.set(entry.name, (conventionalQtyByName.get(entry.name) ?? 0) + entry.quantity)
  })

  return variantEntries
    .map((entry) => ({ ...entry, quantity: entry.quantity - (conventionalQtyByName.get(entry.name) ?? 0) }))
    .filter((entry) => entry.quantity > 0)
}

// Colour identity for a matchup, derived from the opponent's 75 plus any net
// "Also Seen" cards. Uses net deltas so cards already in the 75 aren't counted twice.
function inferOpponentColorProfile(
  opponentEntries: DeckEntry[],
  variantEntries: DeckEntry[],
  cardByName: Map<string, CardRecord>,
) {
  return inferDeckColorProfile(
    [...opponentEntries, ...computeAlsoSeenEntries(opponentEntries, variantEntries)],
    cardByName,
  )
}

function findCardForEntry(
  entry: { cardId?: string; name: string },
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
) {
  return (entry.cardId ? cardById.get(entry.cardId) : undefined) ?? cardByName.get(normalizeCardName(entry.name))
}

function resolvePlanSourceEntry(deck: Deck, draggedEntry: DeckEntry, direction: PlanDirection) {
  const sourceZone = direction === 'in' ? 'sideboard' : 'main'
  const draggedKey = getEntryCardKey(draggedEntry)

  return deck.entries.find((entry) => entry.zone === sourceZone && getEntryCardKey(entry) === draggedKey)
}

function getEntryPoolQuantity(deck: Deck, sourceEntry: DeckEntry, direction: PlanDirection) {
  const sourceZone = direction === 'in' ? 'sideboard' : 'main'
  const sourceKey = getEntryCardKey(sourceEntry)

  return deck.entries
    .filter((entry) => entry.zone === sourceZone && getEntryCardKey(entry) === sourceKey)
    .reduce((total, entry) => total + entry.quantity, 0)
}

function normalizePlanEntries(deck: Deck, plan: PlanEntry[]) {
  const normalized = new Map<string, PlanEntry>()

  plan.forEach((entry) => {
    const sourceEntry = resolvePlanEntrySource(deck, entry)
    if (!sourceEntry) return

    const key = `${entry.direction}:${getEntryCardKey(sourceEntry)}`
    const availableQuantity = getEntryPoolQuantity(deck, sourceEntry, entry.direction)
    const existing = normalized.get(key)
    const nextQuantity = Math.min(availableQuantity, (existing?.quantity ?? 0) + entry.quantity)

    normalized.set(key, {
      id: existing?.id ?? entry.id,
      entryId: sourceEntry.id,
      cardId: sourceEntry.cardId,
      name: sourceEntry.name,
      quantity: nextQuantity,
      direction: entry.direction,
    })
  })

  return Array.from(normalized.values()).filter((entry) => entry.quantity > 0)
}

function resolvePlanEntrySource(deck: Deck, planEntry: PlanEntry) {
  const sourceZone = planEntry.direction === 'in' ? 'sideboard' : 'main'
  const planKey = getEntryCardKey(planEntry)

  return deck.entries.find((entry) => entry.zone === sourceZone && getEntryCardKey(entry) === planKey)
}

function getEntryCardKey(entry: { cardId?: string; name: string }) {
  return entry.cardId ?? normalizeCardName(entry.name)
}

function compareDeckEntries(
  left: DeckEntry,
  right: DeckEntry,
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
) {
  return compareCardEntries(left, right, cardById, cardByName)
}

function compareCardEntries(
  left: { cardId?: string; name: string },
  right: { cardId?: string; name: string },
  cardById: Map<string, CardRecord>,
  cardByName: Map<string, CardRecord>,
) {
  const leftCard = findCardForEntry(left, cardById, cardByName)
  const rightCard = findCardForEntry(right, cardById, cardByName)
  const leftManaValue = getManaValueForSort(leftCard?.faces?.[0]?.manaCost ?? leftCard?.manaCost ?? '')
  const rightManaValue = getManaValueForSort(rightCard?.faces?.[0]?.manaCost ?? rightCard?.manaCost ?? '')
  const leftIsZero = leftManaValue === 0
  const rightIsZero = rightManaValue === 0

  if (leftIsZero !== rightIsZero) {
    return leftIsZero ? 1 : -1
  }

  if (leftManaValue !== rightManaValue) {
    return leftManaValue - rightManaValue
  }

  return left.name.localeCompare(right.name)
}

function getManaValueForSort(manaCost: string) {
  const symbols = Array.from(manaCost.matchAll(/\{([^}]+)\}/g), (match) => match[1])

  return symbols.reduce((total, symbol) => total + getSymbolManaValue(symbol), 0)
}

function getSymbolManaValue(symbol: string) {
  const numericValue = Number(symbol)
  if (Number.isFinite(numericValue)) return numericValue
  if (/^\d+\/[WUBRG]$/.test(symbol)) return Number(symbol.split('/')[0])
  if (symbol === 'X' || symbol === 'Y' || symbol === 'Z') return 0

  return 1
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function downloadFile(filename: string, contents: string, type: string) {
  downloadBlob(filename, new Blob([contents], { type }))
}

function searchCards(query: string, byName: Map<string, CardRecord>): CardRecord[] {
  if (query.length < 2) return []
  const lower = query.toLowerCase()
  const seen = new Set<string>()
  const startsWith: CardRecord[] = []
  const contains: CardRecord[] = []
  for (const card of byName.values()) {
    if (seen.has(card.id)) continue
    seen.add(card.id)
    const nameLower = card.name.toLowerCase()
    if (nameLower.startsWith(lower)) startsWith.push(card)
    else if (nameLower.includes(lower)) contains.push(card)
  }
  startsWith.sort((a, b) => a.name.localeCompare(b.name))
  contains.sort((a, b) => a.name.localeCompare(b.name))
  return [...startsWith, ...contains].slice(0, 8)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

function formatBackupDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 2) return 'just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  return diffDay === 1 ? 'yesterday' : `${diffDay} days ago`
}

function formatBytesProgress(receivedBytes?: number, totalBytes?: number) {
  if (!receivedBytes) return 'Working'
  if (!totalBytes) return formatBytes(receivedBytes)

  return `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

export default App
