const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const mtgaLogs = require('./mtgaLogs.cjs')
const { parseLogFile } = require('./mtgaParse.cjs')
const { matchDeck } = require('./deckMatch.cjs')

const MTGA_DB_DIR = 'C:/Program Files/Wizards of the Coast/MTGA/MTGA_Data/Downloads/Raw'

// grpId -> card name, read from MTGA's own card database. Cached because the join
// walks 27k rows; it takes ~60ms, which is cheap once and wasteful per game.
let cardNameCache = null
// LocId -> short display string. A modal choice reports its mode as a localization
// id, resolved from the same table the card names come from.
let choiceLabelCache = null
// CounterType enum value -> display name ("+1/+1", "Hexproof", ...).
let counterTypeCache = null
// Ability id -> the card that owns it, for abilities that belong to exactly one card.
let abilityOwnerCache = null
// Ability id -> its rules text, for naming which ability was activated.
let abilityTextCache = null

function loadCardNames() {
  if (cardNameCache) return cardNameCache

  const names = new Map()
  try {
    const file = fs.readdirSync(MTGA_DB_DIR).find((name) => /^Raw_CardDatabase_.*\.mtga$/.test(name))
    if (!file) return names

    // Read-only: this is MTGA's live database, not ours to modify.
    const db = new DatabaseSync(path.join(MTGA_DB_DIR, file), { readOnly: true })
    const rows = db.prepare(`
      SELECT c.GrpId AS grpId, l.Loc AS name
      FROM Cards c JOIN Localizations_enUS l ON c.TitleId = l.LocId
      GROUP BY c.GrpId
    `).all()
    for (const row of rows) names.set(row.grpId, row.name)
    db.close()
  } catch {
    // Without the database, games still parse — cards just stay unnamed.
    return names
  }

  cardNameCache = names
  return names
}

// Only short strings: a mode label is a handful of words ("Temur", "Abzan"), while
// the same table holds every card's full rules text. The cap keeps the map at ~5MB
// instead of ~9MB and costs nothing in coverage.
const CHOICE_LABEL_MAX_CHARS = 120

function loadChoiceLabels() {
  if (choiceLabelCache) return choiceLabelCache

  const labels = new Map()
  try {
    const file = fs.readdirSync(MTGA_DB_DIR).find((name) => /^Raw_CardDatabase_.*\.mtga$/.test(name))
    if (!file) return labels

    const db = new DatabaseSync(path.join(MTGA_DB_DIR, file), { readOnly: true })
    const rows = db.prepare(
      'SELECT LocId AS id, Loc AS text FROM Localizations_enUS WHERE LENGTH(Loc) <= ?',
    ).all(CHOICE_LABEL_MAX_CHARS)
    for (const row of rows) labels.set(row.id, row.text)
    db.close()
  } catch {
    // Without it, choices simply go unreported.
    return labels
  }

  choiceLabelCache = labels
  return labels
}

// MTGA ships the counter-type enum in its own database, so the kind of counter is a
// lookup rather than an inference. An earlier version read it from a
// PowerToughnessMod arriving in the same message, which only ever worked for +1/+1.
function loadCounterTypes() {
  if (counterTypeCache) return counterTypeCache

  const types = new Map()
  try {
    const file = fs.readdirSync(MTGA_DB_DIR).find((name) => /^Raw_CardDatabase_.*\.mtga$/.test(name))
    if (!file) return types

    const db = new DatabaseSync(path.join(MTGA_DB_DIR, file), { readOnly: true })
    const rows = db.prepare(`
      SELECT e.Value AS value, l.Loc AS label
      FROM Enums e JOIN Localizations_enUS l ON e.LocId = l.LocId
      WHERE e.Type = 'CounterType'
    `).all()
    for (const row of rows) {
      // The same value appears several times, some rows carrying display markup
      // ("<nobr>+1/+1</nobr>"). Keep the first clean one.
      if (!row.label || row.label.includes('<')) continue
      if (!types.has(row.value)) types.set(row.value, row.label)
    }
    db.close()
  } catch {
    return types
  }

  counterTypeCache = types
  return types
}

// An annotation's affector is often an ability, identified by an id that is not a
// card grpId and appears nowhere in the game objects. Cards.AbilityIds lists the
// abilities each card owns ("6:158,14:28,176578:879294"), so the mapping runs
// backwards from there.
//
// Only abilities owned by a single card name are kept. The low ids are evergreen
// keywords shared by thousands of cards — mapping those would attribute a trigger to
// whichever card happened to be listed first.
function loadAbilityOwners() {
  if (abilityOwnerCache) return abilityOwnerCache

  const owners = new Map()
  try {
    const file = fs.readdirSync(MTGA_DB_DIR).find((name) => /^Raw_CardDatabase_.*\.mtga$/.test(name))
    if (!file) return owners

    const db = new DatabaseSync(path.join(MTGA_DB_DIR, file), { readOnly: true })
    const rows = db.prepare(`
      SELECT c.AbilityIds AS abilities, l.Loc AS name
      FROM Cards c JOIN Localizations_enUS l ON c.TitleId = l.LocId
      WHERE c.AbilityIds IS NOT NULL AND c.AbilityIds != ''
    `).all()
    db.close()

    const claims = new Map()
    for (const row of rows) {
      for (const pair of row.abilities.split(',')) {
        const id = Number.parseInt(pair.split(':')[0], 10)
        if (!Number.isFinite(id)) continue
        if (!claims.has(id)) claims.set(id, new Set())
        claims.get(id).add(row.name)
      }
    }
    for (const [id, names] of claims) {
      if (names.size === 1) owners.set(id, [...names][0])
    }
  } catch {
    return owners
  }

  abilityOwnerCache = owners
  return owners
}

// Which ability was activated is only an id in the log; the Abilities table carries
// its text. Soul-Guide Lantern has two, so without this "activates Soul-Guide
// Lantern" cannot say which one was used.
function loadAbilityText() {
  if (abilityTextCache) return abilityTextCache

  const texts = new Map()
  try {
    const file = fs.readdirSync(MTGA_DB_DIR).find((name) => /^Raw_CardDatabase_.*\.mtga$/.test(name))
    if (!file) return texts

    const db = new DatabaseSync(path.join(MTGA_DB_DIR, file), { readOnly: true })
    const rows = db.prepare(`
      SELECT a.Id AS id, l.Loc AS text
      FROM Abilities a JOIN Localizations_enUS l ON a.TextId = l.LocId
    `).all()
    for (const row of rows) {
      if (row.text) texts.set(row.id, row.text)
    }
    db.close()
  } catch {
    return texts
  }

  abilityTextCache = texts
  return texts
}

async function loadGames(app, decks = []) {
  const names = loadCardNames()
  const labels = loadChoiceLabels()
  const resolveName = (grpId) => names.get(grpId) || null
  const resolveChoice = (locId) => labels.get(locId) || null
  const counterTypes = loadCounterTypes()
  const resolveCounter = (value) => counterTypes.get(value) || null
  const abilityOwners = loadAbilityOwners()
  const resolveAbility = (abilityId) => abilityOwners.get(abilityId) || null
  const abilityTexts = loadAbilityText()
  const resolveAbilityText = (abilityId) => abilityTexts.get(abilityId) || null
  const archiveDir = mtgaLogs.getArchiveDir(app)
  const matches = new Map()

  for (const entry of mtgaLogs.listArchives(app)) {
    const logPath = path.join(archiveDir, entry.filename)

    let parsed
    try {
      parsed = await parseLogFile(logPath, {
        resolveName, resolveChoice, resolveCounter, resolveAbility, resolveAbilityText,
      })
    } catch {
      continue
    }

    const submitted = parsed.submittedDecks[0]
    const submittedNames = submitted
      ? submitted.main.map(resolveName).filter(Boolean)
      : []
    const assignment = submittedNames.length > 0 ? matchDeck(submittedNames, decks) : null

    for (const game of parsed.games) {
      if (game.events.length === 0) continue

      // A match can span two logs if MTGA restarts mid-match, so games are keyed by
      // matchID across every archive rather than per file.
      const key = game.matchId || `${entry.filename}:${game.gameNumber}`
      const match = matches.get(key) || {
        matchId: game.matchId,
        source: entry.filename,
        playedAt: entry.modifiedAt,
        seatNames: parsed.seatNames,
        localSeat: parsed.localSeat,
        opponent: Object.entries(parsed.seatNames)
          .filter(([seat]) => Number(seat) !== parsed.localSeat)
          .map(([, name]) => name)[0] || 'Unknown',
        deckId: assignment ? assignment.deckId : null,
        deckName: assignment ? assignment.deckName : null,
        deckScore: assignment ? assignment.score : 0,
        matchWinCondition: game.matchWinCondition,
        completedReason: parsed.matchCompletedReason || null,
        games: [],
      }

      match.games.push({
        gameNumber: game.gameNumber,
        maxTurn: game.maxTurn,
        result: game.result,
        endReason: game.result ? game.result.reason || null : null,
        truncated: Boolean(game.truncated),
        // Null rather than false when either side is unknown: "on the play" is a
        // real claim about the game, and a guess would read as fact.
        onThePlay: game.firstSeat == null || parsed.localSeat == null
          ? null
          : game.firstSeat === parsed.localSeat,
        won: game.result ? game.result.winningTeamId === parsed.localSeat : null,
        events: game.events,
        // Exact, not inferred: this is our own list before and after boarding.
        sideboarding: game.sideboarding || null,
      })
      matches.set(key, match)
    }
  }

  return Array.from(matches.values())
    .map((match) => ({ ...match, games: match.games.sort((a, b) => a.gameNumber - b.gameNumber) }))
    .sort((a, b) => b.playedAt.localeCompare(a.playedAt))
}

module.exports = {
  loadGames, loadCardNames, loadChoiceLabels, loadCounterTypes, loadAbilityOwners, loadAbilityText,
}
