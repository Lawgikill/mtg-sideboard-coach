const fs = require('node:fs')
const readline = require('node:readline')

// Turns an MTGA Player.log into structured, narratable games.
//
// Shape of the data, confirmed against a real Bo3 log rather than assumed:
//   - Game payloads are single-line JSON under `greToClientEvent`. Much of the rest
//     of the file is pretty-printed multi-line JSON, which a line-by-line parse must
//     simply skip (it is UI chatter, not game state).
//   - The match identifier is `gameInfo.matchID` — capital ID. `matchId` finds nothing.
//   - State arrives as one `GameStateType_Full` per game followed by hundreds of
//     `Diff`s, so anything needed later has to be accumulated as it streams past.

const ZONE_ALIASES = {
  ZoneType_Hand: 'hand',
  ZoneType_Library: 'library',
  ZoneType_Graveyard: 'graveyard',
  ZoneType_Battlefield: 'battlefield',
  ZoneType_Exile: 'exile',
  ZoneType_Stack: 'stack',
  ZoneType_Sideboard: 'sideboard',
  ZoneType_Revealed: 'revealed',
  ZoneType_Limbo: 'limbo',
  ZoneType_Command: 'command',
}

// Exile is a shared zone, so it takes no possessive; a graveyard or library is the
// caster's own. The hand is the default and says nothing.
// MTGA writes mana symbols as {oT}/{o1} and uses CARDNAME as a placeholder. Only the
// effect is kept — everything before the first colon is the cost, which the
// narration already shows as the sacrifice or tap that paid it.
// Ability text as stored by MTGA, made readable: mana symbols, the card's own name,
// and no trailing period. Used for modes, which are shown whole.
function cleanAbilityText(text, cardName) {
  if (!text) return null
  return text
    .replace(/\{o([^}]+)\}/g, '{$1}')
    .replace(/CARDNAME/g, cardName || 'this card')
    .trim()
    .replace(/\.$/, '') || null
}

// A granted keyword as it reads mid-sentence: "Double strike" -> "double strike",
// "Ward {o1}" -> "ward {1}". Null for rules text, which MTGA always ends with a
// period, so only a keyword ever comes back.
function keywordText(text) {
  if (!text || /[."]\s*$/.test(text.trim())) return null
  const cleaned = cleanAbilityText(text)
  return cleaned ? cleaned.charAt(0).toLowerCase() + cleaned.slice(1) : null
}

function abilityEffect(text, cardName) {
  if (!text) return null
  const cleaned = text
    .replace(/\{o([^}]+)\}/g, '{$1}')
    .replace(/CARDNAME/g, cardName)
    .trim()
  const colon = cleaned.indexOf(': ')
  const effect = colon === -1 ? cleaned : cleaned.slice(colon + 2)
  return dropRestrictions(effect).replace(/\.$/, '') || null
}

// Sentences saying when an ability may be activated ("Activate only as a sorcery",
// "…only once each turn", "…only if you control…") are dropped from activation lines.
// They describe legality, not what happened, and an activation that appears in the
// log has by definition already satisfied them, so in a replay they can never say
// anything. MTGA templates all ~620 of them as a sentence starting `Activate only`.
//
// Two traps, both found in MTGA's own ability table:
// - a restriction can follow a closing quote (`…can't be blocked." Activate only as a
//   sorcery`), so sentences split after `.` *or* `."`;
// - a restriction can sit inside a quoted ability the card grants to something else,
//   and cutting that would describe the wrong ability and strand a quote mark, so
//   only sentences outside quotes are dropped.
//
// The original whitespace between kept sentences is preserved. Rejoining with plain
// spaces collapsed the line breaks between modal bullets (`Choose one — •A •B`) in
// hundreds of abilities that have no restriction at all.
function dropRestrictions(effect) {
  // Splitting on a captured separator keeps it: [sentence, gap, sentence, gap, …].
  const parts = effect.split(/((?<=[.!]"?)\s+)/)
  let out = ''
  let quotes = 0
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i]
    const insideQuote = quotes % 2 === 1
    quotes += (sentence.match(/"/g) || []).length
    if (!insideQuote && /^Activate only\b/.test(sentence)) continue
    out += (out && i > 0 ? parts[i - 1] : '') + sentence
  }
  return out
}

// Where a card left from, said only when it was not the battlefield. "Is exiled"
// reads as coming off the board, so a graveyard or hand needs naming; the
// battlefield is the default and says nothing. The owning player is named because a
// card can be exiled from either graveyard.
function departureZone(fromKind, owner, label) {
  if (!fromKind || fromKind === 'battlefield' || fromKind === 'stack') return ''
  if (fromKind === 'exile') return ' from exile'
  return owner != null ? ` from ${label}'s ${fromKind}` : ` from the ${fromKind}`
}

function castOrigin(fromKind) {
  if (!fromKind || fromKind === 'hand' || fromKind === 'stack') return ''
  if (fromKind === 'exile') return ' from exile'
  return ` from their ${fromKind}`
}

// "Lavaspur Boots' ability", "Map's ability".
function possessive(name) {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`
}

function detailsToObject(annotation) {
  const out = {}
  for (const detail of annotation.details || []) {
    if (detail.valueInt32 && detail.valueInt32.length) out[detail.key] = detail.valueInt32[0]
    else if (detail.valueString && detail.valueString.length) out[detail.key] = detail.valueString[0]
  }
  return out
}

// detailsToObject keeps only the first value, which is right for a scalar like
// "damage" but loses a list. Scry reports its top and bottom piles as id lists.
function detailList(annotation, key) {
  for (const detail of annotation.details || []) {
    if (detail.key !== key) continue
    return detail.valueInt32 || []
  }
  return []
}

function createGame(gameInfo) {
  return {
    matchId: gameInfo.matchID || null,
    gameNumber: gameInfo.gameNumber || 1,
    matchWinCondition: gameInfo.matchWinCondition || null,
    events: [],
    result: null,
    maxTurn: 0,
    // Seat that took turn 1. Who is on the play is not stated anywhere in the log,
    // but it is exactly this: the player whose turn comes first.
    firstSeat: null,
  }
}

class LogParser {
  constructor(resolveName, resolveChoice, resolveCounter, resolveAbility, resolveAbilityText) {
    this.resolveName = resolveName
    this.resolveChoice = resolveChoice || (() => null)
    this.resolveCounter = resolveCounter || (() => null)
    this.resolveSubType = () => null
    this.resolveAbility = resolveAbility || (() => null)
    this.resolveAbilityText = resolveAbilityText || (() => null)
    // Ability instance -> where its line belongs, captured when it goes on the
    // stack. Its costs are paid before the activation is committed, so the line has
    // to be put back above them.
    this.abilityOpenedAt = new Map()
    // Activated abilities on the stack and not yet resolved: ability instance ->
    // { source, seat }. One deleted while still here never resolved.
    this.openActivations = new Map()
    // A ward trigger part-way through resolving: { id, cost, source, payer, paid }.
    this.wardResolving = null
    this.games = []
    this.submittedDecks = []
    this.game = null
    this.seatNames = {}
    this.localSeat = null
    this.seatMessageCounts = new Map()
    this.matchCompletedReason = null
    this.finalGameResults = []
    this.cancelledCasts = new Set()
    this.messageIndex = 0
    this.pendingSearch = null
    // Ability instances in the message being handled that are mana abilities.
    this.manaAbilities = new Set()
    // True from a card reaching the stack until its cast is committed.
    this.castingOpen = false
    // instanceId -> grpId. Objects are renumbered as they change zones, so this has
    // to follow ObjectIdChanged or a card loses its name the moment it is played.
    this.objectGrp = new Map()
    // instanceId -> controlling seat, so a token can be attributed to its owner.
    this.objectController = new Map()
    // Enough state to answer "what mana is the other player holding up".
    this.objectTypes = new Map()
    this.objectZone = new Map()
    this.objectTapped = new Map()
    // instanceId -> latest { power, toughness }, with every modifier already applied.
    this.objectStats = new Map()
    // instanceId -> { value, msg }: a planeswalker's loyalty and the message reporting it.
    this.objectLoyalty = new Map()
    // Instances that are copies (`isCopy`), such as an offspring token.
    this.objectCopies = new Set()
    // instanceId -> { creature, onBattlefield } as last reported, to notice a permanent
    // that turns into a creature.
    this.objectShape = new Map()
    // Ability instance -> the grpId of the card it came from.
    this.abilitySource = new Map()
    // Ability instance -> the instanceId of the permanent that created it.
    this.abilityInstanceOwner = new Map()
    // Which instances are abilities rather than cards. Ability ids and card grpIds
    // share one numeric space, so this is what stops an ability being read as a card.
    this.abilityInstances = new Set()
    this.zones = new Map()
    // Combat lives on gameObjects, not annotations, and those objects repeat in
    // every diff — so attacks are detected as state *changes*, not presence.
    this.attackState = new Map()
    this.blockState = new Map()
    this.phase = ''
    this.step = ''
    this.turn = 0
    this.activeSeat = null
    this.life = {}
    // seat -> instanceIds currently in hand. Kept so the opening hand can be
    // reported once turn 1 is announced, which is the first moment the London
    // mulligan has finished putting cards back.
    this.handZones = new Map()
    this.openingReported = false
    // zoneId -> card count, so running out of cards can be reported once.
    this.libraryCounts = new Map()
    // seat -> cards held / left to draw, carried forward. A diff only mentions zones
    // that changed, so the opponent's library goes unmentioned for turns at a time.
    this.handSizes = new Map()
    this.librarySizes = new Map()
    // Every distinct hand a seat held during mulligan resolution, oldest first. Only
    // our own: the opponent's hand ids resolve to nothing, so there is no history to
    // keep. This is what recovers the hand that was shuffled away.
    this.handHistory = new Map()
    // seat -> name -> copies still expected to go to the bottom, so the transfer that
    // performs the bottoming can be dropped once it has been reported.
    this.pendingBottoms = new Map()
    this.emptyLibraries = new Set()
    // Persistent AddAbility annotation id -> instance ids already reported as gaining it.
    this.grantsSeen = new Map()
    // seat -> how many turns that player has taken. MTGA counts turns globally
    // (1, 2, 3 alternating between players); the narration counts each player's own
    // turns instead, so both players show a Turn 1, a Turn 2 and so on.
    this.seatTurns = new Map()
    // ability instance -> its chosen targets, already resolved to names, waiting for
    // the activation line. Cleared every turn so a stale entry cannot be picked up by
    // a later ability that happens to reuse the id.
    this.abilityTargets = new Map()
    // Casting-time answers from findCastingChoices, consumed in request order.
    this.castingChoices = []
    this.castingRequestIndex = 0
  }

  // Records what a spell or an activated ability was pointed at.
  //
  // Names are resolved *now*, not later: instance ids are renumbered and reused
  // within a game, so reading them at the end of the parse attributed Meltstrider's
  // Resolve to whatever had inherited id 334 by then. For the same reason this
  // patches the most recent matching cast rather than keying a map by id — two
  // different spells genuinely shared id 424 in one game.
  recordTargets(sourceId, targetIds) {
    if (!this.game) return

    const labels = targetIds.map((id) => this.targetLabel(id)).filter(Boolean)
    const cards = targetIds.map((id) => this.nameOf(id)).filter(Boolean)

    for (let i = this.game.events.length - 1; i >= 0; i -= 1) {
      const event = this.game.events[i]
      if (event.kind === 'turn') break
      if (event.kind !== 'cast' || event.instanceId !== sourceId) continue

      // A later request supersedes an earlier one, so changing a target before
      // confirming leaves only the final choice.
      event.targetLabels = labels
      event.targetCards = cards
      return
    }

    // No cast to patch: an activated ability, whose targets are chosen *before* its
    // line exists — the activation line is written on the commitment, which comes
    // after. Held, already named, until then. Superseded the same way.
    this.abilityTargets.set(sourceId, { labels, cards })
  }

  // A casting-time answer, onto the cast line it belongs to. Patched like targets, and
  // for the same reason resolved to text now rather than later. The cast must be the
  // same instance *and* the same card: a reply to an attempt that was then cancelled
  // has no cast line of its own, and must not land on whatever reused the id.
  recordCastingChoice(request, choice) {
    if (!this.game) return
    const option = (request.castingTimeOptionReq || []).find((entry) => entry.ctoId === choice.ctoId)
    if (!option) return

    const spellId = option.affectedId
    const spell = this.nameOf(spellId)
    const cast = [...this.game.events].reverse().find((event, index, all) =>
      event.kind === 'cast' && event.instanceId === spellId && event.card === spell
      && !all.slice(0, index).some((later) => later.kind === 'turn'))
    if (!cast) return

    if (choice.type === 'CastingTimeOptionType_AdditionalCost') {
      // "Offspring {o2}" -> "offspring"; the same for kicker, bargain, gift.
      const text = this.resolveAbilityText(option.grpId) || ''
      const keyword = text.match(/^([A-Za-z][A-Za-z' ]*?)(?=\s*(\{|\(|—|$))/)
      cast.paidCost = keyword ? keyword[1].toLowerCase() : 'an additional cost'
    }

    if (choice.type === 'CastingTimeOptionType_Modal' && choice.modes.length > 0) {
      cast.modes = choice.modes
        .map((grpId) => cleanAbilityText(this.resolveAbilityText(grpId), spell))
        .filter(Boolean)
    }
  }

  // Renders the recorded targets onto the cast or activation line, before
  // collapseCastResolve rewrites the cast text.
  attachTargets(events) {
    return events.map((event) => {
      if (event.kind !== 'cast' && event.kind !== 'activate') return event
      const targets = event.targetLabels && event.targetLabels.length > 0
      if (!targets && !event.paidCost && !(event.modes && event.modes.length)) return event

      // Cost, then mode, then targets: the mode says what the targets are for.
      const cost = event.paidCost ? ` with ${event.paidCost}` : ''
      const modes = event.modes && event.modes.length
        ? `, choosing ${joinList(event.modes.map((mode) => `"${mode}"`))}`
        : ''
      if (!targets) return { ...event, text: `${event.text}${cost}${modes}` }
      return {
        ...event,
        text: `${event.text}${cost}${modes}, targeting ${joinList(countedList(event.targetLabels))}`,
        // Target names stay hoverable alongside the spell's own name.
        cards: [...(event.cards || []), ...(event.targetCards || [])],
      }
    })
  }

  // The seat that is not this one. Two-player games only, which is all MTGA's
  // constructed queues produce.
  otherSeat(seat) {
    const seats = Object.keys(this.life).map(Number)
    return seats.find((candidate) => candidate !== seat) ?? null
  }

  landStatus(seat) {
    let total = 0
    let untapped = 0
    for (const [id, controller] of this.objectController) {
      if (controller !== seat) continue
      if (this.zoneKind(this.objectZone.get(id)) !== 'battlefield') continue
      if (!(this.objectTypes.get(id) || []).includes('CardType_Land')) continue
      total += 1
      if (!this.objectTapped.get(id)) untapped += 1
    }
    return { total, untapped }
  }

  // Writes the held-open search line, in the position it was opened so it reads
  // before the cards it reports on rather than after them.
  //
  // Worth stating even when nothing was taken: a search that found nothing useful
  // is otherwise completely invisible — the permanent resolves and the narration
  // simply moves on.
  concludeSearch() {
    const search = this.pendingSearch
    this.pendingSearch = null
    if (!search || !this.game) return

    const options = `${search.candidates} option${search.candidates === 1 ? '' : 's'}`
    const credit = search.source ? ` (${search.source})` : ''
    const named = search.cards.filter(Boolean)

    // The cards taken are absorbed into this line rather than repeated on their own
    // one directly below it. A colon introduces the list, as it does for milling and
    // discarding. Everything absorbed sits after the line's own position, so
    // removing it first leaves that index valid.
    const absorbed = new Set(search.absorbed)
    if (absorbed.size > 0) {
      this.game.events = this.game.events.filter((_, index) => !absorbed.has(index))
    }

    const taken = named.length === search.taken && named.length > 0
      ? `: ${joinList(named)}`
      : ''

    this.game.events.splice(search.at, 0, {
      turn: this.turn,
      kind: 'search',
      text: `${this.seatLabel(search.seat)} searches their library and takes ${search.taken} of ${options}${taken}${credit}`,
      seat: search.seat,
      source: search.source,
      cards: named,
    })
  }

  // What caused a card to leave the battlefield. The affector is an ability
  // instance rather than a card, so this follows the same link that attributes
  // tokens and counters — a triggered ability's destroy is otherwise a passive
  // sentence with no agent at all.
  //
  // Suppressed when the cause is the card itself, which reads as two permanents.
  causeOf(annotation, targetName) {
    const source = this.sourceOf(annotation.affectorId)
    return source && source !== targetName ? source : null
  }

  // Which permanent an effect came from, as an instance rather than a name. Two
  // copies of one card are one `source` but two `sourceId`s, which is what lets a
  // merged run say how many of them fired.
  causeInstance(annotation) {
    return this.abilityInstanceOwner.get(annotation.affectorId) ?? annotation.affectorId
  }

  isCancelled(instanceId) {
    return instanceId != null && this.cancelledCasts.has(`${this.messageIndex}:${instanceId}`)
  }

  // The card behind an effect. An annotation's affector is usually an ability
  // instance rather than a card, so this follows that link before giving up.
  sourceOf(instanceId) {
    if (instanceId == null) return null
    const direct = this.nameOf(instanceId)
    if (direct) return direct
    const grpId = this.abilitySource.get(instanceId)
    if (grpId) return this.resolveName(grpId)
    const owner = this.abilityInstanceOwner.get(instanceId)
    if (owner != null) {
      const named = this.nameOf(owner)
      if (named) return named
    }
    // Last resort: the object's own grpId is an *ability* id rather than a card's,
    // which is how an effect like Brightglass Gearhulk's reaches the log when no
    // AbilityInstanceCreated named it.
    const ownGrp = this.objectGrp.get(instanceId)
    return ownGrp ? this.resolveAbility(ownGrp) : null
  }

  nameOf(instanceId) {
    // Never name an ability as a card. The two share a numeric id space: 96309 is
    // both the card "District Mascot" and Soul-Guide Lantern's enters-trigger, so
    // its resolution narrated as "District Mascot resolves" and its exile was
    // credited to that card. Abilities resolve through sourceOf instead.
    if (this.abilityInstances.has(instanceId) || this.abilityInstanceOwner.has(instanceId)) return null
    const grpId = this.objectGrp.get(instanceId)
    if (!grpId) return null
    return this.resolveName(grpId) || null
  }

  // Always the player's name, never "You". Every line of the narration names both
  // players, so a second-person label for one of them reads as a different voice —
  // and because localSeat is only resolved in finish(), it appeared on exactly the
  // lines built there and nowhere else: a dangling library search rendered as "You
  // searches their library" among a page of "Lawgikill ...".
  //
  // This is what the "use seatNames directly in finish()" rule existed to work
  // around; with the branch gone there is nothing to work around.
  seatLabel(seat) {
    if (seat == null) return 'Someone'
    return this.seatNames[seat] || `Seat ${seat}`
  }

  zoneOwner(zoneId) {
    const zone = this.zones.get(zoneId)
    return zone ? zone.owner : null
  }

  zoneKind(zoneId) {
    const zone = this.zones.get(zoneId)
    return zone ? zone.kind : null
  }

  push(kind, text, extra = {}) {
    if (!this.game) return
    // Anything emitted between a card reaching the stack and the cast being
    // committed is a cost being paid — a painland's life, a Treasure sacrificed.
    // Flagged so the cast/resolve collapse can refuse to swallow it.
    const duringCast = this.castingOpen && kind !== 'cast' ? { duringCast: true } : {}
    this.game.events.push({ turn: this.turn, kind, text, ...duringCast, ...extra })
  }

  handleMessage(message) {
    if (message.systemSeatIds && message.systemSeatIds.length === 1) {
      const seat = message.systemSeatIds[0]
      this.seatMessageCounts.set(seat, (this.seatMessageCounts.get(seat) || 0) + 1)
    }

    // The deck this client submitted. Captured so a parsed game can be matched back
    // to a deck in the app; a Bo3 may re-submit after sideboarding, so keep each.
    const submitted = message.submitDeckReq || message.submitDeckConfirmation
    if (submitted && submitted.deck) {
      this.submittedDecks.push({
        gameNumber: this.game ? this.game.gameNumber : null,
        main: (submitted.deck.deckCards || []).slice(),
        sideboard: (submitted.deck.sideboardCards || []).slice(),
      })
    }

    // What a spell was pointed at. This arrives as a *targeting request* rather than
    // an annotation, and only ever reaches the player doing the choosing — so this
    // recovers targets for our own spells and can never see the opponent's.
    //
    // The pick is read from entries offering SelectAction_Unselect: once a target is
    // chosen, the only thing left to do with it is take it back. Later requests for
    // the same source supersede earlier ones, so changing a target before confirming
    // leaves the final choice.
    if (message.castingTimeOptionsReq) {
      const entry = this.castingChoices[this.castingRequestIndex]
      this.castingRequestIndex += 1
      if (entry && entry.choice && entry.msgId === message.msgId && entry.gameStateId === message.gameStateId) {
        this.recordCastingChoice(message.castingTimeOptionsReq, entry.choice)
      }
    }

    if (message.selectTargetsReq && message.selectTargetsReq.sourceId != null) {
      const request = message.selectTargetsReq
      const chosen = []
      for (const slot of request.targets || []) {
        for (const candidate of slot.targets || []) {
          if (candidate.legalAction === 'SelectAction_Unselect' && candidate.targetInstanceId != null) {
            chosen.push(candidate.targetInstanceId)
          }
        }
      }
      if (chosen.length > 0) this.recordTargets(request.sourceId, chosen)
    }

    // A library search. The request names every legal candidate and the limit, but
    // not what was taken — that only becomes clear from the Put transfers that
    // follow, so the line is held open until the search concludes.
    if (message.searchReq && this.game) {
      this.concludeSearch()
      this.pendingSearch = {
        seat: (message.systemSeatIds || [])[0],
        source: this.sourceOf(message.searchReq.sourceId),
        candidates: (message.searchReq.itemsSought || []).length,
        taken: 0,
        cards: [],
        absorbed: [],
        // Where the line belongs: before the cards it reports on.
        at: this.game.events.length,
      }
    }

    const state = message.gameStateMessage
    if (!state) return

    if (state.gameInfo) this.handleGameInfo(state.gameInfo)

    const emptied = []
    for (const zone of state.zones || []) {
      this.zones.set(zone.zoneId, {
        kind: ZONE_ALIASES[zone.type] || zone.type,
        owner: zone.ownerSeatId ?? null,
      })
      if (zone.type === 'ZoneType_Hand' && zone.objectInstanceIds && zone.ownerSeatId != null) {
        this.handZones.set(zone.ownerSeatId, zone.objectInstanceIds.slice())
      }

      // Hand and library sizes for the turn-end summary. A hidden or private zone
      // still ships one placeholder id per card, so the array length is the count
      // even where the identities are not ours to see — which is what makes the
      // opponent's hand size knowable at all. Unlike handZones above this reads an
      // absent list as empty rather than skipping, since a zone named in a diff is
      // being reported: protobuf simply omits the list when there is nothing in it.
      if (zone.ownerSeatId != null) {
        const held = (zone.objectInstanceIds || []).length
        if (zone.type === 'ZoneType_Hand') this.handSizes.set(zone.ownerSeatId, held)
        if (zone.type === 'ZoneType_Library') this.librarySizes.set(zone.ownerSeatId, held)
      }

      // Running out of cards is a loss the log never states, but the library hitting
      // zero is plain fact and explains an ending that otherwise just stops.
      //
      // Reported only on the transition, and only once a positive count has been
      // seen for that zone: an empty list is indistinguishable from an omitted one,
      // so without that guard an early message could read as an empty library.
      if (zone.type === 'ZoneType_Library' && zone.ownerSeatId != null) {
        const count = (zone.objectInstanceIds || []).length
        const previous = this.libraryCounts.get(zone.zoneId)
        this.libraryCounts.set(zone.zoneId, count)
        if (count === 0 && previous > 0 && !this.emptyLibraries.has(zone.zoneId)) {
          this.emptyLibraries.add(zone.zoneId)
          // Held back rather than pushed here: zones are read before annotations, so
          // reporting now puts "library is empty" above the mill that emptied it.
          emptied.push(zone.ownerSeatId)
        }
      }
    }
    for (const player of state.players || []) {
      if (player.systemSeatNumber != null) this.life[player.systemSeatNumber] = player.lifeTotal
    }
    for (const object of state.gameObjects || []) {
      if (object.instanceId == null) continue
      if (object.grpId) this.objectGrp.set(object.instanceId, object.grpId)
      if (object.controllerSeatId != null) this.objectController.set(object.instanceId, object.controllerSeatId)
      if (object.cardTypes) this.objectTypes.set(object.instanceId, object.cardTypes)
      if (object.zoneId != null) this.objectZone.set(object.instanceId, object.zoneId)
      // Presence in a message makes the value authoritative, and an omitted boolean
      // means false — protobuf drops false rather than sending it. Carrying the
      // previous value forward instead left every land reading as permanently
      // tapped, since untapping is exactly the message that omits the field.
      this.objectTapped.set(object.instanceId, Boolean(object.isTapped))
      this.noticeAnimation(object)

      // Presence-authoritative, like isTapped: protobuf drops a false.
      if (object.isCopy) this.objectCopies.add(object.instanceId)
      else this.objectCopies.delete(object.instanceId)
      // Live power/toughness: counters, equipment, pumps and conditional bonuses are
      // already applied (Keen-Eyed Curator read 3/3, then 4/3 with Lavaspur Boots,
      // then 8/7 once its exile bonus switched on). A value only arrives when it
      // changes, so the last one is kept. **An empty `{}` is zero** — protobuf omits
      // a 0, the same trap as `isTapped` — so presence decides, not the value.
      if (object.power || object.toughness) {
        const previous = this.objectStats.get(object.instanceId) || {}
        this.objectStats.set(object.instanceId, {
          power: object.power ? object.power.value || 0 : previous.power,
          toughness: object.toughness ? object.toughness.value || 0 : previous.toughness,
        })
      }
      // A planeswalker's live loyalty, the same way: Jace read 4, then 2 after a hit,
      // then `{}` — zero — as the second hit killed it. Stamped with the message so a
      // loyalty line only ever states a value reported alongside it, never a stale one.
      if (object.loyalty) {
        this.objectLoyalty.set(object.instanceId, { value: object.loyalty.value || 0, msg: this.messageIndex })
      }
      // An ability on the stack carries the card it came from. Without this the
      // token line can only say a token appeared, not what made it.
      if (object.type === 'GameObjectType_Ability') {
        this.abilityInstances.add(object.instanceId)
        if (object.objectSourceGrpId) this.abilitySource.set(object.instanceId, object.objectSourceGrpId)
      }
      this.trackCombat(object)
    }
    // After the game objects, because that loop is what supplies the grpIds these
    // names resolve through, and before turnInfo, because turn 1 is what closes hand
    // resolution and reports it.
    this.recordHandHistory()

    if (state.turnInfo) this.handleTurnInfo(state.turnInfo)

    // Mana abilities, collected before the annotations are narrated: the action that
    // marks one arrives *after* the sacrifice that paid for it, so a sacrifice
    // cannot tell what it was for without looking ahead.
    this.manaAbilities = new Set()
    for (const annotation of state.annotations || []) {
      if (!(annotation.type || []).includes('AnnotationType_UserActionTaken')) continue
      if (detailsToObject(annotation).actionType !== 4) continue
      for (const id of annotation.affectedIds || []) this.manaAbilities.add(id)
    }

    for (const annotation of state.annotations || []) this.handleAnnotation(annotation)
    this.noticeGrantedAbilities(state)

    for (const seat of emptied) {
      this.push('library', `${this.seatLabel(seat)}'s library is empty`, { seat })
    }
  }

  // A permanent gaining an ability from something: Practiced Offense's double strike,
  // Lavaspur Boots' haste and ward, Spectacular Spider-Man's hexproof and
  // indestructible. No transient annotation says so. It lives in a *persistent*
  // AddAbility annotation naming the source, the permanents and the granted ability
  // ids, re-sent in every message while the effect lasts, so each permanent is reported
  // once, when it first appears in one. It is game state, so the opponent's grants
  // arrive like our own — which is what makes a choice like Practiced Offense's
  // (double strike or lifelink) readable for either player, where the question itself
  // is a private prompt to the caster.
  //
  // Only keywords are narrated. The one granted rules-text ability seen was a
  // Glacierwood Siege granting itself its chosen mode, which "choosing Temur" already
  // says. An AddAbility that is also a Counter is a Hexproof counter, already a line.
  // A ward trigger starting to resolve. Its id must be an ability instance: ability
  // ids and card grpIds share one numeric space, so a spell's grpid must never be read
  // as an ability's text. Only a mana ward is followed ("Ward {1}"); a ward paid in
  // life is rules text to keywordText and has no ManaPaid to show for it anyway.
  openWardPayment(instanceId, grpId) {
    if (!this.abilityInstanceOwner.has(instanceId) && !this.abilityInstances.has(instanceId)) return
    const ward = keywordText(this.resolveAbilityText(grpId))
    if (!ward || !/^ward\s+\{/.test(ward)) return
    this.wardResolving = {
      id: instanceId,
      cost: ward.slice('ward'.length).trim(),
      source: this.sourceOf(instanceId),
      payer: null,
      paid: false,
    }
  }

  // "Rish pays {1} for ward (Keen-Eyed Curator)". Read from the log: the trigger names
  // its permanent, and the payment is mana paid while it resolved — Chandra's -2
  // targeted a Curator wearing Lavaspur Boots, and the tax took the land Chandra had
  // left open, which otherwise made the "tapped out" line look wrong. When ward is not
  // paid there is nothing to say here: the spell or ability is countered, which is
  // already reported. Seen once in the archives.
  closeWardPayment(instanceId) {
    const ward = this.wardResolving
    if (!ward || ward.id !== instanceId) return
    this.wardResolving = null
    if (!ward.paid || ward.payer == null) return
    this.push('ward', `${this.seatLabel(ward.payer)} pays ${ward.cost} for ward${ward.source ? ` (${ward.source})` : ''}`, {
      seat: ward.payer,
      source: ward.source,
    })
  }

  noticeGrantedAbilities(state) {
    for (const id of state.diffDeletedPersistentAnnotationIds || []) this.grantsSeen.delete(id)

    for (const annotation of state.persistentAnnotations || []) {
      const types = annotation.type || []
      if (!types.includes('AnnotationType_AddAbility') || types.includes('AnnotationType_Counter')) continue
      const seen = this.grantsSeen.get(annotation.id) || new Set()
      this.grantsSeen.set(annotation.id, seen)
      const fresh = (annotation.affectedIds || []).filter((id) => !seen.has(id))
      if (fresh.length === 0) continue
      for (const id of fresh) seen.add(id)

      const abilities = detailList(annotation, 'grpid')
        .map((grpId) => keywordText(this.resolveAbilityText(grpId)))
        .filter(Boolean)
      const targets = fresh.map((id) => this.nameOf(id)).filter(Boolean)
      if (abilities.length === 0 || targets.length === 0) continue

      // A permanent granting itself something (Keen-Eyed Curator's trample) needs no
      // credit; anything else names what did it.
      const source = this.sourceOf(annotation.affectorId)
      const credit = source && targets.some((name) => name !== source) ? source : null
      this.push('gain',
        `${joinList(countedList(targets))} ${targets.length > 1 ? 'gain' : 'gains'} ${joinList(abilities)}` +
          `${credit ? ` (${credit})` : ''}`,
        {
          seat: this.objectController.get(fresh[0]),
          card: targets.length === 1 ? targets[0] : null,
          cards: targets,
          source: credit,
        })
    }
  }

  handleGameInfo(gameInfo) {
    const isNewGame = !this.game
      || this.game.matchId !== (gameInfo.matchID || null)
      || this.game.gameNumber !== (gameInfo.gameNumber || 1)

    if (isNewGame) {
      this.game = createGame(gameInfo)
      this.games.push(this.game)
      // Object ids and turn counters restart with each game.
      this.objectGrp = new Map()
      this.objectController = new Map()
      this.objectTypes = new Map()
      this.objectZone = new Map()
      this.objectTapped = new Map()
      this.objectStats = new Map()
      this.objectLoyalty = new Map()
      this.objectCopies = new Set()
      this.objectShape = new Map()
      this.abilitySource = new Map()
      this.abilityInstanceOwner = new Map()
      this.abilityInstances = new Set()
      this.attackState = new Map()
      this.blockState = new Map()
      this.turn = 0
      this.activeSeat = null
      this.handZones = new Map()
      this.openingReported = false
      this.libraryCounts = new Map()
      this.handSizes = new Map()
      this.librarySizes = new Map()
      this.handHistory = new Map()
      this.pendingBottoms = new Map()
      this.emptyLibraries = new Set()
      this.grantsSeen = new Map()
      this.openActivations = new Map()
      this.wardResolving = null
      this.seatTurns = new Map()
    }

    // Results are *cumulative*: once game 1 ends, its result keeps riding along in
    // every later message, including ones stamped with game 2's number. Assigning by
    // the current game number therefore copied game 1's verdict onto game 2. Only a
    // message that says the game is over is reporting that game's own result.
    if (gameInfo.stage === 'GameStage_GameOver') {
      for (const result of gameInfo.results || []) {
        if (result.scope !== 'MatchScope_Game') continue
        const target = this.games.find((game) => game.gameNumber === (gameInfo.gameNumber || 1))
        if (target && !target.result) {
          target.result = { winningTeamId: result.winningTeamId, reason: result.reason }
        }
      }
    }
  }

  targetLabel(targetId) {
    if (targetId == null) return 'someone'
    if (this.seatNames[targetId] !== undefined) return this.seatLabel(targetId)
    return this.nameOf(targetId) || 'a permanent'
  }

  // A permanent turning into a creature: an earthbent land, an animated land, a crewed
  // Vehicle. No annotation states it; the object is simply re-sent with Creature in
  // its card types, so it is noticed by comparing with the last report. Without it a
  // land took counters, was damaged and died with nothing saying why that was possible.
  //
  // Only gaining Creature is reported. Most animations end at end of turn, so the
  // reverse would add a predictable line every turn. Only a permanent already on the
  // battlefield counts: one entering as a creature is not becoming one, and a zone
  // change gives it a new id, so it starts with no history anyway. No size (the
  // counters that animate it often arrive in the same message, so the first size seen
  // already includes them) and no cause (no annotation names one).
  noticeAnimation(object) {
    if (!object.cardTypes) return
    const id = object.instanceId
    const creature = object.cardTypes.includes('CardType_Creature')
    const zoneId = object.zoneId != null ? object.zoneId : this.objectZone.get(id)
    const onBattlefield = this.zoneKind(zoneId) === 'battlefield'
    const before = this.objectShape.get(id)
    this.objectShape.set(id, { creature, onBattlefield })

    if (!before || before.creature || !creature || !before.onBattlefield || !onBattlefield) return
    const name = this.nameOf(id)
    if (!name) return
    this.push('animate', `${name} becomes a creature`, {
      seat: object.controllerSeatId ?? this.objectController.get(id),
      card: name,
    })
  }

  // "(8/7)", or empty when the size was never reported.
  statsLabel(instanceId) {
    const stats = this.objectStats.get(instanceId)
    if (!stats || stats.power == null || stats.toughness == null) return ''
    return `(${stats.power}/${stats.toughness})`
  }

  trackCombat(object) {
    const id = object.instanceId

    if (object.attackState && object.attackState !== this.attackState.get(id)) {
      this.attackState.set(id, object.attackState)
      if (object.attackState === 'AttackState_Declared') {
        const name = this.nameOf(id) || 'A creature'
        const target = this.targetLabel(object.attackInfo ? object.attackInfo.targetId : null)
        // Size at the moment of attacking, which is when it decides anything. Combat
        // is the one place P/T earns a mention, and here it adds no extra line.
        const stats = this.statsLabel(id)
        this.push('attack', `${name}${stats ? ` ${stats}` : ''} attacks ${target}`, {
          seat: object.controllerSeatId,
          card: this.nameOf(id),
          stats,
          targetId: object.attackInfo ? object.attackInfo.targetId : null,
          targetLabel: target,
        })
      }
    }

    if (object.blockState && object.blockState !== this.blockState.get(id)) {
      this.blockState.set(id, object.blockState)
      // Only a block is reported. "Unblocked" is already said by the damage line
      // that follows it, so printing both only pads the turn.
      if (object.blockState === 'BlockState_Blocked') {
        const name = this.nameOf(id) || 'A creature'
        this.push('block', `${name} is blocked`, { seat: object.controllerSeatId })
      }
    }
  }

  // The opening hand, reported as turn 1 is announced. That timing is deliberate:
  // a London mulligan draws seven and puts cards back, so only once the first turn
  // starts is the hand settled. Hand size is also what reveals the mulligan — the
  // log carries no mulligan counter, but seven cards minus what is held says it.
  // A hand is kept only when its contents changed, so a reorder or a repeated message
  // does not add one. Compared as a multiset for the same reason.
  recordHandHistory() {
    if (this.openingReported) return

    for (const [seat, ids] of this.handZones) {
      if (ids.length === 0) continue

      const cards = ids.map((id) => this.nameOf(id))
      // The opponent's hand is hidden by the game, so its ids carry no grpId and
      // resolve to nothing. Half a hand is worse than none, so partials are skipped.
      if (cards.some((name) => !name)) continue

      const history = this.handHistory.get(seat) || []
      const signature = [...cards].sort().join('|')
      if (history.length > 0 && history[history.length - 1].signature === signature) continue

      history.push({ cards, signature })
      this.handHistory.set(seat, history)
    }
  }

  // Cards in `from` that are not in `to`, by multiset — which cards went to the
  // bottom, given the hand before and after.
  static difference(from, to) {
    const left = [...to]
    const out = []
    for (const name of from) {
      const at = left.indexOf(name)
      if (at === -1) out.push(name)
      else left.splice(at, 1)
    }
    return out
  }

  // True when this transfer is the bottoming already reported in hand resolution.
  // Bounded by count and by the turn, so a real bottom-of-library effect later in the
  // game is never swallowed.
  consumeBottom(seat, name) {
    if (this.turn > 1) return false
    const owed = this.pendingBottoms.get(seat)
    const left = owed ? owed.get(name) || 0 : 0
    if (left === 0) return false
    owed.set(name, left - 1)
    return true
  }

  reportOpeningHands() {
    if (this.openingReported || !this.game || this.handZones.size === 0) return
    this.openingReported = true

    this.push('turn', 'Game start, hand resolution', { turn: 0 })

    for (const seat of [...this.handZones.keys()].sort((a, b) => a - b)) {
      const ids = this.handZones.get(seat) || []
      if (ids.length === 0) continue

      const who = this.seatLabel(seat)
      const mulligans = Math.max(0, 7 - ids.length)
      const kept = mulligans === 0 ? `keeps ${ids.length}` : `mulligans to ${ids.length}`

      // The opponent's hand is hidden by the game itself, so their cards have no
      // names to resolve and their line is just the count — which is public, and all
      // there is to say.
      const cards = ids.map((id) => this.nameOf(id)).filter(Boolean)
      const known = cards.length === ids.length
      const history = this.handHistory.get(seat) || []

      // The hand drawn for the final mulligan, before any of it went back: the
      // snapshot before the kept one. The kept hand is it minus what was bottomed.
      const beforeBottom = history.length >= 2 ? history[history.length - 2].cards : null
      const bottomed = beforeBottom && beforeBottom.length > cards.length
        ? LogParser.difference(beforeBottom, cards)
        : []

      // The names travel alongside the text so the UI can make each one hoverable
      // without having to search the sentence against the whole card database.
      if (!known || bottomed.length === 0) {
        const detail = known ? `: ${joinList(countedList(cards))}` : ''
        this.push('opening', `${who} ${kept}${detail}`, { seat, turn: 0, cards: known ? cards : [] })
        continue
      }

      // Read as the sequence it was: each hand drawn, then what went back and what
      // was kept. "Mulligans to 6" over a seven-card list read as a contradiction.
      //
      // A complete history is the original hand, one draw per mulligan, then the kept
      // hand. Only then is the first snapshot known to be the original; with fewer the
      // original was never captured, and with more something unexpected was recorded,
      // so either way the original is left out rather than a redraw being mislabelled
      // as it. The draws shown are the latest, at most one per mulligan.
      const complete = history.length === mulligans + 2
      if (complete) {
        const original = history[0].cards
        this.push('opening', `${who}'s original hand: ${joinList(countedList(original))}`, {
          seat, turn: 0, cards: original,
        })
      }
      const draws = history.slice(complete ? 1 : Math.max(0, history.length - 1 - mulligans), -1)
      for (const draw of draws) {
        this.push('opening', `${who} mulligans and draws ${draw.cards.length}: ${joinList(countedList(draw.cards))}`, {
          seat, turn: 0, cards: draw.cards,
        })
      }

      // A comma before "and keeps" once the list has its own "and", so "bottoms A and
      // B, and keeps 5" cannot read as three things bottomed.
      const sent = countedList(bottomed)
      this.push('opening',
        `${who} bottoms ${joinList(sent)}${sent.length > 1 ? ',' : ''} and keeps ${ids.length}`,
        { seat, turn: 0, cards: bottomed })

      // Recorded so the transfer that actually performs it can be dropped: it would
      // otherwise reappear as the first line of turn 1, restating this.
      const owed = new Map()
      for (const name of bottomed) owed.set(name, (owed.get(name) || 0) + 1)
      this.pendingBottoms.set(seat, owed)
    }
  }

  handleTurnInfo(turnInfo) {
    if (turnInfo.activePlayer != null) this.activeSeat = turnInfo.activePlayer
    if (turnInfo.phase) this.phase = turnInfo.phase
    if (turnInfo.step !== undefined) this.step = turnInfo.step || ''
    if (turnInfo.turnNumber == null || turnInfo.turnNumber === this.turn) return

    this.turn = turnInfo.turnNumber
    this.turnDrawSeen = false
    this.castingOpen = false
    this.wardResolving = null
    this.abilityTargets = new Map()
    if (this.turn === 1) this.reportOpeningHands()

    const taken = (this.seatTurns.get(this.activeSeat) || 0) + 1
    this.seatTurns.set(this.activeSeat, taken)
    if (this.game && this.game.firstSeat === null) this.game.firstSeat = this.activeSeat
    // maxTurn counts a player's own turns too, so the header does not claim "14
    // turns" over a game whose last heading reads Turn 7.
    if (this.game) this.game.maxTurn = Math.max(this.game.maxTurn, taken)

    // The turn header is driven by this number changing rather than by
    // NewTurnStarted: turnInfo is a diff, and the annotation arrives a message
    // earlier than the increment, which produced a "Turn 0" and skipped Turn 1.
    this.push('turn', `${this.seatLabel(this.activeSeat)} — Turn ${taken}`, { seat: this.activeSeat, turn: taken })

    // What the other player can answer with, stated as the turn opens. This is the
    // one genuinely useful thing in 159 tap events: individually they are noise,
    // but the count at this moment is what the opponent is representing.
    const defender = this.otherSeat(this.activeSeat)

    // What the player who just finished is left holding. Emitted here, with the next
    // turn's header, because this is the first moment the turn's state is final — and
    // relocated back into their turn by relocateTurnEnd, exactly like the mana line.
    //
    // Only the player whose turn it was: both players' counts on every turn doubles
    // the lines to say half as much per line, and the number that matters is the one
    // belonging to whoever was acting.
    //
    // Skipped on turn 1, which closes no previous turn.
    if (defender != null && this.turn > 1) {
      const library = this.librarySizes.get(defender)
      const hand = this.handSizes.get(defender)
      if (library != null || hand != null) {
        const parts = []
        if (library != null) parts.push(`${library} card${library === 1 ? '' : 's'} in library`)
        if (hand != null) parts.push(`${hand} in hand`)
        this.push('counts', `${this.seatLabel(defender)} ends with ${parts.join(', ')}`, {
          seat: defender, turn: taken,
        })
      }
    }

    if (defender != null) {
      const { total, untapped } = this.landStatus(defender)
      if (total > 0) {
        // The land count rides along even when nothing is untapped: "tapped out" on
        // one land and on six are very different positions.
        this.push('mana', untapped === 0
          ? `${this.seatLabel(defender)} is tapped out (${total} land${total === 1 ? '' : 's'})`
          : `${this.seatLabel(defender)} has ${untapped} of ${total} lands untapped`,
        { seat: defender, turn: taken })
      }
    }
  }

  // Abilities resolve too and would flood the narration, so this is filtered to
  // spells: nameOf resolves card grpIds only and returns null for an ability
  // instance, which is exactly the discriminator needed.
  reportResolve(instanceId) {
    const name = this.nameOf(instanceId)
    if (!name) return
    this.push('resolve', `${name} resolves`, {
      seat: this.objectController.get(instanceId),
      card: name,
    })
  }

  handleAnnotation(annotation) {
    const types = annotation.type || []
    const details = detailsToObject(annotation)

    // An ability instance created by a permanent. These never arrive as game
    // objects, so objectSourceGrpId cannot see them and the link exists only here —
    // which is why a painland's life loss had nothing to attribute it to. The id is
    // reused across the game, so each creation overwrites the last.
    if (types.includes('AnnotationType_AbilityInstanceCreated')) {
      for (const id of annotation.affectedIds || []) {
        this.abilityInstanceOwner.set(id, annotation.affectorId)
        if (this.game) this.abilityOpenedAt.set(id, this.game.events.length)
        // Ids are reused, so a new instance under this one ends any stale entry.
        this.openActivations.delete(id)
      }
    }

    // An activated ability leaving the stack without having resolved. Every ability
    // that resolves logs ResolutionStart and ResolutionComplete before it is deleted;
    // this one is deleted with neither. Across every archive that was 1 of 19
    // activations — an equip whose target, an earthbent Plains, was killed in
    // response — while the same equip resolved normally twice in that game.
    //
    // Worded like a spell's "never resolves", for the same reason: the log shows the
    // outcome, not the cause. A lost target and a Stifle look the same.
    if (types.includes('AnnotationType_AbilityInstanceDeleted')) {
      for (const id of annotation.affectedIds || []) {
        const open = this.openActivations.get(id)
        if (!open) continue
        this.openActivations.delete(id)
        this.push('unresolved', `${possessive(open.source)} ability never resolves`, {
          seat: open.seat,
          card: open.source,
        })
      }
    }

    // A cancelled cast is dropped whole: its transfer, and the renumbering that
    // came with it. Letting the rename through would splice two different cards
    // into one identity chain.
    if (this.isCancelled(details.new_id) || this.isCancelled((annotation.affectedIds || [])[0])) {
      if (types.includes('AnnotationType_ObjectIdChanged')
        || (types.includes('AnnotationType_ZoneTransfer') && details.category === 'CastSpell')) {
        return
      }
    }

    // Shuffling is how a search ends, so that is when the line can state a total.
    if (types.includes('AnnotationType_Shuffle')) this.concludeSearch()

    if (types.includes('AnnotationType_ObjectIdChanged')) {
      const grpId = this.objectGrp.get(details.orig_id)
      if (grpId) this.objectGrp.set(details.new_id, grpId)
    }

    if (types.includes('AnnotationType_ZoneTransfer')) this.narrateZoneTransfer(annotation, details)

    if (types.includes('AnnotationType_ModifiedLife')) {
      const seat = (annotation.affectedIds || [])[0]
      const delta = details.life
      if (seat != null && delta) {
        const total = this.life[seat]
        const direction = delta < 0 ? 'loses' : 'gains'
        // Without this a painland reads as losing life for no reason. Some life
        // changes genuinely have no nameable source in the log — a shockland's is a
        // synthetic engine id that is never defined — and those stay unattributed
        // rather than being pinned on whatever happened to be nearby.
        const source = this.sourceOf(annotation.affectorId)
        const cause = source ? ` ${delta < 0 ? 'to' : 'from'} ${source}` : ''
        this.push('life',
          `${this.seatLabel(seat)} ${direction} ${Math.abs(delta)} life${cause}${total != null ? ` (now ${total})` : ''}`,
          // `msg`: the total is the one this message ends on (see mergeDamageResults).
          { seat, delta, total, card: source, msg: this.messageIndex })
      }
    }

    // Tokens appear and vanish with nothing else to explain them: a Treasure being
    // sacrificed read as coming from nowhere because its creation was never stated.
    if (types.includes('AnnotationType_TokenCreated')) {
      for (const id of annotation.affectedIds || []) {
        const token = this.nameOf(id)
        const seat = this.objectController.get(id) ?? annotation.affectorId
        const source = this.sourceOf(annotation.affectorId)
        const credit = source ? ` (${source})` : ''
        // Always called a token, so a token named after a real card cannot read as the
        // card, and the single form agrees with the counted "creates 2 Map tokens".
        // A copy says so, with its size: offspring makes "a 1/1 token copy", not the
        // 2/1 card, and the object is flagged isCopy with its own stats.
        const isCopy = this.objectCopies.has(id)
        const stats = this.objectStats.get(id) || {}
        const size = stats.power != null && stats.toughness != null ? `${stats.power}/${stats.toughness}` : ''
        const what = isCopy
          ? `a ${size ? `${size} ` : ''}token copy of ${token || 'a permanent'}`
          : `${withArticle(token || 'token')} token`
        this.push('token', `${this.seatLabel(seat)} creates ${what}${credit}`, {
          seat,
          card: token,
          source,
          isCopy,
          size,
          // Which token this is, for the hover: the renderer looks it up by name and
          // size among *tokens*, since the plain name belongs to the real card.
          tokenRefs: token ? [{ name: token, power: stats.power, toughness: stats.toughness }] : [],
        })
      }
    }

    if (types.includes('AnnotationType_CounterAdded') || types.includes('AnnotationType_CounterRemoved')) {
      const added = types.includes('AnnotationType_CounterAdded')
      const amount = Math.abs(details.transaction_amount || 1)
      const source = this.sourceOf(annotation.affectorId)
      for (const id of annotation.affectedIds || []) {
        const target = this.nameOf(id)
        if (!target) continue
        // The source is kept even when it is the target. Dropping it here read as a
        // separate, unexplained event — "Ouroboroid gets a +1/+1 counter" beside
        // "Leatherhead gets a +1/+1 counter (Ouroboroid)" — and, because runs are
        // grouped by source, stopped the two halves of one effect from merging.
        // counterPhrase decides whether to show it, once the run is known.
        const kind = this.resolveCounter(details.counter_type)
        // Loyalty left, when the object was reported in this same message — so a
        // blow to a planeswalker can say what it left behind.
        const loyalty = this.objectLoyalty.get(id)

        this.push('counter', counterPhrase([target], added, amount, kind, source), {
          seat: this.objectController.get(id),
          card: target,
          added,
          amount,
          counterKind: kind,
          source,
          instanceId: id,
          msg: this.messageIndex,
          loyaltyAfter: loyalty && loyalty.msg === this.messageIndex ? loyalty.value : undefined,
        })
      }
    }

    // Resolution beginning, which is the moment that reads as "X resolves": its
    // effects follow, and the card only leaves the stack afterwards.
    //
    // Abilities resolve too and would flood the narration, so this is filtered to
    // spells — nameOf resolves card grpIds only and returns null for an ability
    // instance, which is exactly the discriminator needed.
    if (types.includes('AnnotationType_ResolutionStart')) {
      this.reportResolve(annotation.affectorId)
      this.openWardPayment(annotation.affectorId, details.grpid)
    }
    if (types.includes('AnnotationType_ResolutionComplete')) this.closeWardPayment(annotation.affectorId)

    // Mana paid while ward resolves is the ward tax: the trigger counters the spell or
    // ability unless its controller pays, and that payment is all that happens in it.
    if (types.includes('AnnotationType_ManaPaid') && this.wardResolving) {
      this.wardResolving.paid = true
      this.wardResolving.payer = this.objectController.get(annotation.affectorId) ?? this.wardResolving.payer
    }

    // Either marker means an activation did resolve. Complete counts too: Bushwhack
    // showed that Start can be missing from a real resolution.
    if (types.includes('AnnotationType_ResolutionStart') || types.includes('AnnotationType_ResolutionComplete')) {
      this.openActivations.delete(annotation.affectorId)
    }

    // ResolutionComplete is deliberately NOT a fallback for a missing Start. It was
    // tried, to give Bushwhack a "resolves" line: the spell resolved and the log says
    // so, but only through Complete. Two things make it unusable. It lands *after*
    // the spell's effects, so the line reads in the wrong place; and the log can send
    // **two Completes for one resolution** — Practiced Offense did, at msg302 and
    // msg306 of a real game — so any "report it once" guard keyed on the instance is
    // consumed by the first and fires spuriously on the second.
    //
    // A cast whose resolution was never seen therefore stays a bare "casts X", which
    // is already what that reads as everywhere else.

    // actionType 1 is the player committing to the cast, the last step of casting —
    // everything emitted before it was cost payment.
    if (types.includes('AnnotationType_UserActionTaken') && details.actionType === 1) {
      this.castingOpen = false
    }

    // Activating an ability. UserActionTaken classifies every player action, and
    // only type 2 is an activation — 1 casts a spell, 3 plays a land, and 4 is a
    // mana ability, which fires 80 times a match and would bury the narration.
    // Without this an activated ability appears only as its consequence: six mill
    // lines with nothing saying who caused them.
    if (types.includes('AnnotationType_UserActionTaken') && details.actionType === 2) {
      const abilityId = (annotation.affectedIds || [])[0]
      const source = abilityId != null ? this.sourceOf(abilityId) : null
      if (source && this.game) {
        this.openActivations.set(abilityId, { source, seat: annotation.affectorId })
        const effect = abilityEffect(this.resolveAbilityText(details.abilityGrpId), source)
        // Spliced where the ability went on the stack, not appended here: the
        // commitment is the *last* step of activating, so appending put the costs
        // above the line that explains them.
        const at = this.abilityOpenedAt.get(abilityId) ?? this.game.events.length
        // Only our own activations have targets here: the request goes to the player
        // choosing, exactly as with spells, so the opponent's stay unknown.
        const aimed = this.abilityTargets.get(abilityId)
        this.abilityTargets.delete(abilityId)
        this.game.events.splice(at, 0, {
          turn: this.turn,
          kind: 'activate',
          text: `${this.seatLabel(annotation.affectorId)} activates ${source}${effect ? `: ${effect}` : ''}`,
          seat: annotation.affectorId,
          card: source,
          targetLabels: aimed ? aimed.labels : undefined,
          targetCards: aimed ? aimed.cards : undefined,
        })
      }
    }

    // An aura or equipment attaching. Unlike selectTargetsReq this is game state, so
    // it crosses the visibility line: it is the only record of what an *opponent's*
    // aura was put on.
    if (types.includes('AnnotationType_AttachmentCreated')) {
      const aura = this.nameOf(annotation.affectorId)
      const targetId = (annotation.affectedIds || [])[0]
      if (aura && targetId != null) {
        const attachedTo = this.targetLabel(targetId)
        this.push('attach', `${aura} attaches to ${attachedTo}`, {
          seat: this.objectController.get(annotation.affectorId),
          card: aura,
          attachedTo,
          cards: [aura, this.nameOf(targetId)].filter(Boolean),
        })
      }
    }

    // A modal spell records which mode was taken, as a localization id rather than
    // text — "Glacierwood Siege" otherwise resolves with no hint of which half of
    // the card is now in play.
    // What a choice picked, by domain. Each value is resolved through the table it
    // belongs to, and an unrecognised domain stays silent rather than printing a raw
    // number. Seen in real logs:
    //   'localization_id' - a mode label (Glacierwood Siege: "Temur")
    //   13                - a card name, the value being the name's localization id
    //                       (Petrified Hamlet named Fountainport; the permanent also
    //                       carries a LinkInfo with ChooseLinkType "CardName")
    //   9                 - a subtype (Multiversal Passage chose Forest, 29 in the
    //                       SubType enum; LinkInfo ChooseLinkType "Type")
    // Domains 13 and 9 were each seen once, so their reading rests on one example
    // apiece, cross-checked against what the card asks for.
    if (types.includes('AnnotationType_ChoiceResult')) {
      const domain = details.Choice_Domain
      const value = details.Choice_Value
      const label = domain === 'localization_id' || domain === 13
        ? this.resolveChoice(value)
        : domain === 9 ? this.resolveSubType(value) : null
      if (label) {
        const seat = this.objectController.get(annotation.affectorId)
        const source = this.sourceOf(annotation.affectorId)
        this.push('choice', `${this.seatLabel(seat)} chooses ${label}${source ? ` for ${source}` : ''}`,
          // A named card is a card, so it should preview like one.
          { seat, card: source, choice: label, choiceCard: domain === 13 ? label : null })
      }
    }

    if (types.includes('AnnotationType_Scry')) {
      const seat = this.objectController.get(annotation.affectorId)
      const source = this.sourceOf(annotation.affectorId)
      const credit = source ? ` (${source})` : ''
      const describe = (ids) => {
        const named = ids.map((id) => this.nameOf(id)).filter(Boolean)
        // Only our own library is visible, so the opponent's scry is a count.
        return named.length === ids.length ? joinList(countedList(named)) : `${ids.length} card${ids.length === 1 ? '' : 's'}`
      }

      const top = detailList(annotation, 'topIds')
      const bottom = detailList(annotation, 'bottomIds')
      if (top.length > 0) {
        this.push('scry', `${this.seatLabel(seat)} keeps ${describe(top)} on top${credit}`,
          { seat, source, cards: top.map((id) => this.nameOf(id)).filter(Boolean) })
      }
      if (bottom.length > 0) {
        this.push('scry', `${this.seatLabel(seat)} puts ${describe(bottom)} on the bottom${credit}`,
          { seat, source, cards: bottom.map((id) => this.nameOf(id)).filter(Boolean) })
      }
    }

    if (types.includes('AnnotationType_DamageDealt')) {
      const source = this.nameOf(annotation.affectorId)
      const amount = details.damage
      const targetId = (annotation.affectedIds || [])[0]
      if (amount && targetId != null) {
        // Low ids are seats; anything else is a permanent on the battlefield.
        const hitsPlayer = this.seatNames[targetId] !== undefined || targetId === this.localSeat
        const targetName = hitsPlayer ? null : this.nameOf(targetId)
        const target = hitsPlayer ? this.seatLabel(targetId) : (targetName || 'a permanent')
        this.push('damage', `${source || 'Something'} deals ${amount} damage to ${target}`, {
          amount,
          targetId,
          card: source,
          targetLabel: target,
          // The target is hoverable too; only the source was before.
          cards: [source, targetName].filter(Boolean),
          msg: this.messageIndex,
          // Which creature, not just its name, so a double striker's two hits are not
          // counted as two copies.
          sourceInstance: annotation.affectorId,
        })
      }
    }
  }

  narrateZoneTransfer(annotation, details) {
    const ids = annotation.affectedIds || []
    const instanceId = ids[0]
    const name = this.nameOf(instanceId)
    const fromKind = this.zoneKind(details.zone_src)
    const toKind = this.zoneKind(details.zone_dest)
    // Who the card belongs to, which is more reliable than the affector: a draw has
    // no affector, and removal is attributed to the spell, not its controller.
    const seat = this.zoneOwner(details.zone_dest) ?? this.zoneOwner(details.zone_src) ?? annotation.affectorId
    const who = this.seatLabel(seat)
    // Opponent cards stay hidden until revealed, so an unnamed object is expected
    // rather than a parse failure.
    const card = name || 'a card'

    switch (details.category) {
      case 'Draw': {
        if (seat === this.activeSeat) this.turnDrawSeen = true
        // A turn's own draw has no affector; one caused by a spell or ability does.
        const cause = this.causeOf(annotation, name)
        return this.push('draw', `${who} draws ${name ? name : 'a card'}${cause ? ` (${cause})` : ''}`,
          { seat, card: name, source: cause, sourceId: this.causeInstance(annotation) })
      }
      case 'PlayLand': {
        // Whether a land arrived tapped is read straight off the object, which the
        // gameObjects loop has already updated for this message. It is the
        // difference between a shockland paid for and one that cost a turn, and
        // only ~3 lands in a match qualify, so the line stays quiet otherwise.
        const entersTapped = this.objectTapped.get(instanceId) ? ' tapped' : ''
        return this.push('play', `${who} plays ${card}${entersTapped}`, { seat, card: name, fromZone: fromKind })
      }
      case 'CastSpell': {
        // Where a spell was cast from is only worth saying when it is not the hand:
        // flashback, escape, adventure and the rest change what the play means, and
        // the zone it came from is the only record that it happened.
        const origin = castOrigin(fromKind)
        this.push('cast', `${who} casts ${card}${origin}`, { seat, card: name, instanceId, fromZone: fromKind })
        this.castingOpen = true
        return undefined
      }
      // Not narrated here. This transfer is the card *leaving* the stack, which for
      // a sorcery happens after its effect — so "X resolves" printed below the thing
      // X did. The line is emitted from ResolutionStart instead.
      case 'Resolve':
        return undefined
      case 'Discard': {
        // MTGA advances the turn counter before reporting the previous turn's
        // cleanup, so a discard in the beginning phase before this turn's draw is
        // really the end of the turn before. Heuristic, but it reads correctly.
        const isCleanup = this.phase === 'Phase_Beginning' && !this.turnDrawSeen
        // Flagged rather than worded differently here: a cleanup discard is moved
        // into the turn it actually belongs to, and merged with the others in the
        // same run, once the whole game has been read.
        return this.push('discard', `${who} discards ${card}`, {
          seat,
          card: name,
          cleanup: isCleanup || undefined,
          fromZone: fromKind,
        })
      }
      case 'Destroy':
      {
        const cause = this.causeOf(annotation, name)
        const subject = this.nameOf(instanceId) || card
        return this.push('destroy', `${subject} is destroyed${cause ? ` (${cause})` : ''}`, {
          seat,
          card: name,
          source: cause,
          subject,
          predicate: { one: 'is destroyed', many: 'are destroyed' },
        })
      }
      case 'Sacrifice': {
        const sacrificed = this.nameOf(instanceId) || card

        // Cashing in a Treasure, Clue or Food. Mana abilities are otherwise silent —
        // they fire ~80 times a match for land taps — but one that eats the
        // permanent paying it is a real play, and the only trace of it is this
        // sacrifice. Saying what it was for also makes naming the source redundant:
        // a Treasure sacrificed for its own mana ability read "(Treasure)".
        if (this.manaAbilities.has(annotation.affectorId)) {
          return this.push('sacrifice', `${who} sacrifices ${sacrificed} for mana`, { seat, card: name })
        }

        // Otherwise the cause is named even when it is the card itself: sacrificing
        // a permanent to pay for its own activated ability is the common case, and
        // the attribution ties the line to the activation above and the effect below.
        const cause = this.sourceOf(annotation.affectorId)
        return this.push('sacrifice',
          `${who} sacrifices ${sacrificed}${cause ? ` (${cause})` : ''}`,
          { seat, card: name, source: cause })
      }
      case 'Exile':
      {
        const cause = this.causeOf(annotation, name)
        const subject = this.nameOf(instanceId) || card
        const owner = this.zoneOwner(details.zone_src)
        const origin = departureZone(fromKind, owner, this.seatLabel(owner))
        return this.push('exile', `${subject} is exiled${origin}${cause ? ` (${cause})` : ''}`, {
          fromZone: fromKind,
          seat,
          card: name,
          source: cause,
          subject,
          predicate: { one: `is exiled${origin}`, many: `are exiled${origin}` },
        })
      }
      case 'Return':
      {
        const cause = this.causeOf(annotation, name)
        const subject = this.nameOf(instanceId) || card
        const where = toKind || 'another zone'
        const owner = this.zoneOwner(details.zone_src)
        const origin = departureZone(fromKind, owner, this.seatLabel(owner))
        return this.push('return', `${subject} returns to ${where}${origin}${cause ? ` (${cause})` : ''}`, {
          seat,
          card: name,
          source: cause,
          subject,
          predicate: { one: `returns to ${where}${origin}`, many: `return to ${where}${origin}` },
        })
      }
      // A spell that leaves the stack with no category and no ResolutionStart never
      // resolved. MTGA writes the category as the literal string "nil".
      //
      // Named "unresolved" rather than "fizzle" because it covers every way a spell
      // can fail: a fizzle is specifically one countered by the rules for losing its
      // last legal target, while a counterspell is a different mechanism with the
      // same outcome. They are indistinguishable here, so the branch is named — and
      // the line worded — for the outcome they share, not a cause it cannot know.
      case 'nil': {
        if (fromKind !== 'stack') return undefined
        return this.push('unresolved', `${card} never resolves`, { seat, card: name })
      }

      case 'Mill': {
        const cause = this.causeOf(annotation, name)
        return this.push('mill', `${who} mills ${card}${cause ? ` (${cause})` : ''}`,
          { seat, card: name, source: cause, sourceId: this.causeInstance(annotation), fromZone: fromKind })
      }

      // A creature dying in combat does not go through Destroy — it leaves via a
      // state-based action, which fell through to the default and said nothing at
      // all. Combat deaths are not a detail to omit.
      case 'SBA_Damage':
        return this.push('destroy', `${this.nameOf(instanceId) || card} dies`, { seat, card: name })

      // An aura or equipment falling off because what it was attached to left.
      case 'SBA_UnattachedAura':
        return this.push('destroy', `${card} falls off and is put into the graveyard`, { seat, card: name })

      // A planeswalker leaving on zero loyalty. Like SBA_Damage this is a
      // state-based action rather than a Destroy, so it fell through and said
      // nothing: the loyalty counters ticked away to nothing and the walker simply
      // stopped being mentioned. Named rather than called "dies", which is a
      // creature's word.
      case 'SBA_ZeroLoyalty':
        return this.push('destroy', `${card} is put into the graveyard with no loyalty left`,
          { seat, card: name })

      // Surveil puts a card in the graveyard off the top of the library. The zones
      // are what distinguish it from a mill, and whose library it was is the point.
      case 'Surveil': {
        const cause = this.causeOf(annotation, name)
        return this.push('select', `${who} surveils ${card} into their graveyard${cause ? ` (${cause})` : ''}`,
          { seat, card: name, source: cause, fromZone: fromKind })
      }

      // A spell countered on the stack. This is the one case where the log names the
      // cause outright, unlike the "nil" transfer below, which only says a spell left
      // the stack without resolving and cannot tell a counterspell from a fizzle.
      // The transfer's affector is the spell that did the countering, so the credit
      // comes from the log rather than from guessing at whatever was cast just before.
      case 'Countered': {
        const cause = this.causeOf(annotation, name)
        return this.push('unresolved', `${card} is countered${cause ? ` (${cause})` : ''}`,
          { seat, card: name, source: cause })
      }

      // "Put" is how a look-at-the-top effect reports its outcome — Sleight of Hand
      // taking one card and bottoming the other. Which way it went is the whole
      // point of the effect, and the zones say which.
      case 'Put': {
        // The mulligan bottoming, already stated in hand resolution.
        if (fromKind === 'hand' && toKind === 'library' && this.consumeBottom(seat, name)) {
          return undefined
        }

        let destination = null
        if (toKind === 'hand' && fromKind === 'library') destination = 'into hand'
        else if (toKind === 'library' && fromKind === 'library') destination = 'on the bottom of their library'
        else if (fromKind !== toKind) destination = `into their ${toKind || 'library'}`
        if (!destination) return undefined

        const cause = this.causeOf(annotation, name)
        if (this.pendingSearch && fromKind === 'library' && toKind === 'hand') {
          this.pendingSearch.taken += 1
          this.pendingSearch.cards.push(name)
          // Held so the search line can absorb these rather than repeat them.
          this.pendingSearch.absorbed.push(this.game.events.length)
        }
        return this.push('select', `${who} puts ${card} ${destination}${cause ? ` (${cause})` : ''}`, {
          seat,
          card: name,
          destination,
          source: cause,
          fromZone: fromKind,
        })
      }

      default:
        return undefined
    }
  }

  finish() {
    // Whichever seat the server addressed most is this client's own.
    let best = null
    for (const [seat, count] of this.seatMessageCounts) {
      if (!best || count > best.count) best = { seat, count }
    }
    this.localSeat = best ? best.seat : null

    this.concludeSearch()

    // Games the stream never closed out take their result from the match summary,
    // matched by position: resultList holds one game-scope entry per game, in order.
    for (const [index, game] of this.games.entries()) {
      if (game.result) continue
      const reported = this.finalGameResults[index]
      if (!reported) continue
      game.result = { winningTeamId: reported.winningTeamId, reason: reported.reason }
      // Flagged so the UI can say the narration stops short rather than implying the
      // game simply ended there.
      game.truncated = true
    }

    // Seat labels are only known at the end, so render text once the local seat is.
    for (const game of this.games) {
      // Targets first: this appends to the cast line, and collapseCastResolve then
      // rewrites "casts X, targeting Y" into "casts and resolves X, targeting Y".
      let events = this.attachTargets(game.events)
      events = relocateTurnEnd(mergeResolveAttach(mergeChoiceIntoCast(collapseCastResolve(events))))
      events = collapseRuns(events, 'mill', runDescriber('mills'), sameActor)
      events = collapseRuns(events, 'draw', runDescriber('draws'), sameActor)
      events = mergeDamageResults(events)
      events = collapseRuns(events, 'attack', attackDescriber, sameTarget)
      events = collapseRuns(events, 'damage', damageDescriber, sameTargetOnce)
      events = collapseRuns(events, 'counter', counterDescriber, sameCounter)
      events = collapseRuns(events, 'select', selectDescriber)
      events = collapseRuns(events, 'token', tokenDescriber, sameToken)
      events = mergeScryDraw(events)
      events = mergeSharedSource(events)

      // The narration otherwise just stops, which reads the same whether the game
      // ended or the log ran out. Appended after every pass so none can fold it in.
      if (game.result) {
        const won = game.result.winningTeamId === this.localSeat
        // A game that produced no GameOver had its stream cut off before it ended,
        // and the result survives only in the match summary. The cause is a
        // concession: the conceding client stops receiving state.
        //
        // Stated plainly rather than hedged, by the owner's explicit choice. It is
        // still an inference — a disconnect looks identical, and MTGA files a
        // concession under the same ResultReason_Game as any other finish — so if it
        // ever reads wrong, this is the line to revisit.
        //
        // The conceding player is named rather than called "the opponent": whoever
        // lost conceded, and every other line in the narration uses names. Present
        // tense for the same reason — the rest of it reads "plays", "casts", "draws".
        const conceder = won ? this.otherSeat(this.localSeat) : this.localSeat
        const conceding = conceder != null ? this.seatLabel(conceder) : null

        // Two ways to know. A truncated game is the inference above; a result whose
        // reason is literally ResultReason_Concede is the log saying so outright, and
        // that one arrives with the stream intact, so it was previously missed
        // entirely — the game simply ended on "Game won" with no explanation.
        const stated = /Concede/i.test(game.result.reason || '')
        const conceded = (game.truncated || stated) && conceding
        const prefix = conceded ? `${conceding} concedes — ` : ''

        events.push({
          turn: game.maxTurn,
          kind: 'gameend',
          text: `${prefix}Game ${won ? 'won' : 'lost'}`,
          won,
          // True only for the inferred case; a stated concession is not a guess.
          inferredConcession: Boolean(game.truncated) && !stated,
        })
      }

      // An attribution names a card, so it should preview like any other. Done once
      // here rather than at every push and in every merge: a source can be set by a
      // narration site, carried through a run collapse, or introduced by a merge,
      // and each of those would otherwise have to remember.
      for (const event of events) {
        if (!event.source) continue
        event.cards = [...new Set([...(event.cards || []), event.source])]
      }

      game.events = events
      for (const event of game.events) {
        if (event.seat != null && typeof event.text === 'string') {
          event.text = event.text.replace(/^Seat (\d+)/, (match, seatNumber) =>
            this.seatNames[seatNumber] || match)
        }
      }
    }

    return this.games
  }
}

// "X casts Foo" followed by "Foo resolves" is two lines saying one thing, so they
// collapse into "X casts and resolves Foo".
//
// What may sit between them is the subtlety. MTGA emits a spell's *effects* before
// its Resolve marker — "casts Opt" then the draw then "Opt resolves" — so blocking
// the merge on any intervening event would only have caught 19 of 37 casts in a real
// match. Those events are the spell doing its job, not the stack being contested.
// What does mean the stack was used is another spell being cast or resolving in
// between, and that is what keeps the two lines apart.
function collapseCastResolve(events) {
  const drop = new Set()

  for (let i = 0; i < events.length; i += 1) {
    const cast = events[i]
    // An unnamed card ("casts a card", opponent's hidden spell) has nothing unique to
    // pair on, so leave those alone rather than risk matching the wrong resolve.
    if (cast.kind !== 'cast' || !cast.card) continue

    for (let j = i + 1; j < events.length; j += 1) {
      const next = events[j]
      if (next.kind === 'turn') break
      if (next.kind === 'resolve' && next.card === cast.card && next.seat === cast.seat) {
        if (drop.has(j)) break
        drop.add(j)
        const at = cast.text.indexOf(' casts ')
        if (at !== -1) {
          cast.text = `${cast.text.slice(0, at)} casts and resolves ${cast.text.slice(at + ' casts '.length)}`
        }
        break
      }
      // Another spell on the stack: the two events are genuinely separate moments.
      if (next.kind === 'cast' || next.kind === 'resolve') break
      // A cost paid for this very spell. Collapsing across it would put the costs
      // after "casts and resolves", implying the spell finished before it was paid
      // for — the card goes on the stack first, but resolution comes last.
      if (next.duringCast) break
    }
  }

  return drop.size === 0 ? events : events.filter((_, index) => !drop.has(index))
}

// Semicolons, not commas, because card names contain commas: "Leatherhead, Swamp
// Stalker" inside a comma-separated list is indistinguishable from two cards. The
// serial separator before "and" is kept, so the last item is punctuated like the
// rest.
// Repeats become a count: "2 Bejeweled Warg" rather than the name twice. First
// appearance sets the position, so the list still follows the order things happened.
// The headline count stays the number of cards, not the number of distinct names —
// seven cards milled is seven cards whether or not two shared a name.
function countedList(items) {
  const counts = new Map()
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1)
  return [...counts.entries()].map(([item, n]) => (n > 1 ? `${n} ${item}` : item))
}

function joinList(items) {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}`
}

// Runs of the same repeated action read as one line. Milling fires once per card, so
// a single Cruel Calculations otherwise fills the turn with near-identical lines.
// Only a strictly adjacent run by the same player is merged: anything in between is
// a different beat of the turn, and folding across it would reorder the narration.
// `sameGroup` compares a candidate with the run's first entry, and also gets the run
// so far for a rule that depends on every member (see sameTargetOnce).
function collapseRuns(events, kind, describe, sameGroup = (a, b) => a.seat === b.seat) {
  const out = []

  for (let i = 0; i < events.length; i += 1) {
    if (events[i].kind !== kind) {
      out.push(events[i])
      continue
    }

    let end = i + 1
    while (end < events.length && events[end].kind === kind
      && sameGroup(events[end], events[i], events.slice(i, end))) end += 1

    const run = events.slice(i, end)
    out.push(run.length === 1 ? run[0] : describe(run))
    i = end - 1
  }

  return out
}

// The subject and the card are recovered from the run's own text because the parser
// owns that format at both ends; it also keeps an unnamed card rendering the way the
// game showed it rather than dropping out of the list.
// Builds the merged line for a run of the same per-card action. Shared by milling
// and drawing because they differ only in the verb.
//
// The count is always the number of cards; the list covers only the ones the game
// revealed. An opponent's draws are hidden, so their run collapses to a bare
// "draws 6 cards", while a run of your own names what you drew.
// A run is one effect, so it needs the same cause as well as the same player. Two
// mill triggers resolving back to back merged into a single line whose sources
// disagreed, and the conflicting attribution was then dropped entirely: seven cards
// milled with nothing saying what did it, when it was three from one permanent and
// four from another.
function sameActor(a, b) {
  return a.seat === b.seat && (a.source || null) === (b.source || null)
}

// "a Map", "an Illusion". Only the first letter is consulted, which is right for every
// token name seen so far; "Unicorn"-style exceptions would need a word list.
function withArticle(name) {
  return `${/^[AEIOU]/i.test(name) ? 'an' : 'a'} ${name}`
}

// Several identical tokens from one source at once: Get Lost's two Maps, Elspeth's
// doubled Soldiers. Grouped on player, source *and* token name, so different tokens
// never fold together.
function sameToken(a, b) {
  return sameActor(a, b) && (a.card || null) === (b.card || null)
    && Boolean(a.isCopy) === Boolean(b.isCopy) && (a.size || '') === (b.size || '')
}

// "creates 2 Map tokens", not "creates a Map and creates a Map". The count is put
// before "<name> tokens" rather than pluralising the name itself, which would go
// wrong on irregular plurals (Wolf, Elf).
function tokenDescriber(run) {
  const { who } = splitOn(run[0].text, ' creates ')
  const name = run[0].card || 'token'
  const credit = run[0].source ? ` (${run[0].source})` : ''
  // Copies keep their size after the name, so two numbers never sit side by side
  // ("2 1/1 token copies").
  const what = run[0].isCopy
    ? `${run.length} token copies of ${name}${run[0].size ? `, each ${run[0].size}` : ''}`
    : `${run.length} ${name} tokens`
  return { ...run[0], text: `${who} creates ${what}${credit}` }
}

function runDescriber(verb) {
  const marker = ` ${verb} `

  return (run) => {
    const { who } = splitOn(run[0].text, marker)
    const named = run.filter((entry) => entry.card)
    // Each line carries its cause as a suffix; the merged line states it once, so
    // it is stripped from the names before they are listed.
    const strip = (text, source) => {
      const suffix = source ? ` (${source})` : ''
      return suffix && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text
    }
    const shown = named.map((entry) => strip(splitOn(entry.text, marker).what, entry.source))
    const detail = shown.length > 0 ? `: ${joinList(countedList(shown))}` : ''

    const sources = new Set(run.map((entry) => entry.source || null))
    const cause = sources.size === 1 ? [...sources][0] : null
    // Two copies of a card are one source by name but two permanents. Counting the
    // instances says how many fired without having to tell them apart, which is the
    // distinction the narration deliberately does not draw elsewhere.
    const copies = new Set(run.map((entry) => entry.sourceId).filter((id) => id != null)).size
    const credit = cause ? ` (${cause}${copies > 1 ? ` ×${copies}` : ''})` : ''

    return {
      turn: run[0].turn,
      kind: run[0].kind,
      text: `${who} ${verb} ${run.length} cards${detail}${credit}`,
      seat: run[0].seat,
      card: null,
      cards: named.map((entry) => entry.card),
      source: cause,
      fromZone: run[0].fromZone,
    }
  }
}

// "Warg deals 3 damage to LazyPunda" followed by "LazyPunda loses 3 life (now 15)"
// is one event reported twice, so the pair becomes a single line. Damage to a
// planeswalker is the same: it removes that many loyalty counters, and the counter
// line only restates the blow — "deals 2 damage to Jace (now 2 loyalty)".
//
// Matched on the numbers rather than on adjacency alone: life changes constantly for
// reasons that are not damage — a shockland, a painful draw — and folding one of
// those into an unrelated attack would invent a cause. The merge only happens when
// the result is exactly the damage dealt, to exactly what took it, from the same
// source (the life change and the counter both name the creature that dealt it).
//
// The result need not be the very next line. A damage step reports every blow
// first and every result after — `A hits Jace, B hits Rish, Jace loses loyalty, Rish
// loses life` — so the search skips the step's other blows and results, and stops at
// anything else. Each result is claimed once, in order, so two copies of a card
// hitting the same player each take their own.
//
// The total is the one the message ends on: life comes from the player record and
// loyalty from the object, each reported once per message. So a target that changes
// again later in the same message states its total only on the last change — on an
// earlier one the number would already include blows not yet narrated.
function mergeDamageResults(events) {
  const STEP_KINDS = new Set(['damage', 'counter', 'life'])
  const claimed = new Set()
  const out = []

  for (let i = 0; i < events.length; i += 1) {
    if (claimed.has(i)) continue
    const damage = events[i]

    let match = -1
    if (damage.kind === 'damage') {
      for (let j = i + 1; j < events.length && STEP_KINDS.has(events[j].kind); j += 1) {
        if (!claimed.has(j) && isDamageResult(damage, events[j])) {
          match = j
          break
        }
      }
    }

    if (match === -1) {
      out.push(damage)
      continue
    }

    const result = events[match]
    claimed.add(match)
    const isLife = result.kind === 'life'
    const total = isLife ? result.total : result.loyaltyAfter
    const stated = total != null && !changesAgainInMessage(events, match)
    out.push({
      ...damage,
      // The unit is spelled out because, unlike the standalone life line, this
      // sentence is about damage — the number needs saying what it counts.
      text: stated ? `${damage.text} (now ${total} ${isLife ? 'life' : 'loyalty'})` : damage.text,
      // Kept as fields too: collapsing several attackers rebuilds the sentence and
      // cannot pick the total back out of the text.
      lifeAfter: stated && isLife ? total : undefined,
      loyaltyAfter: stated && !isLife ? total : undefined,
    })
  }

  return out
}

// The life or loyalty a blow took, as opposed to any other change to the same player
// or planeswalker. Damage to a permanent carries its instance id as the target.
function isDamageResult(damage, event) {
  if (event.kind === 'life') {
    return event.seat === damage.targetId
      && event.delta === -damage.amount
      && event.card === damage.card
  }
  return event.kind === 'counter'
    && event.counterKind === 'Loyalty'
    && !event.added
    && event.instanceId === damage.targetId
    && event.amount === damage.amount
    && event.source === damage.card
}

// Whether the player or planeswalker in the result at `index` changes again later in
// the same message, in which case the total that message reports is not yet the total
// at this point.
function changesAgainInMessage(events, index) {
  const result = events[index]
  for (let k = index + 1; k < events.length && events[k].kind !== 'turn'; k += 1) {
    const later = events[k]
    if (later.msg > result.msg) break
    if (later.msg !== result.msg) continue
    const same = result.kind === 'life'
      ? later.kind === 'life' && later.seat === result.seat
      : later.kind === 'counter' && later.counterKind === 'Loyalty' && later.instanceId === result.instanceId
    if (same) return true
  }
  return false
}

// The choice folded onto the line that cast or played the card. A card choosing twice
// reads as one clause: "choosing A and B". A named card joins `cards` so it previews.
function foldChoice(host, choice) {
  return {
    ...host,
    text: host.choices
      ? `${host.text} and ${choice.choice}`
      : `${host.text}, choosing ${choice.choice}`,
    choices: [...(host.choices || []), choice.choice],
    cards: choice.choiceCard ? [...(host.cards || []), choice.choiceCard] : host.cards,
  }
}

// A modal spell's mode belongs on the line that cast it: "casts and resolves
// Glacierwood Siege, choosing Temur" rather than two lines naming the same card.
//
// The choice is logged on resolution, which can trail the cast by a few lines when
// the spell's own effects are reported in between, so this searches backwards rather
// than requiring adjacency — but never past a turn boundary, and never further than
// a spell's own resolution would plausibly reach.
function mergeChoiceIntoCast(events) {
  const LOOKBACK = 8
  // A choice made *as* a permanent enters ("As this land enters, choose a basic land
  // type") is logged before the transfer that plays it, so it is held briefly for the
  // line that follows. Kept short, and same card and player, so it cannot reach an
  // unrelated later copy.
  const LOOKAHEAD = 3
  const out = []

  for (const event of events) {
    if ((event.kind === 'cast' || event.kind === 'play') && event.card) {
      let early = -1
      for (let i = out.length - 1; i >= 0 && out.length - i <= LOOKAHEAD; i -= 1) {
        if (out[i].kind === 'turn') break
        if (out[i].kind === 'choice' && out[i].card === event.card && out[i].seat === event.seat) {
          early = i
          break
        }
      }
      if (early !== -1) {
        const [choice] = out.splice(early, 1)
        out.push(foldChoice(event, choice))
        continue
      }
    }

    if (event.kind !== 'choice' || !event.card || !event.choice) {
      out.push(event)
      continue
    }

    // Lands are played, not cast, and a land's choice belongs on its play line.
    let target = -1
    for (let i = out.length - 1; i >= 0 && out.length - i <= LOOKBACK; i -= 1) {
      if (out[i].kind === 'turn') break
      if ((out[i].kind === 'cast' || out[i].kind === 'resolve' || out[i].kind === 'play') && out[i].card === event.card) {
        target = i
        break
      }
    }

    if (target === -1) {
      out.push(event)
      continue
    }

    out[target] = foldChoice(out[target], event)
  }

  return out
}

// A multi-creature attack is one event in the game and should read as one line.
// Grouped by target rather than by controller: two creatures swinging at a player
// combine, while one hitting a planeswalker stays separate.
function sameTarget(a, b) {
  return a.targetId === b.targetId
}

// Hits on one target merge, but never two from the same creature. That is a double
// striker hitting in both damage steps, and since the merged line counts names it
// read as two copies — "2 Pawpatch Recruit deal 4 damage" — when one creature hit
// twice. Two Llanowar Elves are two instances, so they still merge and count.
function sameTargetOnce(hit, first, run) {
  return hit.targetId === first.targetId
    && !(hit.sourceInstance != null && run.some((entry) => entry.sourceInstance === hit.sourceInstance))
}

function attackDescriber(run) {
  const names = run.map((entry) => entry.card).filter(Boolean)
  // Each attacker keeps its own size. Counting runs on name *and* size, so two
  // identical Llanowar Elves read "2 Llanowar Elves (1/1)" while a pumped one stays
  // separate.
  const labels = run.map((entry) => (entry.card ? `${entry.card}${entry.stats ? ` ${entry.stats}` : ''}` : null))
  const subject = names.length === run.length ? joinList(countedList(labels)) : `${run.length} creatures`
  return {
    turn: run[0].turn,
    kind: 'attack',
    // Plural verb: several creatures attack, one attacks.
    text: `${subject} attack ${run[0].targetLabel}`,
    seat: run[0].seat,
    card: null,
    cards: names,
    targetId: run[0].targetId,
    targetLabel: run[0].targetLabel,
  }
}

function damageDescriber(run) {
  const names = run.map((entry) => entry.card).filter(Boolean)
  const subject = names.length === run.length ? joinList(countedList(names)) : `${run.length} sources`
  const total = run.reduce((sum, entry) => sum + (entry.amount || 0), 0)
  // The total is the *last* hit's, not the first's: each blow reports the running
  // total, and only the final one is where the target ended up. Taken from that hit
  // alone, so when it states none the run states none — an earlier hit's total would
  // understate what the whole run did.
  const last = run[run.length - 1]
  const lifeAfter = last.lifeAfter != null ? last.lifeAfter : null
  const loyaltyAfter = last.loyaltyAfter != null ? last.loyaltyAfter : null
  const now = lifeAfter != null ? ` (now ${lifeAfter} life)`
    : loyaltyAfter != null ? ` (now ${loyaltyAfter} loyalty)` : ''

  return {
    turn: run[0].turn,
    kind: 'damage',
    text: `${subject} deal ${total} damage to ${run[0].targetLabel}${now}`,
    cards: [...new Set(run.flatMap((entry) => entry.cards || []))],
    amount: total,
    targetId: run[0].targetId,
    targetLabel: run[0].targetLabel,
    lifeAfter,
    loyaltyAfter,
  }
}

// "X resolves" followed by "X attaches to Y" is one moment reported twice.
//
// Only the standalone resolve is merged. When the cast and resolve already collapsed
// into one line, the attach stays separate rather than being bolted onto a sentence
// that may already carry a targeting clause for the same permanent.
function mergeResolveAttach(events) {
  const out = []

  for (const event of events) {
    const previous = out[out.length - 1]
    const pairs = event.kind === 'attach'
      && previous
      && previous.kind === 'resolve'
      && previous.card === event.card
      && event.attachedTo

    if (!pairs) {
      out.push(event)
      continue
    }

    out[out.length - 1] = {
      ...previous,
      text: `${previous.text} and attaches to ${event.attachedTo}`,
      cards: event.cards,
    }
  }

  return out
}

// One phrasing for a counter line, so a single creature and a merged run cannot
// drift apart. "a +1/+1 counter" rather than "1 counter" reads as English.
function counterPhrase(targets, added, amount, kind, source) {
  const subject = joinList(countedList(targets))
  // The source is named even when it is the target. It reads redundantly in
  // isolation, but a counter a permanent puts on or takes off itself is the cost or
  // effect of its own ability, and naming it is what ties the line to the other
  // lines of that same trigger — a counter removed as a cost otherwise looks
  // unrelated to the destroy it paid for.
  const credit = source || null
  const verb = targets.length > 1 ? (added ? 'get' : 'lose') : (added ? 'gets' : 'loses')
  const quantity = amount === 1 ? 'a' : String(amount)
  const noun = `${kind ? `${kind} ` : ''}counter${amount === 1 ? '' : 's'}`
  return `${subject} ${verb} ${quantity} ${noun}${credit ? ` (${credit})` : ''}`
}

// Several creatures taking counters from one source is a single effect resolving.
function sameCounter(a, b) {
  return a.source === b.source
    && a.counterKind === b.counterKind
    && a.added === b.added
    && a.amount === b.amount
}

function counterDescriber(run) {
  const targets = run.map((entry) => entry.card).filter(Boolean)
  return {
    turn: run[0].turn,
    kind: 'counter',
    text: counterPhrase(targets, run[0].added, run[0].amount, run[0].counterKind, run[0].source),
    seat: run[0].seat,
    card: null,
    cards: targets,
    added: run[0].added,
    amount: run[0].amount,
    counterKind: run[0].counterKind,
    source: run[0].source,
  }
}

// Card labels for a list, where some may be face-down. Unknowns collapse into a
// count ("2 cards") rather than repeating "a card", and named ones keep their
// first-appearance order.
function cardLabels(names, total) {
  const named = names.filter(Boolean)
  const unknown = total - named.length
  const parts = countedList(named)
  if (unknown === 1) parts.push('a card')
  else if (unknown > 1) parts.push(`${unknown} cards`)
  return parts
}

// Looking at the top of the library and splitting the result is one decision, so
// "puts a card into hand" and "puts a card on the bottom" become one sentence.
// Where every card went the same way, the destination is said once.
function selectDescriber(run) {
  const { who } = splitOn(run[0].text, ' puts ')
  const destinations = new Set(run.map((entry) => entry.destination))
  // The whole run is one effect resolving, so a cause shared by all of it is stated
  // once at the end. Rebuilt here rather than inherited, because the merged text is
  // composed from scratch and would otherwise lose it.
  const sources = new Set(run.map((entry) => entry.source || null))
  const cause = sources.size === 1 ? [...sources][0] : null
  const credit = cause ? ` (${cause})` : ''
  const cards = run.map((entry) => entry.card).filter(Boolean)

  if (destinations.size === 1) {
    const labels = cardLabels(run.map((entry) => entry.card), run.length)
    return {
      turn: run[0].turn,
      kind: 'select',
      text: `${who} puts ${joinList(labels)} ${run[0].destination}${credit}`,
      seat: run[0].seat,
      card: null,
      cards,
      destination: run[0].destination,
      source: cause,
      fromZone: run[0].fromZone,
    }
  }

  const fragments = run.map((entry) => `${entry.card || 'a card'} ${entry.destination}`)
  return {
    turn: run[0].turn,
    kind: 'select',
    text: `${who} puts ${joinList(fragments)}${credit}`,
    seat: run[0].seat,
    card: null,
    cards,
    // Mixed destinations: nothing shared to carry forward.
    destination: null,
    source: cause,
  }
}

// Scrying and then drawing is one spell doing its job — Opt, Preordain and the rest
// read as a single sentence. Merged only when the draw is the very next thing the
// same player does, so an unrelated draw later in the turn stays its own line.
//
// Runs after the draw collapse, so "draws 6 cards" merges as one clause rather than
// swallowing only the first of six.
function mergeScryDraw(events) {
  const out = []

  for (const event of events) {
    const previous = out[out.length - 1]
    const pairs = event.kind === 'draw'
      && previous
      && previous.kind === 'scry'
      && previous.seat === event.seat

    if (!pairs) {
      out.push(event)
      continue
    }

    const { what } = splitOn(event.text, ' draws ')
    // The credit moves to the end: a scry-then-draw is one spell, so "(Opt)" sitting
    // after the first clause reads as though only that half came from it.
    const suffix = previous.source ? ` (${previous.source})` : ''
    // The draw carries its own credit too, and folding it in unchanged printed
    // "(Opt) (Opt)". Strip it before the shared one is re-appended.
    const drawn = event.source && what.endsWith(` (${event.source})`)
      ? what.slice(0, -` (${event.source})`.length)
      : what
    const base = suffix && previous.text.endsWith(suffix)
      ? previous.text.slice(0, -suffix.length)
      : previous.text

    out[out.length - 1] = {
      ...previous,
      text: `${base} and draws ${drawn}${suffix}`,
      cards: [...(previous.cards || []), ...(event.cards || []), event.card].filter(Boolean),
    }
  }

  return out
}

// Adjacent lines crediting the same source are one effect resolving, so they read
// as one sentence with the credit stated once: a cost paid and the thing it paid
// for, or several permanents dealt with by a single trigger.
//
// Adjacency *and* a shared source together are what make this safe — either alone
// would fold unrelated events together.
// The words two clauses begin with in common, as a prefix to drop from the second.
// Whole words only, and never the entire clause — "draws Forest" beside "draws
// Forest Tentacle" shares "draws ", not "draws Forest".
// Words two clauses begin with in common, dropped from the second so one player is
// not named twice. Whole words only, and never the whole clause.
//
// `names` are the cards the merged line mentions, and nothing may cut into one. Two
// legendaries can share a first word — "Chandra, Torch of Defiance" beside "Chandra,
// Chill of Compliance" — and dropping the shared "Chandra," left the second reading
// as "Chill of Compliance", a card that does not exist. Word-boundary safety is not
// enough on its own, because a card name is several words.
function sharedOpening(first, second, names = []) {
  const a = first.split(' ')
  const b = second.split(' ')
  let count = 0
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1
  if (count >= a.length || count >= b.length) count -= 1
  if (count <= 0) return ''

  const opening = `${a.slice(0, count).join(' ')} `
  // Only clauses that *begin* with a card name can be cut into one: "draws Forest"
  // beside "draws Forest Tentacle" opens with the verb, so it is unaffected.
  const splitsName = names.some((name) => second.startsWith(name) && opening.length < name.length)
  return splitsName ? '' : opening
}

function mergeSharedSource(events) {
  const MERGEABLE = new Set(['counter', 'destroy', 'exile', 'return', 'token', 'sacrifice', 'draw'])
  const out = []

  for (const event of events) {
    const previous = out[out.length - 1]
    const pairs = event.source
      && previous
      && previous.source === event.source
      && MERGEABLE.has(event.kind)
      && MERGEABLE.has(previous.kind)

    if (!pairs) {
      out.push(event)
      continue
    }

    const suffix = ` (${event.source})`
    const strip = (text) => (text.endsWith(suffix) ? text.slice(0, -suffix.length) : text)
    const cards = [
      ...(previous.cards || []), previous.card,
      ...(event.cards || []), event.card,
    ].filter(Boolean)

    // What each folded-in line contributed, kept because the merge destroys the
    // fields the game summary reads: it sets `card` to null and takes `fromZone` from
    // whichever line came first. A Chandra exiled from its owner's library, merged
    // into the counter that exiled it, became invisible to the summary — which then
    // reported one copy of a card seen twice.
    //
    // Seat is carried per entry rather than taken from the merged line: these pair on
    // a shared source, not a shared player, so one line can be about each of them.
    // Kind travels with each entry too: the merged line takes the *first* line's kind,
    // so an exile folded into a counter stopped looking like an ownership event at all
    // and was skipped whole, origins and everything.
    const originOf = (entry) => (entry.origins
      || (entry.card
        ? [{ card: entry.card, seat: entry.seat, fromZone: entry.fromZone, kind: entry.kind }]
        : []))
    const origins = [...originOf(previous), ...originOf(event)]

    // Two cards doing the same thing share a predicate, so it is said once and the
    // verb goes plural: "A and B return to hand", not "A returns to hand and B
    // returns to hand". Different predicates fall back to joining the sentences.
    const shared = previous.predicate && event.predicate
      && previous.predicate.one === event.predicate.one

    if (shared) {
      const subjects = [...(previous.subjects || [previous.subject]), event.subject]
      out[out.length - 1] = {
        ...previous,
        text: `${joinList(subjects)} ${event.predicate.many}${suffix}`,
        card: null,
        cards,
        origins,
        tokenRefs: [...(previous.tokenRefs || []), ...(event.tokenRefs || [])],
        subjects,
      }
      continue
    }

    // Two clauses about the same player repeat its name — "Lawgikill sacrifices X
    // and Lawgikill draws Y" — so whatever words they open with in common are said
    // once. This also folds "sacrifices X and sacrifices Y" into "sacrifices X and Y".
    const first = strip(previous.text)
    const second = strip(event.text)
    // Against the *last* clause, not the whole sentence: after a first merge the
    // sentence opens with whatever began it, so "X is destroyed and Lawgikill
    // sacrifices Y" never shared an opening with "Lawgikill draws Z" and the player
    // was named twice.
    const opening = sharedOpening(previous.lastClause || first, second, cards)

    out[out.length - 1] = {
      ...previous,
      text: `${first} and ${second.slice(opening.length)}${suffix}`,
      lastClause: second,
      card: null,
      cards,
      origins,
      // Carried so a token folded into a sentence keeps its hover.
      tokenRefs: [...(previous.tokenRefs || []), ...(event.tokenRefs || [])],
      // A merged sentence has no single predicate left to factor against.
      predicate: null,
    }
  }

  return out
}

function splitOn(text, verb) {
  const at = text.indexOf(verb)
  if (at === -1) return { who: '', what: text }
  return { who: text.slice(0, at), what: text.slice(at + verb.length) }
}

// Two things describe a turn that has already ended but arrive after the *next*
// turn's header, under the wrong player's name:
//
//   - Discarding to hand size, because MTGA advances the turn counter before it
//     reports the previous turn's cleanup.
//   - The held-up-mana summary, which is emitted alongside the new header but is a
//     statement about the player whose turn just finished.
//
// Both are moved back to the end of the turn they belong to. The discards are also
// merged: three "discards a card" lines say less than one naming all three.
//
// Verified against real games: both sit immediately after the turn header with
// nothing else mixed in, which is what makes relocating the whole block safe.
// Kinds emitted alongside a turn header that actually describe the turn that just
// ended. Anything new emitted at a turn boundary belongs here, or it strands itself
// under the following turn — which is exactly what happened to cleanup discards when
// the mana line was added.
const TURN_END_KINDS = new Set(['counts', 'mana'])

function relocateTurnEnd(events) {
  const out = []

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (event.kind !== 'turn') {
      out.push(event)
      continue
    }

    // Every turn-closing summary, in the order it was emitted: the counts line then
    // the mana line. Collected as a group rather than by kind so adding another one
    // is a matter of naming it here.
    let cursor = i + 1
    const summaries = []
    while (cursor < events.length && TURN_END_KINDS.has(events[cursor].kind)) {
      summaries.push(events[cursor])
      cursor += 1
    }

    let end = cursor
    while (end < events.length && events[end].kind === 'discard' && events[end].cleanup) end += 1
    const run = events.slice(cursor, end)

    if (run.length > 0) {
      // The merged line is built from the run's own text because the parser owns
      // both ends of that format; it also keeps unnamed cards ("a card") rendering
      // as the game showed them, rather than silently dropping out of the list.
      const { who } = splitOn(run[0].text, ' discards ')
      const shown = run.map((entry) => splitOn(entry.text, ' discards ').what)

      out.push({
        // It now sits in the previous turn, so it takes that turn's number rather
        // than the one it was logged under.
        turn: out.length > 0 ? out[out.length - 1].turn : run[0].turn,
        kind: 'discard',
        text: shown.length === 1
          ? `${who} discards ${shown[0]} down to hand size`
          : `${who} discards ${shown.length} cards down to hand size: ${joinList(countedList(shown))}`,
        seat: run[0].seat,
        card: shown.length === 1 ? run[0].card : null,
        // Every name stays hoverable, which is most of the point of merging.
        cards: run.map((entry) => entry.card).filter(Boolean),
        // A merged line loses the single `card`, so without this the discarded
        // cards vanish from anything reading the narration — the game summary
        // missed every card an opponent discarded.
        fromZone: run[0].fromZone,
        cleanup: true,
      })
    }

    // Last lines of the turn: the discard is an action within it, these are the
    // summary it closes on.
    for (const summary of summaries) {
      out.push({ ...summary, turn: out.length > 0 ? out[out.length - 1].turn : summary.turn })
    }

    out.push(event)
    i = end - 1
  }

  return out
}

// Walks the log once before the real parse, to find cast attempts the player backed
// out of. Removing them up front — rather than filtering their events later — keeps
// their object-id renumbering out of the parse entirely, which matters because
// identity tracking depends on those chains being trustworthy.
//
// Returns a set of "<message index>:<instance id>" keys to skip.
// What *we* sideboarded between games, which the log states outright rather than
// leaving to be inferred: the GRE asks for a list with `submitDeckReq` carrying the
// deck as it stood, and the client answers with `submitDeckResp` carrying the list
// actually submitted. Diffing the two maindecks gives in and out exactly.
//
// Only our own. The opponent's submission is sent to the opponent, never to us, which
// is why their side has to be guessed from what they were seen to play.
//
// Read as one string rather than streamed like the other pre-pass: the response is a
// **pretty-printed multi-line block**, since it travels client-to-GRE rather than in
// the single-line `greToClientEvent` stream, so a line-by-line parse cannot see it at
// all. Brace matching over the whole text is both simpler and the only thing that
// works; these blocks are a handful per log.
// Your answers to MTGA's casting-time questions: which mode of a modal spell, and
// whether to pay an optional additional cost such as offspring or kicker. MTGA sends
// a `castingTimeOptionsReq` (single-line, so the main parse sees it) and the client
// answers with a `castingTimeOptionsResp`, a pretty-printed client-to-GRE block the
// main parse cannot see — the same situation as the sideboard submission.
//
// Returned as one entry per request, **in file order**, each carrying the request's
// own msgId and gameStateId. The main parse walks requests in the same order and
// checks both ids before using an entry, so a misalignment can only drop a choice,
// never attach one to the wrong spell. A reply is paired with the first reply after
// its request, and only if it comes before the next request.
//
// Only the player choosing is asked, so the opponent's choices are never here.
function findCastingChoices(text) {
  const requests = []
  const requestKey = /"castingTimeOptionsReq":\s*\{/g
  let hit
  while ((hit = requestKey.exec(text)) !== null) {
    // The message's own ids precede its payload inside the same message object. The
    // greedy prefix takes the *last* id before the payload: a line can pack several
    // messages, and the first id in the window may belong to an earlier one.
    const head = text.slice(Math.max(0, hit.index - 400), hit.index)
    const msgId = head.match(/[^]*"msgId":\s*(\d+)/)
    const gameStateId = head.match(/[^]*"gameStateId":\s*(\d+)/)
    requests.push({
      at: hit.index,
      msgId: msgId ? Number(msgId[1]) : null,
      gameStateId: gameStateId ? Number(gameStateId[1]) : null,
      choice: null,
    })
  }

  const replyKey = /"castingTimeOptionsResp":\s*\{/g
  while ((hit = replyKey.exec(text)) !== null) {
    const respId = text.slice(Math.max(0, hit.index - 400), hit.index).match(/[^]*"respId":\s*(\d+)/)
    if (!respId) continue
    const owner = [...requests].reverse().find((request) => request.at < hit.index)
    if (!owner || owner.choice || owner.msgId !== Number(respId[1])) continue

    let depth = 0
    const open = text.indexOf('{', hit.index)
    for (let at = open; at < text.length; at += 1) {
      if (text[at] === '{') depth += 1
      else if (text[at] === '}' && --depth === 0) {
        try {
          const reply = JSON.parse(text.slice(open, at + 1)).castingTimeOptionResp || {}
          owner.choice = {
            ctoId: reply.ctoId,
            type: reply.castingTimeOptionType,
            modes: (reply.chooseModalResp && reply.chooseModalResp.grpIds) || [],
          }
        } catch {
          // A reply that will not parse is a choice we simply do not report.
        }
        break
      }
    }
  }

  return requests
}

function findSideboarding(text, resolveName) {
  const steps = new Map()

  // Every `"key": {` in the file, as the object it introduces.
  const objectAt = (from) => {
    const open = text.indexOf('{', from)
    if (open === -1) return null
    let depth = 0
    for (let at = open; at < text.length; at += 1) {
      if (text[at] === '{') depth += 1
      else if (text[at] === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(open, at + 1))
          } catch {
            return null
          }
        }
      }
    }
    return null
  }

  // The match and game a submission belongs to, taken from the markers before it. A
  // boarding step happens after a game ends and before the next begins, so it belongs
  // to the game *after* the last one named — confirmed against a real log, where the
  // submission sits between the last `gameNumber: 1` and the first `gameNumber: 2`.
  const lastBefore = (pattern, offset) => {
    let found = null
    const search = new RegExp(pattern, 'g')
    let hit
    while ((hit = search.exec(text)) !== null) {
      if (hit.index > offset) break
      found = hit[1]
    }
    return found
  }

  let at = 0
  for (;;) {
    const respAt = text.indexOf('"submitDeckResp"', at)
    if (respAt === -1) break
    at = respAt + 1

    // The request it answers is the one immediately before it: the client cannot be
    // asked for a second list without having answered the first.
    const reqAt = text.lastIndexOf('"submitDeckReq"', respAt)
    if (reqAt === -1) continue

    const before = objectAt(reqAt)
    const after = objectAt(respAt)
    if (!before || !after || !before.deck || !after.deck) continue

    const tally = (list) => {
      const counts = new Map()
      for (const grpId of list || []) counts.set(grpId, (counts.get(grpId) || 0) + 1)
      return counts
    }

    const was = tally(before.deck.deckCards)
    const now = tally(after.deck.deckCards)

    const delta = (from, to) => {
      const out = []
      for (const [grpId, count] of from) {
        const change = count - (to.get(grpId) || 0)
        if (change <= 0) continue
        const name = resolveName(grpId)
        if (name) out.push({ name, count: change })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    }

    const boardedIn = delta(now, was)
    const boardedOut = delta(was, now)
    if (boardedIn.length === 0 && boardedOut.length === 0) continue

    const matchId = lastBefore('"matchID":\\s*"([^"]+)"', respAt)
    const gameNumber = Number(lastBefore('"gameNumber":\\s*(\\d+)', respAt) || 0) + 1
    steps.set(`${matchId}:${gameNumber}`, { in: boardedIn, out: boardedOut })
  }

  return steps
}

async function findCancelledCasts(logPath) {
  const cancelled = new Set()
  // instanceId -> the attempt currently on the stack for it. **One at a time**: a
  // second CastSpell transfer on the same instance means the first was backed out of,
  // and that supersession is the only thing that marks a cancellation. Keeping a flat
  // list of attempts instead let a cast be confirmed twice — once by its commitment
  // and again by its resolution — which quietly revived the attempt beneath it.
  let open = new Map()
  let index = 0

  const confirm = (instanceId) => {
    if (instanceId != null) open.delete(instanceId)
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(logPath),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    const brace = line.indexOf('{')
    if (brace === -1) continue
    let payload
    try {
      payload = JSON.parse(line.slice(brace))
    } catch {
      continue
    }
    const event = payload.greToClientEvent
    if (!event) continue

    for (const message of event.greToClientMessages || []) {
      index += 1
      const state = message.gameStateMessage
      if (!state) continue

      // Attempts do not carry across games.
      if (state.type === 'GameStateType_Full') {
        for (const [instanceId, at] of open) cancelled.add(`${at}:${instanceId}`)
        open = new Map()
      }

      for (const annotation of state.annotations || []) {
        const types = annotation.type || []
        const details = detailsToObject(annotation)

        if (types.includes('AnnotationType_ZoneTransfer') && details.category === 'CastSpell') {
          const instanceId = (annotation.affectedIds || [])[0]
          if (instanceId != null) {
            // Whatever was already on the stack under this id was never completed.
            const previous = open.get(instanceId)
            if (previous != null) cancelled.add(`${previous}:${instanceId}`)
            open.set(instanceId, index)
          }
        }

        // The commitment. Matched to the most recent unconfirmed attempt on that
        // instance, because ids recycle within a handful of messages.
        if (types.includes('AnnotationType_UserActionTaken') && details.actionType === 1) {
          confirm((annotation.affectedIds || [])[0])
        }

        // A resolution also proves the cast was real, and is needed because **MTGA
        // does not always send the commitment**. A modal spell that prompts for its
        // mode and then its costs (`CastingTimeOptionsReq`, `PayCostsReq`) can arrive
        // with no `actionType: 1` at all and no `ResolutionStart` either — a real
        // Bushwhack left nothing but the transfer, its effect, and a
        // `ResolutionComplete`, so requiring the commitment deleted a spell that had
        // plainly resolved.
        //
        // This cannot resurrect a genuinely cancelled attempt: a cancelled one never
        // resolves, and when the player backs out and recasts, the second transfer on
        // the same instance leaves the first still pending — which is what cancels it.
        // Verified across three archives: the only verdict that changed was Bushwhack.
        if (types.includes('AnnotationType_ResolutionStart')
          || types.includes('AnnotationType_ResolutionComplete')) {
          confirm(annotation.affectorId)
        }
      }
    }
  }

  for (const [instanceId, at] of open) cancelled.add(`${at}:${instanceId}`)
  return cancelled
}

async function parseLogFile(logPath, options = {}) {
  const resolveName = options.resolveName || (() => null)
  const parser = new LogParser(
    resolveName, options.resolveChoice, options.resolveCounter,
    options.resolveAbility, options.resolveAbilityText,
  )
  if (options.resolveSubType) parser.resolveSubType = options.resolveSubType
  parser.cancelledCasts = await findCancelledCasts(logPath)
  // Both of these need the multi-line client-to-GRE blocks the streaming parse cannot
  // see, so the file is read whole once and shared.
  const wholeText = fs.readFileSync(logPath, 'utf8')
  const sideboarding = findSideboarding(wholeText, resolveName)
  parser.castingChoices = findCastingChoices(wholeText)

  const rl = readline.createInterface({
    input: fs.createReadStream(logPath),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    const brace = line.indexOf('{')
    if (brace === -1) continue

    let payload
    try {
      payload = JSON.parse(line.slice(brace))
    } catch {
      // Multi-line pretty-printed blocks land here. They carry no *game state* — but
      // the client's own deck submission is one of them, which is why findSideboarding
      // reads the file separately rather than hooking into this loop.
      continue
    }

    const room = payload.matchGameRoomStateChangedEvent
    if (room) {
      const players = room.gameRoomInfo?.gameRoomConfig?.reservedPlayers || []
      for (const player of players) {
        if (player.systemSeatId != null) parser.seatNames[player.systemSeatId] = player.playerName
      }
      // Why the match ended: normally "Success", but a concession, timeout or
      // disconnect says so here rather than in any game's own result.
      const final = room.gameRoomInfo?.finalMatchResult
      if (final?.matchCompletedReason) parser.matchCompletedReason = final.matchCompletedReason
      // The authoritative per-game outcomes, in order. The GRE stream can stop
      // mid-game — a conceded game 2 simply has no GameOver message — so this is
      // often the only place that game's result exists.
      if (final?.resultList) {
        parser.finalGameResults = final.resultList.filter((entry) => entry.scope === 'MatchScope_Game')
      }
    }

    const event = payload.greToClientEvent
    if (!event) continue
    for (const message of event.greToClientMessages || []) {
      parser.messageIndex += 1
      parser.handleMessage(message)
    }
  }

  return {
    games: parser.finish().map((game) => ({
      ...game,
      sideboarding: sideboarding.get(`${game.matchId}:${game.gameNumber}`) || null,
    })),
    seatNames: parser.seatNames,
    localSeat: parser.localSeat,
    submittedDecks: parser.submittedDecks,
    matchCompletedReason: parser.matchCompletedReason,
  }
}

module.exports = { parseLogFile }
