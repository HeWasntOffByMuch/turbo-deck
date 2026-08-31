/**
 * The wire's own test data (spec 258): one representative message per member
 * of `ClientMessageType` and `ServerMessageType`, so the codec's round-trip
 * test and `wireFingerprint` read from the same set instead of each keeping a
 * partial copy that can drift from the other.
 *
 * It moved out of `codec.test.ts`, which had accumulated two arrays for its
 * own round-trip assertions and happened to cover sixteen of twenty-seven
 * client types and sixteen of twenty-four server types -- a coincidence of
 * what somebody had reached for, not a claim of completeness. Spec 258 is
 * what turns completeness into something `wire-fingerprint.test.ts` checks
 * against the enums, rather than a gap a reviewer has to notice on their own.
 *
 * Every value below is a fixed literal. Nothing here may read a clock, draw
 * from `Math.random`, or touch the shipped map: the three map messages are
 * small fixtures in the shape of `map-messages.test.ts`'s own, not the real
 * document -- `loadMapFile` reads that off disk, and this module has to stay
 * as portable as the codec it is testing.
 */

import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
} from '../state/types.js';
import { maxStackOf } from '../data/items.js';
import { NO_ATTACK_SPEED } from '../sim/attack-timing.js';
import { NO_WEAPON } from '../data/weapon-scaling.js';
import { NEUTRAL_TRAITS } from '../player/derived.js';
import { startingBaseStats } from '../player/attributes.js';
import type { ClientMessage, ServerMessage } from './messages.js';
import {
  ChunkDeniedReason,
  ClientMessageType,
  ProgressionTarget,
  ServerMessageType,
  SpawnerStateValue,
  TradeStageValue,
} from './protocol.js';

const STATS: EffectiveStats = {
  maxHealth: 137.5,
  moveSpeed: 152.25,
  turnRate: 210,
  attackDamage: 11.5,
  attackRange: 56,
  baseAttackTimeTicks: 7,
  ...NO_ATTACK_SPEED,
  armor: 0.125,
  spellPower: 1.5,
  critChance: 0.0625,
  maxResource: 30,
  // f32-exact, so the round-trip is testing the codec and not float precision.
  resourceRegen: 0.0625,
  basicAttackId: 'ranged.shot',
  skillAbilityIds: [],
  ...NO_WEAPON,
  traits: NEUTRAL_TRAITS,
};

export const CLIENT_CORPUS: readonly ClientMessage[] = [
  {
    type: ClientMessageType.Hello,
    protocolVersion: 1,
    playerId: 'alice',
    displayName: 'Alice',
    token: '',
    assetManifest: '',
    resumeToken: 'resume-1',
    authToken: 'sess-1',
  },
  {
    type: ClientMessageType.Input,
    seq: 4096,
    moveX: -0.5,
    moveY: 0.75,
    facing: 1.5,
    buttons: 5,
    predictedX: -1234.5,
    predictedY: 987.25,
    renderLagTicks: 9,
  },
  { type: ClientMessageType.Ping, nonce: 123456 },
  { type: ClientMessageType.Equip, slot: 'mainHand', itemId: 'sword.keen' },
  { type: ClientMessageType.Unequip, slot: 'offHand' },
  { type: ClientMessageType.SpendProgressionPoint, target: ProgressionTarget.Specialization, specializationId: 'str.crushingBlows' },
  { type: ClientMessageType.Chat, text: 'hello world' },
  {
    type: ClientMessageType.UseAbility,
    abilityId: 'melee.slash',
    targetX: 612.5,
    targetY: -48.25,
    // The body it was aimed at (spec 070); 0 would be a point aim.
    targetEntityId: 44,
    // The input this request was made on (spec 067), not decoration: the
    // server commits on that input rather than on arrival.
    afterInputSeq: 9001,
  },
  { type: ClientMessageType.CancelCast, afterInputSeq: 9002 },
  { type: ClientMessageType.OpenVendor, vendorId: 'vendor.armourer' },
  { type: ClientMessageType.OpenVendor, vendorId: '' },
  {
    type: ClientMessageType.BuyItem,
    requestId: 3,
    vendorId: 'vendor.quartermaster',
    defId: 'potion.minor',
    count: 5,
  },
  {
    // A negative count is a rule refusal with a reason, so it has to survive
    // the wire to be refused (spec 126's lesson about a slot index).
    type: ClientMessageType.SellItem,
    requestId: 4,
    vendorId: 'vendor.quartermaster',
    index: -1,
    count: -2,
  },
  { type: ClientMessageType.BuyBack, requestId: 5, vendorId: 'vendor.quartermaster', index: 0 },
  {
    type: ClientMessageType.MoveItem,
    requestId: 7,
    from: { container: 'inventory', index: 3 },
    to: { container: 'equipment', index: 0 },
    count: 0,
  },
  {
    // An out-of-range index is a *rule* refusal, so it has to survive the
    // wire to be refused with a reason -- a signed index, not a length.
    type: ClientMessageType.MoveItem,
    requestId: 8,
    from: { container: 'inventory', index: -1 },
    to: { container: 'inventory', index: 5 },
    count: 4,
  },
  {
    type: ClientMessageType.DropItem,
    requestId: 9,
    at: { container: 'inventory', index: 3 },
    count: 0,
    aimX: 512,
    aimY: -344,
  },
  {
    // A worn item goes on the ground the same way a carried one does, and an
    // out-of-range index is still a refusal with a reason rather than a
    // corrupt frame (spec 172).
    type: ClientMessageType.DropItem,
    requestId: 10,
    at: { container: 'equipment', index: -1 },
    count: 2,
    aimX: 0,
    aimY: 0,
  },
  // Both halves of one message (spec 246): a body to talk to, and the 0 that
  // ends it. The zero is the case worth carrying, since it is what a client
  // leaving sends and what a varuint encodes in its shortest form.
  { type: ClientMessageType.Talk, entityId: 4242 },
  { type: ClientMessageType.Talk, entityId: 0 },

  // --- added for spec 258, closing the gap the fingerprint exists to find ---

  // Same shape as map-messages.test.ts's own: negative coordinates, and a
  // layer other than the ground layer's 0.
  { type: ClientMessageType.RequestChunk, layer: 1, cx: -12, cz: 40 },
  // The only client message that changes nothing about the world -- both
  // halves of the subscription, since the debug overlay is opt-in each way.
  { type: ClientMessageType.WatchSpawners, on: true },
  { type: ClientMessageType.WatchSpawners, on: false },
  { type: ClientMessageType.TradeInvite, entityId: 77 },
  // Both answers to an invitation (spec 132): accepting opens the table,
  // declining ends it before it does.
  { type: ClientMessageType.TradeRespond, accept: true },
  { type: ClientMessageType.TradeRespond, accept: false },
  {
    type: ClientMessageType.TradeOffer,
    slots: [
      { index: 2, count: 1 },
      // Signed, like every other slot index on this wire (spec 126): a
      // nonsensical offer is a rule refusal with a reason, not a corrupt frame.
      { index: -1, count: 0 },
    ],
    coins: 50,
  },
  { type: ClientMessageType.TradeAccept, revision: 4 },
  { type: ClientMessageType.TradeCancel },
  { type: ClientMessageType.Goodbye },
  { type: ClientMessageType.RespecProgression },
  { type: ClientMessageType.PickUpItem, requestId: 6, entityId: 909 },
  { type: ClientMessageType.Respawn },
];

export const SERVER_CORPUS: readonly ServerMessage[] = [
  {
    type: ServerMessageType.Welcome,
    protocolVersion: 1,
    playerId: 'alice',
    entityId: 3,
    tick: 900,
    tickRate: 20,
    chunkSize: 100,
    interestRadius: 3,
    correctionThreshold: 48,
    worldSeed: 4242,
    sessionToken: 'sess-1',
  },
  {
    type: ServerMessageType.Delta,
    tick: 42,
    ackInputSeq: 17,
    removed: [],
    upserts: [],
  },
  {
    type: ServerMessageType.Correction,
    inputSeq: 9,
    position: { x: -1600.5, y: 2500.25, z: -12.5 },
    facing: -3.125,
    reason: 1,
  },
  {
    type: ServerMessageType.Effect,
    effectId: 'skill.arcLash.impact',
    x: 320.5,
    y: -18.25,
    z: 4,
    radius: 300,
    durationTicks: 24,
    // Non-zero, and not a round number: a fixture that only ever carries the
    // default cannot tell a field that survives from one the decoder fills in
    // (spec 235). This message had no fixture at all until the bearing was
    // added to it.
    rotation: -2.5,
  },
  {
    type: ServerMessageType.CombatResult,
    attackerId: 1,
    targetId: 2,
    damage: 12.5,
    targetHealth: 27.5,
    flags: 3,
    // Not 0: a round trip that only ever carries the default cannot tell a
    // field that survives from one the decoder fills in (spec 232).
    element: 6,
  },
  {
    type: ServerMessageType.Stats,
    entityId: 1,
    level: 7,
    experience: 340,
    specializations: [
      { specializationId: 'str.crushingBlows', tier: 3 },
      { specializationId: 'agi.quickRecovery', tier: 1 },
    ],
    baseStats: startingBaseStats(),
    attributes: startingBaseStats(),
    unspentProgressionPoints: 2,
    stats: STATS,
  },
  {
    // ...and with nothing spent, which is every character's first minute.
    type: ServerMessageType.Stats,
    entityId: 1,
    level: 1,
    experience: 0,
    specializations: [],
    baseStats: startingBaseStats(),
    attributes: startingBaseStats(),
    unspentProgressionPoints: 2,
    stats: STATS,
  },
  {
    type: ServerMessageType.CastState,
    entityId: 12,
    abilityId: 'melee.slash',
    phase: 0,
    startTick: 470,
    releaseTick: 4210,
    endTick: 4222,
    targetX: 612.5,
    targetY: -48.25,
    // What the swing is aimed at (spec 070), which is what makes it single
    // target on the other side of the wire.
    targetEntityId: 44,
  },
  { type: ServerMessageType.CastEnded, entityId: 12, abilityId: 'melee.slash', reason: 0 },
  { type: ServerMessageType.Chat, channel: 2, from: 'Server', text: 'be nice' },
  {
    type: ServerMessageType.Cooldowns,
    entries: [
      { abilityId: 'skill.acidSpray', readyAtTick: 1800 },
      { abilityId: 'skill.blight', readyAtTick: 2400 },
    ],
    resource: 12.5,
    atTick: 1750,
  },
  { type: ServerMessageType.Cooldowns, entries: [], resource: 0, atTick: 0 },
  // An empty bag, a full one, and a stack at its ceiling (spec 126) -- the
  // three shapes a container has, and the codec has to carry all of them.
  {
    type: ServerMessageType.Inventory,
    requestId: 0,
    inventory: emptyInventory(),
    equipment: EMPTY_EQUIPMENT,
    coins: 137,
  },
  {
    type: ServerMessageType.Inventory,
    requestId: 12,
    inventory: [...emptyInventory()].map(() => ({ defId: 'sword.worn', count: 1 })),
    equipment: { ...EMPTY_EQUIPMENT, mainHand: 'bow.hunting', chest: 'chest.leather' },
    coins: 137,
  },
  {
    type: ServerMessageType.Inventory,
    requestId: 3,
    inventory: [...emptyInventory()].map((_, i) =>
      i === 2 ? { defId: 'potion.minor', count: maxStackOf('potion.minor') } : null,
    ),
    equipment: EMPTY_EQUIPMENT,
    coins: 137,
  },
  {
    type: ServerMessageType.VendorState,
    vendorId: 'vendor.quartermaster',
    name: 'Quartermaster',
    stock: [
      { defId: 'potion.minor', price: 9 },
      { defId: 'sword.worn', price: 18 },
    ],
    buyback: [{ defId: 'chest.leather', count: 1, price: 8 }],
  },
  // A shop with nothing in it, and the empty id that means "closed".
  { type: ServerMessageType.VendorState, vendorId: '', name: '', stock: [], buyback: [] },
  { type: ServerMessageType.Pong, nonce: 88, serverTick: 1000, inputQueueFloor: 4 },
  // Both halves again (spec 246): the body being talked to, and the 0 that is
  // both a refusal and the end of a conversation.
  { type: ServerMessageType.Conversation, entityId: 4242 },
  { type: ServerMessageType.Conversation, entityId: 0 },
  { type: ServerMessageType.Error, code: 7, message: 'rejected' },
  { type: ServerMessageType.Disconnect, reason: 'kicked' },

  // --- added for spec 258, closing the gap the fingerprint exists to find ---

  { type: ServerMessageType.CastRejected, abilityId: 'skill.whirlwind', reason: 'on cooldown' },
  {
    // A small document, in the shape of map-messages.test.ts's own fixtures --
    // not the shipped map, which is read off disk by a module the deterministic
    // core may not import. Two layers, so both a real water level and the null
    // that means "no water on this layer" cross the wire at least once, and
    // coordinates that are already thousandths-exact so quantizing them and
    // dividing back is a no-op rather than a rounding coincidence.
    type: ServerMessageType.MapInfo,
    mapId: 'corpus-map',
    seed: 4242,
    cellSize: 2,
    chunkCells: 28,
    arena: { minX: -2000, minZ: -2000, maxX: 2800, maxZ: 2500 },
    species: ['tree', 'campfire'],
    layers: [
      {
        id: 'ground',
        seed: 7,
        // Not the layer's own corner (spec 083's grown-map case): a client
        // that assumed the two were equal would place every streamed chunk a
        // chunk away from where the server put it.
        origin: { x: 120.5, z: -80.25 },
        bounds: { minX: -2000, minZ: -2000, maxX: 2800, maxZ: 2500 },
        baseY: 0,
        waterLevel: 12.5,
        coords: [
          { cx: -4, cz: -7 },
          { cx: 0, cz: 0 },
          { cx: 13, cz: 6 },
        ],
      },
      {
        id: 'rock',
        seed: 9,
        origin: { x: 0, z: 0 },
        bounds: { minX: -500, minZ: -500, maxX: 500, maxZ: 500 },
        baseY: 5,
        waterLevel: null,
        coords: [],
      },
    ],
  },
  {
    // One corner's worth of a chunk (cols=1, rows=1, so four corner heights),
    // with both props that carry no light and a fixture's own brightness and
    // reach (spec 250) -- and both the `align` and `uniform` flag bits, so
    // every bit `MapPropFlag` defines is exercised at least once.
    type: ServerMessageType.MapChunk,
    mapId: 'corpus-map',
    layer: 0,
    chunk: {
      cx: -3,
      cz: -11,
      cols: 1,
      rows: 1,
      heights: [0, 1.5, -0.5, 2],
      solid: [1, 1],
      materials: [2, 1],
      tones: [0, 1],
      props: [
        { species: 'tree', x: 10, z: 20, rotation: 0.5, scale: 1, tint: 0.25, align: true },
        {
          species: 'campfire',
          x: 30,
          z: 40,
          rotation: 0,
          scale: 2,
          tint: 0.5,
          uniform: true,
          light: { brightness: 1.25, radius: 250 },
        },
      ],
      markers: [
        { kind: 'spawn', id: 'spawn-1', x: 5, z: 5 },
        { kind: 'spawner', id: 'spawner-1', x: 15, z: 25, label: 'grazer' },
      ],
    },
  },
  {
    type: ServerMessageType.ChunkDenied,
    layer: 0,
    cx: -3,
    cz: 7,
    reason: ChunkDeniedReason.OutOfRange,
  },
  {
    type: ServerMessageType.SpawnerStates,
    tick: 1800,
    spawners: [
      // Both states a spawner can be in (spec 076): occupied, with no timer
      // to report, and counting down toward the next one.
      { id: 'spawner-1', monsterId: 'grazer', x: 120.5, y: -30.25, state: SpawnerStateValue.Waiting, ticks: 240 },
      { id: 'spawner-2', monsterId: 'ravager', x: -40, y: 15, state: SpawnerStateValue.Occupied, ticks: 0 },
    ],
  },
  {
    type: ServerMessageType.TradeState,
    tradeId: 12,
    stage: TradeStageValue.Open,
    revision: 3,
    you: {
      playerId: 'alice',
      displayName: 'Alice',
      offer: [{ defId: 'sword.worn', count: 1 }],
      coins: 25,
      accepted: false,
    },
    // The other side's offer is empty, so the codec has to carry a trade side
    // with nothing on the table as well as one with something on it.
    them: {
      playerId: 'bob',
      displayName: 'Bob',
      offer: [],
      coins: 0,
      accepted: true,
    },
    reason: '',
    invited: true,
    warning: 'their bag is full',
  },
  {
    // Revealed: the identity is on the wire.
    type: ServerMessageType.LootDrop,
    entityId: 555,
    rarity: 2,
    spawnTick: 100,
    revealTick: 160,
    originX: 12.5,
    originY: -6.25,
    originZ: 3,
    defId: 'potion.minor',
    count: 1,
  },
  {
    // Not revealed yet: `defId` empty and `count` zero is the wire form of
    // "nobody has been told what this is", not a flag beside a real value.
    type: ServerMessageType.LootDrop,
    entityId: 556,
    rarity: 3,
    spawnTick: 200,
    revealTick: 260,
    originX: 0,
    originY: 0,
    originZ: 0,
    defId: '',
    count: 0,
  },
  {
    type: ServerMessageType.Restoration,
    // Written as the same division `decodeServerMessage` reconstructs from a
    // quantized byte, so the round trip is exact rather than close: 102/255
    // and `reader.u8() / 255` are the same expression on the same operands.
    meter: 102 / 255,
    charges: 2,
    maxCharges: 3,
    atTick: 500,
  },
];
