import { normalizeCardName } from './arena'
import type { CardDatabase, CardFace, CardImageUris, CardRecord, MtgColor } from './types'

type ScryfallBulkItem = {
  type: string
  name: string
  uri: string
  jsonl_download_uri: string
  updated_at: string
}

type ScryfallCard = {
  id: string
  oracle_id?: string
  name: string
  lang: string
  layout?: string
  games?: string[]
  legalities?: Record<string, string>
  mana_cost?: string
  type_line?: string
  oracle_text?: string
  colors?: MtgColor[]
  color_identity?: MtgColor[]
  power?: string
  toughness?: string
  loyalty?: string
  image_uris?: CardImageUris
  card_faces?: Array<{
    name: string
    mana_cost?: string
    type_line?: string
    oracle_text?: string
    colors?: MtgColor[]
    power?: string
    toughness?: string
    loyalty?: string
    image_uris?: CardImageUris
  }>
  set: string
  collector_number: string
  rarity: string
}

const SCRYFALL_BULK_URL = 'https://api.scryfall.com/bulk-data'
// Maps MTG Arena export names to Scryfall oracle names when they differ.
// Primary use: Through the Omenpaths (OM1) uses in-universe MTG flavor names
// for cards that are mechanically identical to Marvel's Spider-Man (SPM) set cards.
// Arena exports always use OM1 names even for SPM-originated cards.
const ARENA_NAME_ALIASES: Record<string, string> = {
  // OM1 (Through the Omenpaths) → SPM (Marvel's Spider-Man) — White
  'A Most Helpful Weaver': 'Origin of Spider-Man',
  'Ademi of the Silkchutes': 'Spectacular Spider-Man',
  "Archangler's Skyrod": 'Web-Shooters',
  'Basil, Cabaretti Loudmouth': 'Flash Thompson, Spider-Fan',
  'Chosen by Valgavoth': 'With Great Power . . .',
  "Confessor's Bindings": 'Rent Is Due',
  'Freestrider Aces': 'Wild Pack Squad',
  'Generous Betty Wray': 'Silver Sable, Mercenary Leader',
  'Lively Leap': 'Thwip!',
  'Mothwing Shroud': 'Web Up',
  'Principled Referee': 'Daily Bugle Reporters',
  'Sarn of the Silken Throne': 'Spider-UK',
  'Surris, Spidersilk Innovator': 'Peter Parker // Amazing Spider-Man',
  'Verilax the Havenskin': 'Anti-Venom, Horrifying Healer',
  'Yera and Oski, Weaver and Guide': 'Arachne, Psionic Weaver',
  'Zora, Spider Fancier': 'Aunt May',

  // OM1 → SPM — Blue
  'Arala, Hedron Scaler': 'Beetle, Legacy Criminal',
  'Argyr, Tidal Spinner': 'Spider-Byte, Web Warden',
  'Belion, the Parched': 'Hydro-Man, Fluid Felon',
  'Drix Interception': 'Amazing Acrobatics',
  'Goben, Gene-Splice Savant': 'Norman Osborn // Green Goblin',
  'Hide in Mundanity': 'Hide on the Ceiling',
  'Merata, Neuron Hacker': 'Lady Octopus, Inspired Inventor',
  'Obscura Alleylurkers': "Doc Ock's Henchmen",
  'Outsmart the Amateur': 'School Daze',
  'Ozor, Chronicler of Collapse': 'Doc Ock, Sinister Scientist',
  'Phantasmal Vision': "Mysterio's Phantasm",
  'Pinnacle Research Team': 'Oscorp Research Team',
  'Vazin, Two-Faced Trickster': 'Chameleon, Master of Disguise',
  'Vexed Bots': 'Flying Octobot',
  'The Watcher on the Road': 'Mysterio, Master of Illusion',

  // OM1 → SPM — Black
  'Aggressive Symbiosis': 'Alien Symbiosis',
  'Bane-Marked Leonin': 'Venomized Cat',
  'Caldaia Brawlers': 'Inner Demons Gangsters',
  'Clandestine Work': 'Risky Research',
  'Damning Caress': "Venom's Hunger",
  "Duskmourn's Claim": 'Parker Luck',
  'Egrix the Bile Bulwark': 'Gwenom, Remorseless',
  'Hex of Undeath': 'Behold the Sinister Six!',
  'The House Grows Hungry': 'The Death of Gwen Stacy',
  'Kroble, Envoy of the Bog': 'Spider-Man Noir',
  'Luis, Pompous Pillager': 'Morlun, Devourer of Spiders',
  'Miasmic Mist': "Sandman's Quicksand",

  // OM1 → SPM — Red
  'Arachnomania': 'Spider-Verse',
  'Bayo, Irritable Instructor': 'Electro, Assaulting Battery',
  'Cam and Farrik, Havoc Duo': 'Hobgoblin, Mantled Marauder',
  'Deathflame Burst': "Electro's Bolt",
  'Fire-Brained Scheme': "Heroes' Hangout",
  'Full-Throttle Fanatic': 'Taxi Driver',
  'The Infernus': 'Molten Man, Inferno Incarnate',
  'Kazuo, Ruthless Rival': 'Shocker, Unshakable',
  'Kephon, Rage Incubator': 'Stegron the Dinosaur Man',
  'Kraza, the Swarm as One': 'Spider-Punk',
  'Lavaborn Goblins': 'Raging Goblinoids',
  'Nia, Skysail Storyteller': 'Gwen Stacy // Ghost-Spider',

  // OM1 → SPM — Green
  'Ancestral Carvings': 'Spider-Gwen, Free Spirit',
  'Chizak, Apex Arachnosaur': 'Spider-Rex, Daring Dino',
  'Cren, Undercity Dreamer': 'Miles Morales // Ultimate Spider-Man',
  'Eccentric Arachnologist': 'Guy in the Chair',
  'Fateweaver': 'Radioactive Spider',
  'Favored Fighter': 'Professional Wrestler',
  'Tarantusk, Unwisely Awoken': 'Spider-Ham, Peter Porker',
  'Zan, Tunnelweb Explorer': 'Spider-Man, Brooklyn Visionary',

  // OM1 → SPM — Multicolor
  'Alenni, Brood Recruiter': 'Silk, Web Weaver',
  'Alessos and Pras, Acrobats': 'Spider-Man India',
  'Borys, the Spider Rider': 'Scarlet Spider, Ben Reilly',
  'Brako, Heartless Hunter': 'Kraven the Hunter',
  'Carlo, Suave Schemer': 'Prowler, Clawed Thief',
  'Cirina Bargainspinner': 'Sun-Spider, Nimble Webber',
  'Crash, Reckless Endrider': 'Shriek, Treblemaker',
  'Darval, Whose Web Protects': 'Spider-Man, Web-Slinger',
  'Demera, Soul of a Spider': 'Mary Jane Watson',
  'Desecrex, Gift of Servitude': 'Carnage, Crimson Chaos',
  'Diligent Webkeepers': 'Web-Warriors',
  'Dreadfang, Loathed by Fans': 'Kraven, Proud Predator',
  'Druneth, Reviver of the Hive': 'Jackal, Genius Geneticist',
  'Eztli of the Thousand Moons': 'Starling, Aerial Ally',
  'Janai and Hoppy, Roofskippers': 'Spider-Girl, Legacy Hero',
  'Kumonosu, the Watchful': 'SP//dr, Piloted by Peni',
  'Leyline Weaver': 'Spider Manifestation',
  'Makdee and Itla, Skysnarers': 'Spider-Woman, Stunning Savior',
  'Margot, On the Case': 'Wraith, Vicious Vigilante',
  'Wonderweave Aerialist': 'Skyward Spider',

  // OM1 → SPM — Artifacts
  'Opulent Valet': 'News Helicopter',
  'Treat Trolley': 'Hot Dog Cart',

  // OM1 → SPM — Lands
  'Exclusive Nightclub': 'Oscorp Industries',
  'Fearsome Ridgeline': 'Daily Bugle Building',
}

export type SyncProgress = {
  stage: 'metadata' | 'downloading' | 'parsing' | 'filtering' | 'saving' | 'complete'
  label: string
  receivedBytes?: number
  totalBytes?: number
  percent?: number
}

type ProgressCallback = (progress: SyncProgress) => void

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 3000

async function fetchWithRetry(
  url: string,
  stageName: string,
  stage: SyncProgress['stage'],
  onProgress: ProgressCallback | undefined,
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      onProgress?.({ stage, label: `${stageName} — retrying (attempt ${attempt}/${MAX_RETRIES})…` })
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } })
      return response
    } catch (error) {
      lastError = error
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`${stageName}: no response from server after ${MAX_RETRIES} attempts (${reason}). Check your internet connection.`)
}

export async function fetchStandardCards(onProgress?: ProgressCallback): Promise<CardDatabase> {
  onProgress?.({ stage: 'metadata', label: 'Requesting Scryfall bulk metadata' })

  const bulkResponse = await fetchWithRetry(SCRYFALL_BULK_URL, 'Scryfall metadata', 'metadata', onProgress)

  if (!bulkResponse.ok) {
    throw new Error(`Scryfall metadata request failed — server returned HTTP ${bulkResponse.status}. Try again later.`)
  }

  let bulkPayload: { data: ScryfallBulkItem[] }
  try {
    bulkPayload = await bulkResponse.json()
  } catch {
    throw new Error('Scryfall metadata response could not be parsed. The API may be returning unexpected data.')
  }

  const oracleCards = bulkPayload.data.find((item) => item.type === 'oracle_cards')
  if (!oracleCards) {
    const types = bulkPayload.data.map((item: Record<string, unknown>) => item.type).join(', ')
    throw new Error(`Scryfall response contained no oracle_cards entry. Types present: ${types}`)
  }


  onProgress?.({ stage: 'downloading', label: 'Downloading Oracle card data', receivedBytes: 0 })

  let payloadText: string

  // Scryfall serves a gzipped JSONL file that decompresses to ~200MB. In Electron the
  // main process downloads, decompresses, and pre-filters it so only the Standard-legal
  // subset crosses the IPC boundary.
  if (typeof window !== 'undefined' && window.electronAPI?.fetchScryfallCards) {
    try {
      payloadText = await window.electronAPI.fetchScryfallCards(oracleCards.jsonl_download_uri)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Scryfall card download failed (${reason}). Try again.`, { cause: error })
    }
  } else {
    const cardsResponse = await fetchWithRetry(oracleCards.jsonl_download_uri, 'Scryfall card download', 'downloading', onProgress)

    if (!cardsResponse.ok) {
      throw new Error(`Scryfall card download failed — server returned HTTP ${cardsResponse.status}. Try again later.`)
    }

    let bytes: Uint8Array
    try {
      bytes = await readResponseBytes(cardsResponse, onProgress)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Scryfall card download interrupted mid-stream (${reason}). Try again.`, { cause: error })
    }

    onProgress?.({ stage: 'parsing', label: 'Decompressing card data', percent: 86 })
    payloadText = await decompressIfGzipped(bytes)
  }

  onProgress?.({ stage: 'parsing', label: 'Parsing Scryfall card data', percent: 88 })
  let payload: ScryfallCard[]
  try {
    const parsed: unknown = JSON.parse(payloadText)
    if (Array.isArray(parsed)) {
      payload = parsed as ScryfallCard[]
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).data)) {
      payload = (parsed as { data: ScryfallCard[] }).data
    } else {
      throw new Error('not an array')
    }
  } catch {
    // Scryfall may serve JSONL (one JSON object per line)
    try {
      payload = payloadText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ScryfallCard)
    } catch {
      throw new Error('Scryfall card data could not be parsed — the download may be incomplete or corrupted. Try again.')
    }
  }

  onProgress?.({ stage: 'filtering', label: 'Filtering Standard-legal cards', percent: 94 })
  const cards = payload
    .filter((card) => card.lang === 'en')
    .filter((card) => card.legalities?.standard === 'legal' || isToken(card))
    .map(toCardRecord)
    .sort((a, b) => a.name.localeCompare(b.name))

  const tokenCount = cards.filter((card) => card.isToken).length
  onProgress?.({
    stage: 'saving',
    label: `Preparing ${(cards.length - tokenCount).toLocaleString()} Standard cards and ${tokenCount.toLocaleString()} tokens`,
    percent: 98,
  })

  return {
    cards,
    updatedAt: new Date().toISOString(),
    sourceUpdatedAt: oracleCards.updated_at,
    exportedAt: new Date().toISOString(),
  }
}

async function readResponseBytes(response: Response, onProgress?: ProgressCallback): Promise<Uint8Array> {
  const totalBytes = Number(response.headers.get('content-length')) || undefined

  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer())
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    receivedBytes += value.byteLength
    chunks.push(value)

    const downloadPercent = totalBytes ? (receivedBytes / totalBytes) * 84 : undefined
    onProgress?.({
      stage: 'downloading',
      label: 'Downloading Oracle card data',
      receivedBytes,
      totalBytes,
      percent: downloadPercent ? Math.min(84, Math.round(downloadPercent)) : undefined,
    })
  }

  const merged = new Uint8Array(receivedBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

// Scryfall serves the bulk file as .jsonl.gz without a content-encoding header,
// so the browser doesn't decompress it automatically.
async function decompressIfGzipped(bytes: Uint8Array): Promise<string> {
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  if (!gzipped) return new TextDecoder().decode(bytes)

  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

// Keys under which tokens are also indexed. A token often shares its name with a real
// card (an offspring token is named after its card), and the plain name rightly
// belongs to the card, so a token is reached through these instead. The sized key
// tells same-named tokens apart: Soldier tokens come in several sizes.
export function tokenKey(normalizedName: string, power?: string | number, toughness?: string | number) {
  return power != null && toughness != null
    ? `token:${normalizedName}:${power}/${toughness}`
    : `token:${normalizedName}`
}

export function createCardIndexes(cards: CardRecord[]) {
  const byId = new Map<string, CardRecord>()
  const byName = new Map<string, CardRecord>()

  // Two rules decide a name collision, in this order:
  //
  //   1. A real card beats a token. They share names constantly — Treasure, Clue,
  //      and every creature-type token — and a decklist entry or an OCR line always
  //      means the card.
  //   2. A card whose *own* name is the key beats one that only matches through a
  //      face. "Treasure" was resolving to the double-faced "Vampire // Treasure"
  //      token, so the preview showed a Vampire beside the Treasure.
  const rank = (card: CardRecord, exact: boolean) => (card.isToken ? 0 : 2) + (exact ? 1 : 0)

  const claim = (key: string, card: CardRecord, exact: boolean) => {
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, card)
      return
    }
    // Ties keep what is already there, so the sorted order decides and the result
    // does not depend on iteration details.
    if (rank(card, exact) > rank(existing, existing.normalizedName === key)) {
      byName.set(key, card)
    }
  }

  cards.forEach((card) => {
    byId.set(card.id, card)
    if (card.isToken) {
      // First one wins on a clash, so the result follows the stored order.
      for (const key of [tokenKey(card.normalizedName), tokenKey(card.normalizedName, card.power, card.toughness)]) {
        if (!byName.has(key)) byName.set(key, card)
      }
    }
    claim(card.normalizedName, card, true)
    byName.set(card.id, card)
    card.aliases?.forEach((alias) => claim(normalizeCardName(alias), card, false))

    if (card.name.includes(' // ')) {
      card.name.split(' // ').forEach((faceName) => claim(normalizeCardName(faceName), card, false))
    }
  })

  Object.entries(ARENA_NAME_ALIASES).forEach(([arenaName, oracleName]) => {
    const card = byName.get(normalizeCardName(oracleName))
    if (card) {
      byName.set(normalizeCardName(arenaName), card)
    }
  })

  return { byId, byName }
}

// Reminder text for evergreen keyword abilities. Scryfall's oracle text omits these
// for keyword-only lines since they're considered "understood", but they're useful
// to have in the exported JSON as a reference.
const KEYWORD_REMINDERS: Record<string, string> = {
  'Deathtouch': 'Any amount of damage this creature deals to a creature is enough to destroy it.',
  'Defender': "This creature can't attack.",
  'Double strike': 'This creature deals both first-strike and regular combat damage.',
  'First strike': 'This creature deals combat damage before creatures without first strike.',
  'Flash': 'You may cast this spell any time you could cast an instant.',
  'Flying': "This creature can't be blocked except by creatures with flying or reach.",
  'Haste': 'This creature can attack and {T} as soon as it comes under your control.',
  'Hexproof': "This permanent can't be the target of spells or abilities your opponents control.",
  'Indestructible': 'Damage and effects that say "destroy" don\'t destroy this permanent.',
  'Lifelink': 'Damage dealt by this creature also causes you to gain that much life.',
  'Menace': "This creature can't be blocked except by two or more creatures.",
  'Prowess': 'Whenever you cast a noncreature spell, this creature gets +1/+1 until end of turn.',
  'Reach': 'This creature can block creatures with flying.',
  'Shroud': "This permanent can't be the target of spells or abilities.",
  'Trample': "This creature can deal excess combat damage to the player or planeswalker it's attacking.",
  'Vigilance': "Attacking doesn't cause this creature to tap.",
}

function expandKeywordReminders(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.includes('(')) return line
      const tokens = line.split(', ').map((t) => t.trim()).filter(Boolean)
      if (tokens.length === 0) return line
      const expanded = tokens.map((token) => {
        const reminder = KEYWORD_REMINDERS[token]
        return reminder ? `${token} (${reminder})` : token
      })
      return expanded.some((t, i) => t !== tokens[i]) ? expanded.join(', ') : line
    })
    .join('\n')
}

// Tokens are never Standard-legal, so the legality filter drops every one of them —
// which is why a Treasure on the battlefield had no hover preview.
//
// Restricting them to Arena was tried and does not work: `games` is a per-*printing*
// field, and the bulk file keeps one printing per oracle id. It picked a paper-only
// printing of Treasure (`games: ["paper"]`), so the filter matched 24 of 1,006
// tokens and excluded the very one that prompted this. Every token is kept instead —
// about 1,006 records against 5,164 cards, and a token record is small.
function isToken(card: ScryfallCard): boolean {
  return card.layout === 'token' || card.layout === 'double_faced_token'
}

function toCardRecord(card: ScryfallCard): CardRecord {
  const scryfallFaces = card.card_faces ?? []
  const rawOracleText = card.oracle_text ?? scryfallFaces.map((face) => face.oracle_text).filter(Boolean).join('\n\n')

  const faces: CardFace[] = scryfallFaces.map((face) => ({
    name: face.name,
    manaCost: face.mana_cost,
    typeLine: face.type_line ?? '',
    oracleText: expandKeywordReminders(face.oracle_text ?? ''),
    power: face.power,
    toughness: face.toughness,
    loyalty: face.loyalty,
  }))

  return {
    id: card.id,
    oracleId: card.oracle_id ?? card.id,
    isToken: isToken(card) || undefined,
    name: card.name,
    normalizedName: normalizeCardName(card.name),
    aliases: scryfallFaces.map((face) => face.name).filter(Boolean),
    manaCost: card.mana_cost ?? scryfallFaces.map((face) => face.mana_cost).filter(Boolean).join(' // '),
    typeLine: card.type_line ?? '',
    oracleText: expandKeywordReminders(rawOracleText),
    colors: card.colors ?? mergeFaceColors(scryfallFaces),
    colorIdentity: card.color_identity ?? [],
    power: card.power,
    toughness: card.toughness,
    loyalty: card.loyalty,
    faces: faces.length > 0 ? faces : undefined,
    imageUris: card.image_uris ?? scryfallFaces[0]?.image_uris ?? {},
    faceImageUris: scryfallFaces.map((face) => face.image_uris).filter((imageUris): imageUris is CardImageUris => Boolean(imageUris)),
    set: card.set,
    collectorNumber: card.collector_number,
    rarity: card.rarity,
  }
}

function mergeFaceColors(faces: ScryfallCard['card_faces']) {
  const colorSet = new Set<MtgColor>()
  faces?.forEach((face) => face.colors?.forEach((color) => colorSet.add(color)))
  return Array.from(colorSet)
}
