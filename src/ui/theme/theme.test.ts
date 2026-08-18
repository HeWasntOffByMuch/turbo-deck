import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveTheme, THEME, WIDGET_STATES } from './theme.js';
import { PATCHES, PATCH_PALETTE, ICONS, ICON_SIZE } from './atlas-source.js';
import document from './theme.json';

const schema = JSON.parse(readFileSync(new URL('../../../schemas/ui-theme.schema.json', import.meta.url), 'utf8')) as object;

describe('theme.json against its schema', () => {
  it('validates', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const ok = validate(document);
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('refuses a key nobody meant to add', () => {
    // additionalProperties is false throughout, so a typo is an error with a
    // pointer at it rather than a token that silently does nothing.
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const typo = { ...(document as object), palete: {} };
    expect(validate(typo)).toBe(false);
  });

  // Sixteen until spec 176, which added the three rarity tiers. The cap is
  // against invented colour: those three are the world's own, already drawn on
  // every drop in the grass, and importing them is what keeps the bag and the
  // ground from drifting.
  it('keeps the palette to nineteen colours', () => {
    expect(Object.keys(THEME.palette).length).toBeLessThanOrEqual(19);
  });
});

describe('what the schema cannot say', () => {
  it('every spacing step is a whole multiple of the grid unit', () => {
    for (const key of ['xs', 'sm', 'md', 'lg', 'xl'] as const) {
      expect(THEME.spacing[key] % THEME.spacing.unit, key).toBe(0);
    }
  });

  it('rejects a spacing step off the grid, with a message that says which', () => {
    const broken = structuredClone(document) as unknown as Parameters<typeof resolveTheme>[0];
    (broken.spacing as { sm: number }).sm = 7;
    expect(() => resolveTheme(broken)).toThrow(/spacing\.sm is 7.*not a multiple of the 4px grid/);
  });

  it('rejects a palette reference that does not resolve, and names it', () => {
    const broken = structuredClone(document) as unknown as Parameters<typeof resolveTheme>[0];
    const button = broken.widgets['button'];
    if (!button) throw new Error('the theme lost its button style');
    (button.states.normal as { fill: string }).fill = 'chartreuse';
    expect(() => resolveTheme(broken)).toThrow(/chartreuse/);
  });

  it('every widget defines all five states', () => {
    for (const name of Object.keys((document as { widgets: Record<string, unknown> }).widgets)) {
      const style = THEME.widget(name);
      for (const state of WIDGET_STATES) {
        expect(() => style.state(state), `${name}.${state}`).not.toThrow();
      }
    }
  });

  it('every frame a widget names is a patch that exists', () => {
    for (const frame of THEME.framesUsed()) {
      expect(PATCHES[frame], `no patch named ${frame}`).toBeDefined();
    }
  });

  it('throws for an unknown widget rather than returning a default', () => {
    expect(() => THEME.widget('nonesuch')).toThrow(/no widget style named nonesuch/);
  });
});

describe('the atlas source', () => {
  it('only uses characters that name a real palette slot', () => {
    const check = (name: string, rows: readonly string[]): void => {
      for (const row of rows) {
        for (const character of row) {
          if (character === '.') continue;
          const slot = PATCH_PALETTE[character];
          expect(slot, `${name} uses '${character}'`).toBeDefined();
          expect(THEME.palette[slot ?? ''], `${name} -> ${slot}`).toBeDefined();
        }
      }
    };
    for (const [name, patch] of Object.entries(PATCHES)) check(`patch:${name}`, patch.rows);
    for (const [name, rows] of Object.entries(ICONS)) check(`icon:${name}`, rows);
  });

  it('gives every patch square rows and room for two borders plus a middle', () => {
    for (const [name, patch] of Object.entries(PATCHES)) {
      const width = patch.rows[0]?.length ?? 0;
      for (const row of patch.rows) expect(row.length, name).toBe(width);
      expect(width, `${name} width`).toBeGreaterThanOrEqual(patch.border * 2 + 1);
      expect(patch.rows.length, `${name} height`).toBeGreaterThanOrEqual(patch.border * 2 + 1);
    }
  });

  it('keeps every frame hollow, so the fill is a separate draw', () => {
    // One patch per shape rather than one per state is what keeps the atlas
    // small; it only works because the middle is transparent.
    for (const [name, patch] of Object.entries(PATCHES)) {
      const middleRow = patch.rows[patch.border];
      expect(middleRow?.[patch.border], `${name} centre should be transparent`).toBe('.');
    }
  });

  it('gives every icon the declared square size', () => {
    for (const [name, rows] of Object.entries(ICONS)) {
      expect(rows.length, name).toBe(ICON_SIZE);
      for (const row of rows) expect(row.length, name).toBe(ICON_SIZE);
    }
  });
});
