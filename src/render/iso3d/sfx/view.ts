/**
 * The SFX tab (spec 229): which files a game event is made of.
 *
 * A tree down the left, one event's editor on the right, and a Save that writes
 * `assets/audio/sfx.json`. Hand-rolled DOM, which is the idiom `studio/view.ts`
 * and `studio/vfx-view.ts` already use for a *form*; `lil-gui` is the other one
 * in this repo and is right for a wall of sliders over a viewport (the editor,
 * the sandboxes) and wrong here, because half of this tab is an ordered list
 * with per-row buttons and lil-gui has no row of that shape.
 *
 * Every decision -- what the tree is, what a filter matches, what an edit does
 * to the document -- lives in `model.ts` where a test can reach it. This file is
 * elements and event listeners.
 *
 * ## Why it edits a document rather than the running game
 *
 * The tab holds its own copy of the catalog, and Save posts it to
 * `POST /api/sfx`, which writes the file the game boots from. It deliberately
 * does **not** push edits into a live `AudioEngine` in the Play tab: they are
 * two tabs and two mounts, and the Play tab reads the catalog once at mount.
 * Reload the Play tab to hear a change -- said out loud in the status line
 * rather than left to be discovered.
 *
 * What it *does* have is its own engine, so Preview and Play event are the real
 * decode and the real variant-and-pitch draw rather than an approximation of
 * them. Tuning against something that flatters is the failure `studio/preview.ts`
 * names: it moves numbers in the wrong direction and does it convincingly.
 *
 * ## The write is dev-only and says so
 *
 * `POST /api/sfx` is a vite plugin with `apply: 'serve'`, exactly like
 * `POST /api/map` (spec 177). A built page has no such endpoint, so Save there
 * falls back to a download -- and the four outcomes are told apart, because
 * "there is no dev server here", "the server said no" and "nothing answered"
 * have three different fixes and one message for all three names none of them.
 */

import { createAudioEngine } from '../../audio/engine.js';
import {
  catalogToJson,
  parseCatalog,
  SOUND_DEFAULTS,
  SOUND_LIMITS,
  type SoundCatalog,
} from '../../audio/catalog.js';
import { BUS_LABELS, soundEvent, type SoundEventId } from '../../audio/events.js';
import { AUDIO_DEFAULTS } from '../../audio/mix.js';
import type { ViewHandle } from '../view-handle.js';
import {
  addVariant,
  clipFolder,
  clipLabel,
  coverage,
  editing,
  moveVariant,
  parseClips,
  removeVariant,
  setCooldown,
  setDistance,
  setPitch,
  setSpatial,
  setVolume,
  tree,
  unusedClips,
  type ClipEntry,
} from './model.js';

import catalogUrl from '../../../../assets/audio/sfx.json?url';

const MONO = "'Courier New',ui-monospace,monospace";
const PANEL = 'background:#16161e;border:1px solid #2a2a3a;padding:10px;box-sizing:border-box;';
const MUTED = 'color:#7a7a90;';
const BUTTON =
  `font-family:${MONO};font-size:11px;padding:3px 8px;cursor:pointer;` +
  'background:#24243a;color:#c8c8d8;border:1px solid #3a3a52;';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, onPress: () => void, title = ''): HTMLButtonElement {
  const node = el('button', BUTTON, label);
  if (title) node.title = title;
  node.addEventListener('click', onPress);
  return node;
}

/** A labelled number field. A row rather than a slider: these are *values*, and typing 0.85 beats hunting for it. */
function field(
  label: string,
  value: number,
  limits: { readonly min: number; readonly max: number },
  step: number,
  onChange: (next: number) => void,
): HTMLElement {
  const row = el('label', 'display:flex;align-items:center;gap:8px;margin:3px 0;');
  row.append(el('span', 'width:104px;flex:none;', label));
  const input = el('input', `font-family:${MONO};font-size:11px;width:72px;background:#0e0e16;color:#c8c8d8;border:1px solid #3a3a52;padding:2px 4px;`);
  input.type = 'number';
  input.min = String(limits.min);
  input.max = String(limits.max);
  input.step = String(step);
  input.value = String(round(value));
  const commit = (): void => {
    const parsed = Number.parseFloat(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = String(round(value));
      return;
    }
    const clamped = Math.min(limits.max, Math.max(limits.min, parsed));
    input.value = String(round(clamped));
    onChange(clamped);
  };
  input.addEventListener('change', commit);
  row.append(input);
  return row;
}

/** Three decimals, without a trailing `.000` on a whole number. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Whether Save can reach a dev server. Four outcomes, per the header. */
type SaveOutcome = 'saved' | 'refused' | 'no-endpoint' | 'unreachable';

async function postCatalog(text: string): Promise<{ readonly outcome: SaveOutcome; readonly detail: string }> {
  let response: Response;
  try {
    response = await fetch('/api/sfx', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    });
  } catch (error) {
    // Nothing answered at all: no server on this origin, or it died.
    return { outcome: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
  }
  // A built page served statically answers the SPA's own index for an unknown
  // path, or a 404. Either way there is no endpoint, and telling somebody "the
  // server said no" would send them looking for a rule that does not exist.
  if (response.status === 404 || response.status === 405) {
    return { outcome: 'no-endpoint', detail: 'no dev server here -- use Download' };
  }
  const detail = await response.text();
  return { outcome: response.ok ? 'saved' : 'refused', detail };
}

export function mountSfx(container: HTMLElement): ViewHandle {
  const root = el(
    'div',
    `font-family:${MONO};color:#c8c8d8;font-size:12px;box-sizing:border-box;height:100vh;overflow:hidden;`,
  );
  // Named so a probe can find *this* tab's elements. Every tab that has ever
  // been opened stays in the DOM behind `display:none`, so a bare
  // `document.querySelector` finds the Play tab's hidden one and measures a
  // zero-sized rectangle -- the trap `vfx-view.ts` records falling into.
  root.id = 'sfx-tab';
  // The root owns only the box, and an inner element does the layout: `main.ts`
  // writes `element.style.display = 'block'` on a tab's root every time it is
  // activated, so a root laying itself out with flex has its flex clobbered on
  // the first click. Same split, same reason, as the VFX tab.
  const layout = el('div', 'display:flex;gap:10px;height:100%;min-height:0;padding:44px 16px 16px;box-sizing:border-box;');
  root.append(layout);

  const left = el('div', `${PANEL}width:320px;flex:none;display:flex;flex-direction:column;gap:8px;min-height:0;`);
  const right = el('div', `${PANEL}flex:1;min-width:0;overflow:auto;`);
  layout.append(left, right);

  // --- state ---------------------------------------------------------------
  let catalog: SoundCatalog = new Map();
  let clips: readonly ClipEntry[] = [];
  let selected: SoundEventId | null = null;
  let filter = '';
  let dirty = false;

  /**
   * The tab's own engine.
   *
   * Its own, not the Play tab's: they are two mounts and there is no shared
   * instance -- the same caveat `studio/preview.ts` records about the control
   * panel. Its mix is the defaults with the master at full, because this is the
   * tool you tune *in* and a player's own master turned down would silently make
   * every judgement here wrong.
   */
  const engine = createAudioEngine({ mix: { ...AUDIO_DEFAULTS, master: 1, muted: false } });

  // --- header --------------------------------------------------------------
  const title = el('div', 'font-size:14px;letter-spacing:.08em;', 'SFX');
  const cover = el('div', `${MUTED}font-size:11px;`);
  const status = el('div', 'font-size:11px;min-height:14px;');
  const search = el('input', `font-family:${MONO};font-size:11px;background:#0e0e16;color:#c8c8d8;border:1px solid #3a3a52;padding:4px 6px;`);
  search.placeholder = 'filter events...';
  search.addEventListener('input', () => {
    filter = search.value;
    drawTree();
  });

  const saveButton = button('Save to assets/', () => {
    void save();
  }, 'Writes assets/audio/sfx.json through the dev server.');
  const downloadButton = button('Download', () => {
    const blob = new Blob([catalogToJson(catalog)], { type: 'application/json' });
    const link = el('a', 'display:none');
    link.href = URL.createObjectURL(blob);
    link.download = 'sfx.json';
    root.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }, 'The fallback where there is no dev server.');
  const bar = el('div', 'display:flex;gap:6px;');
  bar.append(saveButton, downloadButton);
  left.append(title, cover, search, bar, status);

  const treeBox = el('div', 'flex:1;overflow:auto;min-height:0;');
  left.append(treeBox);

  // --- the tree ------------------------------------------------------------
  function drawTree(): void {
    treeBox.replaceChildren();
    for (const section of tree(catalog, filter)) {
      const heading = el(
        'div',
        `${MUTED}font-size:10px;letter-spacing:.1em;margin:8px 0 3px;`,
        `${BUS_LABELS[section.bus].toUpperCase()} / ${section.section.toUpperCase()}`,
      );
      treeBox.append(heading);
      for (const row of section.rows) {
        const on = row.event.id === selected;
        const line = el(
          'div',
          'display:flex;justify-content:space-between;gap:8px;padding:2px 5px;cursor:pointer;' +
            (on ? 'background:#2e2e46;color:#f0f0f8;' : ''),
        );
        line.dataset['sfxRow'] = row.event.id;
        line.append(el('span', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', row.event.label));
        // A count, and a dash for none. The dash rather than a `0` because the
        // question the tree answers at a glance is "what is still silent", and
        // a column of zeroes reads as a column of numbers.
        line.append(
          el(
            'span',
            `flex:none;${row.variants === 0 ? 'color:#6a5a4a;' : MUTED}`,
            row.variants === 0 ? '--' : String(row.variants),
          ),
        );
        line.addEventListener('click', () => {
          selected = row.event.id;
          drawTree();
          drawEditor();
        });
        treeBox.append(line);
      }
    }
    const seen = coverage(catalog);
    cover.textContent = `${String(seen.assigned)}/${String(seen.total)} events have a sound - ${String(unusedClips(catalog, clips).length)} clips unused`;
    saveButton.textContent = dirty ? 'Save to assets/ *' : 'Save to assets/';
  }

  // --- the editor ----------------------------------------------------------
  function drawEditor(): void {
    right.replaceChildren();
    if (selected === null) {
      right.append(el('div', MUTED, 'Pick an event on the left.'));
      return;
    }
    const id = selected;
    const event = soundEvent(id);
    if (!event) return;
    const sound = editing(id, catalog);

    right.append(el('div', 'font-size:16px;', event.label));
    right.append(el('div', `${MUTED}font-size:11px;margin-bottom:2px;`, id));
    right.append(
      el(
        'div',
        `${MUTED}font-size:11px;margin-bottom:2px;`,
        `bus: ${BUS_LABELS[event.bus]}${event.loop === true ? '  -  looping' : ''}`,
      ),
    );
    // What fires it, because "when do I hear this" is the first question anybody
    // has about a row and the answer is not in its name.
    right.append(el('div', `${MUTED}font-size:11px;margin-bottom:10px;max-width:60ch;`, event.note));

    // --- variants ---
    right.append(el('div', 'font-size:12px;margin-bottom:4px;', 'Variants'));
    if (sound.variants.length === 0) {
      right.append(el('div', `${MUTED}font-size:11px;margin-bottom:6px;`, 'None. This event is silent.'));
    }
    sound.variants.forEach((url, index) => {
      const row = el('div', 'display:flex;align-items:center;gap:5px;margin:2px 0;');
      row.append(el('span', 'width:22px;flex:none;color:#6a6a80;', String(index + 1)));
      row.append(
        el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', url.slice('/audio/'.length)),
      );
      row.append(
        button('>', () => {
          engine.preview(url, sound.volume);
        }, 'Preview this file, at this row’s volume and no pitch draw.'),
      );
      row.append(
        button('^', () => {
          catalog = moveVariant(catalog, id, index, -1);
          mark();
        }),
      );
      row.append(
        button('v', () => {
          catalog = moveVariant(catalog, id, index, 1);
          mark();
        }),
      );
      row.append(
        button('x', () => {
          catalog = removeVariant(catalog, id, index);
          mark();
        }, 'Remove. Taking the last one deletes the row.'),
      );
      right.append(row);
    });

    // --- the picker ---
    const picker = el('select', `font-family:${MONO};font-size:11px;background:#0e0e16;color:#c8c8d8;border:1px solid #3a3a52;padding:3px;max-width:100%;`);
    const groups = new Map<string, HTMLOptGroupElement>();
    picker.append(el('option', '', '-- add a file --'));
    for (const clip of clips) {
      const folder = clipFolder(clip.url);
      let group = groups.get(folder);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = folder;
        groups.set(folder, group);
        picker.append(group);
      }
      const option = el('option', '', `${clipLabel(clip.url)}  (${clip.seconds.toFixed(2)}s)`);
      option.value = clip.url;
      group.append(option);
    }
    picker.addEventListener('change', () => {
      if (picker.value === '') return;
      catalog = addVariant(catalog, id, picker.value);
      picker.value = '';
      mark();
    });
    const addRow = el('div', 'display:flex;gap:6px;align-items:center;margin:8px 0 14px;');
    addRow.append(picker);
    addRow.append(
      button('Play event', () => {
        // Through the real catalog rather than the file: what this plays is a
        // drawn variant at a drawn rate, which is the thing being tuned.
        engine.setCatalog(catalog);
        engine.play(id);
      }, 'Plays through the catalog: a real variant draw at a real pitch draw.'),
    );
    right.append(addRow);

    // --- tuning ---
    right.append(el('div', 'font-size:12px;margin-bottom:4px;', 'Tuning'));
    right.append(
      field('volume', sound.volume, SOUND_LIMITS.volume, 0.05, (value) => {
        catalog = setVolume(catalog, id, value);
        mark(false);
      }),
    );
    right.append(
      field('pitch min', sound.pitch.min, SOUND_LIMITS.pitch, 0.01, (value) => {
        catalog = setPitch(catalog, id, { min: value, max: Math.max(value, sound.pitch.max) });
        mark();
      }),
    );
    right.append(
      field('pitch max', sound.pitch.max, SOUND_LIMITS.pitch, 0.01, (value) => {
        catalog = setPitch(catalog, id, { min: Math.min(value, sound.pitch.min), max: value });
        mark();
      }),
    );
    right.append(
      field('cooldown ms', sound.cooldownMs, SOUND_LIMITS.cooldownMs, 5, (value) => {
        catalog = setCooldown(catalog, id, value);
        mark(false);
      }),
    );
    right.append(
      el(
        'div',
        `${MUTED}font-size:10px;margin:2px 0 10px;max-width:60ch;`,
        `default pitch ${String(SOUND_DEFAULTS.pitch.min)}-${String(SOUND_DEFAULTS.pitch.max)}; ` +
          'cooldown is how long before this event may fire again -- it exists because one Whirlwind tick lands on every body in the arc.',
      ),
    );

    // --- placement ---
    right.append(el('div', 'font-size:12px;margin-bottom:4px;', 'Placement'));
    const spatialRow = el('label', 'display:flex;align-items:center;gap:8px;margin:3px 0;');
    const spatialBox = el('input', '');
    spatialBox.type = 'checkbox';
    spatialBox.checked = sound.spatial;
    spatialBox.addEventListener('change', () => {
      catalog = setSpatial(catalog, id, spatialBox.checked, event.placement === 'world');
      mark();
    });
    spatialRow.append(spatialBox, el('span', '', 'spatial (placed in the world and panned)'));
    right.append(spatialRow);

    const falloff = el('div', sound.spatial ? '' : 'opacity:.4;pointer-events:none;');
    falloff.append(
      field('full within', sound.distance.ref, SOUND_LIMITS.ref, 10, (value) => {
        catalog = setDistance(catalog, id, 'ref', value);
        mark(false);
      }),
    );
    falloff.append(
      field('silent past', sound.distance.max, SOUND_LIMITS.max, 50, (value) => {
        catalog = setDistance(catalog, id, 'max', value);
        mark(false);
      }),
    );
    falloff.append(
      field('rolloff', sound.distance.rolloff, SOUND_LIMITS.rolloff, 0.1, (value) => {
        catalog = setDistance(catalog, id, 'rolloff', value);
        mark(false);
      }),
    );
    falloff.append(
      el(
        'div',
        `${MUTED}font-size:10px;margin-top:4px;max-width:60ch;`,
        'World units. A body is 16 across, melee reach is 70-90, a bow reaches 420 and nothing past ~1700 is replicated at all. ' +
          '"Silent past" is a cull at the moment a voice would be allocated, not a fade -- so it is exactly the range a designer means.',
      ),
    );
    right.append(falloff);
  }

  /** An edit landed. `redraw` is false where the control being typed into would lose focus. */
  function mark(redraw = true): void {
    dirty = true;
    engine.setCatalog(catalog);
    drawTree();
    if (redraw) drawEditor();
  }

  async function save(): Promise<void> {
    status.style.color = '#9a9ab0';
    status.textContent = 'saving...';
    const result = await postCatalog(catalogToJson(catalog));
    const colours: Record<SaveOutcome, string> = {
      saved: '#7fd18a',
      refused: '#e08a7a',
      'no-endpoint': '#d9c07a',
      unreachable: '#e08a7a',
    };
    status.style.color = colours[result.outcome];
    status.textContent =
      result.outcome === 'saved'
        ? `${result.detail} -- reload the Play tab to hear it`
        : `${result.outcome}: ${result.detail}`;
    if (result.outcome === 'saved') {
      dirty = false;
      drawTree();
    }
  }

  // --- load ----------------------------------------------------------------
  status.textContent = 'loading...';
  void Promise.all([
    fetch(catalogUrl).then((response) => response.text()),
    // The bake's index. A failure here is a picker with nothing in it, which is
    // a tab you can still read -- so it is caught separately from the catalog.
    fetch('/audio/manifest.json')
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null),
  ])
    .then(([text, manifest]) => {
      const parsed = parseCatalog(text);
      if ('error' in parsed) {
        status.style.color = '#e08a7a';
        status.textContent = `sfx.json: ${parsed.error}`;
      } else {
        catalog = parsed.catalog;
        engine.setCatalog(catalog);
        status.textContent = '';
      }
      clips = parseClips(manifest);
      if (clips.length === 0) {
        status.style.color = '#d9c07a';
        status.textContent = 'no /audio/manifest.json -- run `npm run bake:audio`';
      }
      drawTree();
      drawEditor();
    })
    .catch((error: unknown) => {
      status.style.color = '#e08a7a';
      status.textContent = error instanceof Error ? error.message : String(error);
    });

  drawTree();
  drawEditor();
  container.append(root);

  return {
    element: root,
    start(): void {
      // The autoplay unlock, and the only reason this tab listens to anything.
      // A browser refuses to make noise before an interaction, and the first
      // interaction here is a click on the tree.
      root.addEventListener('pointerdown', arm);
    },
    stop(): void {
      root.removeEventListener('pointerdown', arm);
      engine.stopAll();
      engine.suspend();
    },
  };

  function arm(): void {
    engine.resume();
  }
}
