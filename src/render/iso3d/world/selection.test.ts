import { describe, expect, it } from 'vitest';
import type { ReplicatedEntity } from '../../../server/client/replica.js';
import type { WireStatus } from '../../../server/net/messages.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { visualFor } from '../../../server/data/status-visuals.js';
import { StatusId } from '../../../server/sim/statuses.js';
import { statusMarks } from './status-marks.js';
import { formatRemaining, selectableKind, selectionOf } from './selection.js';

function wireOf(id: string): number {
  const visual = visualFor(id);
  if (!visual) throw new Error(`no visible row for ${id}`);
  return visual.wire;
}

function status(id: string, expiresAtTick: number, stacks = 1): WireStatus {
  return { wire: wireOf(id), stacks, expiresAtTick };
}

function entity(overrides: Partial<ReplicatedEntity> = {}): ReplicatedEntity {
  return {
    id: 7,
    kind: EntityKind.Monster,
    typeId: 'grazer',
    x: 0,
    y: 0,
    z: 0,
    facing: 0,
    health: 60,
    maxHealth: 120,
    activity: 0,
    activityUntilTick: 0,
    level: 3,
    name: '',
    turnRate: 4,
    poise: 1,
    shield: 0,
    shieldUntilTick: 0,
    statuses: [],
    moveScale: 1,
    ...overrides,
  };
}

describe('selectionOf (spec 196)', () => {
  it('says nothing when nothing is selected', () => {
    expect(selectionOf({ selectedId: null, entities: [entity()], drawnTick: 0 })).toBeNull();
  });

  it('names the body and its level off the content table', () => {
    const view = selectionOf({ selectedId: 7, entities: [entity()], drawnTick: 0 });
    expect(view?.name).toBe('Grazer');
    // A grazer's name is already its kind, so its level stands alone.
    expect(view?.detail).toBe('Lv 3');
    expect(view?.health).toEqual({ current: 60, max: 120 });
    expect(view?.dead).toBe(false);
  });

  it("says what a player is, because their name does not", () => {
    const view = selectionOf({
      selectedId: 7,
      entities: [entity({ kind: EntityKind.Player, name: 'Bex', level: 12 })],
      drawnTick: 0,
    });
    expect(view?.name).toBe('Bex');
    expect(view?.detail).toBe('Lv 12 Player');
  });

  it('drops a selection whose body has left the replicated set', () => {
    // The caller clears its id off this null. Entity ids are reused, so a
    // selection that outlived its body would come back pointing at a stranger.
    expect(selectionOf({ selectedId: 7, entities: [], drawnTick: 0 })).toBeNull();
  });

  it('refuses anything that is not a body', () => {
    for (const kind of [EntityKind.Prop, EntityKind.Projectile, EntityKind.Drop]) {
      expect(selectableKind(kind)).toBe(false);
      expect(selectionOf({ selectedId: 7, entities: [entity({ kind })], drawnTick: 0 })).toBeNull();
    }
    expect(selectableKind(EntityKind.Player)).toBe(true);
    expect(selectableKind(EntityKind.Monster)).toBe(true);
  });

  it('says a body is dead rather than drawing it an empty bar', () => {
    const view = selectionOf({ selectedId: 7, entities: [entity({ health: 0 })], drawnTick: 0 });
    expect(view?.dead).toBe(true);
    expect(view?.health.current).toBe(0);
  });

  it('lists the same statuses the mark over the head lists, in the same order', () => {
    // The whole reason this module exists rather than four lines in `view.ts`:
    // the panel and the body are two views of one list, so a status expiring is
    // one answer and not two.
    const held = [
      status(StatusId.Sundered, 300),
      status(StatusId.Flow, 300, 2),
      status(StatusId.Exposed, 300),
    ];
    const view = selectionOf({ selectedId: 7, entities: [entity({ statuses: held })], drawnTick: 60 });
    expect(view?.statuses.map((row) => row.id)).toEqual(
      statusMarks(held, 60).map((mark) => mark.id),
    );
  });

  it('refuses a window that has already passed, exactly as the mark does', () => {
    const held = [status(StatusId.Exposed, 100)];
    expect(
      selectionOf({ selectedId: 7, entities: [entity({ statuses: held })], drawnTick: 100 })?.statuses,
    ).toEqual([]);
  });

  it('puts a stack count in the label and leaves it off a row that cannot stack', () => {
    const view = selectionOf({
      selectedId: 7,
      entities: [entity({ statuses: [status(StatusId.Flow, 300, 3), status(StatusId.Exposed, 300)] })],
      drawnTick: 0,
    });
    const labels = view?.statuses.map((row) => row.label) ?? [];
    expect(labels).toContain('Flow x3');
    expect(labels).toContain('Exposed');
  });

  it('colours a boon and an affliction differently, and dims one about to go', () => {
    const view = selectionOf({
      selectedId: 7,
      entities: [entity({ statuses: [status(StatusId.Flow, 300), status(StatusId.Exposed, 64)] })],
      drawnTick: 60,
    });
    const rows = view?.statuses ?? [];
    expect(rows.find((row) => row.id === StatusId.Flow)?.tone).toBe('boon');
    expect(rows.find((row) => row.id === StatusId.Flow)?.fading).toBe(false);
    expect(rows.find((row) => row.id === StatusId.Exposed)?.tone).toBe('affliction');
    // Four ticks left, inside the same eight-tick window the glyph thins across.
    expect(rows.find((row) => row.id === StatusId.Exposed)?.fading).toBe(true);
  });
});

describe('formatRemaining (spec 196)', () => {
  it('is a tenth under ten seconds and a whole number above', () => {
    expect(formatRemaining(60)).toBe('1.0s');
    expect(formatRemaining(90)).toBe('1.5s');
    expect(formatRemaining(600)).toBe('10s');
    expect(formatRemaining(725)).toBe('13s');
  });

  it('never reads zero while there is any time left', () => {
    // A row saying `0.0s` while the sim is still honouring the status is the one
    // number here that would be a lie, so the seconds round up.
    expect(formatRemaining(1)).toBe('0.1s');
    expect(formatRemaining(0)).toBe('');
  });
});
