// A standalone HTML rendering of a replay: same colours, same hover previews, no
// JavaScript. Everything the viewer needs is in the file except the card images,
// which stay as Scryfall URLs — embedding them would turn a 40KB file into tens of
// megabytes, and the app already loads previews from exactly these URLs.
//
// The hover is CSS only. The app positions previews with JS so they can flip sides
// near a window edge; a static file cannot, so the preview is anchored below-right
// of the name and allowed to be clipped at the very edge rather than carrying a
// script just for that.

import type { CardRecord } from './types'
import { normalizeCardName } from './arena'
import { formatMatchFormat, matchRecord, opponentLabel, summaryCardLabel, tokenPreviewAt } from './replayExport'
import type { ReplayDecklist, ReplayExtras, ReplaySummary } from './replayExport'

const KIND_COLORS: Record<string, string> = {
  turn: '#e7e9ea',
  opening: '#d8c89a',
  cast: '#e7e9ea',
  activate: '#e7e9ea',
  attack: '#e7e9ea',
  damage: '#e0a39b',
  life: '#e0a39b',
  library: '#e0a39b',
  draw: '#8b97a3',
  resolve: '#8b97a3',
  mill: '#a98bc4',
  token: '#d9b87a',
  counter: '#d9b87a',
  attach: '#d9b87a',
  choice: '#c9a7d6',
  select: '#8f9bab',
  scry: '#8f9bab',
  search: '#8f9bab',
  mana: '#6f7d8c',
  counts: '#7e8a95',
  unresolved: '#b58a8a',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function previewImages(card?: CardRecord): string[] {
  const faces = card?.faceImageUris
    ?.map((uris) => uris.normal ?? uris.large)
    .filter((url): url is string => Boolean(url)) ?? []
  if (faces.length > 0) return faces
  const single = card?.imageUris?.normal ?? card?.imageUris?.large
  return single ? [single] : []
}

// Wraps each card name the event declared, exactly as the on-screen narration does:
// the names come from the event rather than being searched for, so no stray word in
// the prose can light up.
function renderText(
  text: string,
  names: string[],
  cardByName: Map<string, CardRecord>,
  event?: MtgaGameEvent,
): string {
  const wanted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
  if (wanted.length === 0) return escapeHtml(text)

  let out = ''
  let plain = ''
  let at = 0

  while (at < text.length) {
    const hit = wanted.find((name) => text.startsWith(name, at))
    if (!hit) {
      plain += text[at]
      at += 1
      continue
    }
    out += escapeHtml(plain)
    plain = ''

    const token = event ? tokenPreviewAt(text, at, hit, event, cardByName) : null
    const images = previewImages(token ?? cardByName.get(normalizeCardName(hit)))
    out += images.length > 0
      ? `<span class="c">${escapeHtml(hit)}<span class="p">${
        images.map((url) => `<img src="${escapeHtml(url)}" alt="" loading="lazy">`).join('')
      }</span></span>`
      : escapeHtml(hit)
    at += hit.length
  }

  return out + escapeHtml(plain)
}

// The seen-cards summary. Names keep their hover previews, the same way the narration
// does, since a list of cards is exactly where wanting to see one is most likely.
function renderSummary(
  summary: ReplaySummary | undefined,
  cardByName: Map<string, CardRecord>,
): string {
  if (!summary) return ''

  const seen = summary.cards.length > 0
    ? `<p class="summary"><span class="summary-label">${escapeHtml(summary.label)}</span>${
      renderText(
        summary.cards.map(([name, count]) => summaryCardLabel(name, count)).join('; '),
        summary.cards.map(([name]) => name),
        cardByName,
      )
    }</p>`
    : ''

  // The basis rides on the title, as it does on screen. `title` works in a static file
  // with no script, which is what makes the tooltip possible here at all.
  const boarded = summary.boarded
    ? `<p class="summary boarded" title="${escapeHtml(summary.boarded.basis)}"><span class="summary-label">${
      escapeHtml(summary.boarded.label)
    }</span>${renderText(
      summary.boarded.cards
        .map((entry) => `${summaryCardLabel(entry.name, entry.count)}${entry.unlisted ? ' *' : ''}`)
        .join('; '),
      summary.boarded.cards.map((entry) => entry.name),
      cardByName,
    )}${
      summary.boarded.note ? `<span class="note">${escapeHtml(summary.boarded.note)}</span>` : ''
    }</p>`
    : ''

  return `${seen}${boarded}`
}

// The matchup's list on file. Laid out as the tab lays it out — a heading column
// beside its cards — rather than as the plain vertical list the text export uses,
// since this file is the one that is supposed to look like the app.
function renderDecklist(
  decklist: ReplayDecklist | undefined,
  cardByName: Map<string, CardRecord>,
): string {
  if (!decklist) return ''

  const sections = decklist.sections.map((section) => `<div class="dl-row"><span class="dl-head">${
    escapeHtml(section.heading)
  }</span><span class="dl-cards">${
    section.cards.map(([name, quantity]) => {
      const images = previewImages(cardByName.get(normalizeCardName(name)))
      const label = escapeHtml(`${quantity} ${name}`)
      return images.length > 0
        ? `<span class="c">${label}<span class="p">${
          images.map((url) => `<img src="${escapeHtml(url)}" alt="" loading="lazy">`).join('')
        }</span></span>`
        : `<span>${label}</span>`
    }).join('')
  }</span></div>`).join('')

  return `<div class="dl"><p class="dl-title">${escapeHtml(decklist.label)}<span>${
    escapeHtml(decklist.counts)
  }</span></p>${sections}</div>`
}

// Our own boarding. Stated as fact, and in its own panel rather than folded into the
// opponent's inference above it.
function renderBoarding(
  game: MtgaGame,
  cardByName: Map<string, CardRecord>,
  show?: boolean,
): string {
  if (!show || !game.sideboarding) return ''

  const row = (label: string, cards: Array<{ name: string; count: number }>) => {
    if (cards.length === 0) return ''
    const copies = cards.reduce((sum, card) => sum + card.count, 0)
    return `<span class="summary-label">${escapeHtml(`${label} — ${copies} card${
      copies === 1 ? '' : 's'
    }`)}</span>${renderText(
      cards.map((card) => summaryCardLabel(card.name, card.count)).join('; '),
      cards.map((card) => card.name),
      cardByName,
    )}`
  }

  const body = `${row('You boarded in', game.sideboarding.in)}${
    row('You boarded out', game.sideboarding.out)
  }`
  return body ? `<p class="summary mine">${body}</p>` : ''
}

function renderGame(
  game: MtgaGame,
  cardByName: Map<string, CardRecord>,
  summary?: ReplaySummary,
  boarding?: boolean,
): string {
  const outcome = game.won === null ? 'unfinished' : game.won ? 'won' : 'lost'
  const start = game.onThePlay === null ? '' : game.onThePlay ? 'on the play' : 'on the draw'

  const lines = game.events.map((event) => {
    const names = [...(event.cards ?? []), ...(event.card ? [event.card] : [])].filter(Boolean)
    const body = renderText(event.text, names, cardByName, event)
    if (event.kind === 'turn') return `<h3>${body}</h3>`
    return `<p class="e ${escapeHtml(event.kind)}">${body}</p>`
  })

  return `<section><h2>Game ${game.gameNumber}<span class="meta">${
    [start, outcome, `${game.maxTurn} turns`].filter(Boolean).map(escapeHtml).join(' · ')
  }</span></h2>${renderBoarding(game, cardByName, boarding)}${
    renderSummary(summary, cardByName)
  }${lines.join('')}</section>`
}

export function buildReplayHtml(
  match: MtgaMatch,
  game: MtgaGame | undefined,
  archetype: string | undefined,
  cardByName: Map<string, CardRecord>,
  extras: ReplayExtras = {},
): string {
  const { summaries, decklist, boarding } = extras
  const games = game ? [game] : match.games
  const record = matchRecord(match.games)
  const played = new Date(match.playedAt)
  const title = `${opponentLabel(match.opponent, archetype)} — ${record.line}`

  const facts = [
    match.deckName ? `Deck: ${match.deckName}` : null,
    `Opponent: ${opponentLabel(match.opponent, archetype)}`,
    Number.isNaN(played.getTime()) ? null : `Played: ${played.toLocaleString()}`,
    match.matchWinCondition ? `Format: ${formatMatchFormat(match.matchWinCondition)}` : null,
    `Match result: ${record.line}`,
    game ? `This file: game ${game.gameNumber} of ${match.games.length}` : null,
  ].filter(Boolean) as string[]

  const kindRules = Object.entries(KIND_COLORS)
    .map(([kind, color]) => `.${kind}{color:${color}}`)
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}
body{background:#14181c;color:#c8d0d8;font:13.5px/1.55 "Segoe UI",system-ui,sans-serif;margin:0;padding:24px}
.wrap{max-width:1100px;margin:0 auto}
h1{color:#e7e9ea;font-size:20px;margin:0 0 4px}
.facts{color:#8b97a3;font-size:12px;margin:0 0 20px}
.facts span{margin-right:14px;white-space:nowrap}
h2{align-items:baseline;border-bottom:1px solid #2c343c;color:#e7e9ea;display:flex;font-size:15px;gap:10px;
   letter-spacing:.02em;margin:26px 0 4px;padding-bottom:6px}
h2 .meta{color:#5a6670;font-size:12px;font-weight:400;text-transform:uppercase}
h3{color:#e7e9ea;font-size:13.5px;letter-spacing:.02em;margin:18px 0 6px}
.e{margin:0 0 0 16px;padding-left:16px;text-indent:-16px}
${kindRules}
.summary{background:#171b1f;border:1px solid #262d34;border-radius:8px;color:#c8d0d8;font-size:13px;
         margin:0 0 14px;padding:8px 10px}
.summary-label{color:#8b97a3;display:block;font-size:12px;margin-bottom:3px}
.boarded{border-color:#3d3524}
.mine{border-color:#24382c}
.mine .summary-label{color:#8fcfa6;margin-top:6px}
.mine .summary-label:first-child{margin-top:0}
.boarded .summary-label{color:#d9b87a}
.boarded .note{color:#7e8a95;display:block;font-size:11px;margin-top:4px}
h2 + .summary{margin-top:10px}
.dl{background:#171b1f;border:1px solid #262d34;border-radius:8px;margin:0 0 14px;padding:8px 10px}
.dl-title{color:#e7e9ea;font-size:13px;margin:0 0 7px}
.dl-title span{color:#7e8a95;font-size:12px;margin-left:8px}
.dl-row{display:flex;flex-wrap:wrap;gap:4px 10px;margin-bottom:6px}
.dl-head{color:#7e8a95;flex:0 0 118px;font-size:12px;letter-spacing:.03em;text-transform:uppercase}
.dl-cards{color:#c8d0d8;display:flex;flex:1 1 0;flex-wrap:wrap;font-size:13px;gap:4px 14px;min-width:0}
.mana{font-style:italic}
.unresolved{font-style:italic}
.gameend{border-top:1px solid #2c343c;color:#e7e9ea;font-weight:700;letter-spacing:.04em;
         margin-top:10px;padding:10px 0 0;text-indent:0;text-transform:uppercase}
/* Hover previews, CSS only. */
.c{border-bottom:1px dotted rgba(200,208,216,.45);cursor:help;position:relative}
.c:hover{border-bottom-color:#d8c89a;color:#fff}
.p{background:#080a0c;border-radius:8px;box-shadow:0 22px 70px rgba(0,0,0,.65);display:none;gap:6px;
   left:0;padding:6px;position:absolute;text-indent:0;top:1.6em;z-index:50}
.c:hover .p{display:flex}
.p img{border-radius:6px;display:block;width:260px}
</style></head>
<body><div class="wrap">
<h1>${escapeHtml(title)}</h1>
<p class="facts">${facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join('')}</p>
${!game && match.games.length > 1 ? renderSummary(summaries?.match, cardByName) : ''}
${renderDecklist(decklist, cardByName)}
${games.map((entry) => renderGame(entry, cardByName, summaries?.games.get(entry.gameNumber), boarding)).join('')}
</div></body></html>`
}
