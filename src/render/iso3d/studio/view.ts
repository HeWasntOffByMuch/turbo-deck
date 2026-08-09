/**
 * The Studio tab (spec 109).
 *
 * A fifth entry in the tab shell's array and nothing else: the shell mounts a
 * view, starts it when shown and stops it when hidden, so Play and Map editor
 * cannot be disturbed by anything in this file.
 *
 * Not `fullscreen`. Play and the map editor own the window because they *are* a
 * window onto the world; this is a form, and a form wants the shell's ordinary
 * scrolling layout underneath the tab bar.
 *
 * The one thing the layout insists on is the order of the confirmation. The
 * projected cost is rendered, and only then does a button appear that can spend
 * it -- there is no path through this file where a generation starts without a
 * price having been drawn on screen first.
 */

import type { ViewHandle } from '../view-handle.js';
import { StudioApi, StudioApiError, type EstimateResult, type JobView, type StudioConfigView } from './api.js';
import { formatBytes, formatCredits, formatDuration, formatTimestamp, STAGE_LABELS, STATUS_COLORS, STATUS_LABELS } from './format.js';
import { checkImage, MANUAL_CHECKS, measureImage, worstSeverity, type ImageFinding } from './image-check.js';
import { CLIP_INTENTS, defaultClipIntents, establishesRigFamily, unitIdProblem } from './plan.js';
import { mountPreview, type PreviewHandle } from './preview-panel.js';
import mannequinUrl from '../../../../assets/units/dev/mannequin.glb?url';
import idleUrl from '../../../../assets/units/dev/clips/idle.glb?url';
import walkUrl from '../../../../assets/units/dev/clips/walk.glb?url';
import runUrl from '../../../../assets/units/dev/clips/run.glb?url';
import attackUrl from '../../../../assets/units/dev/clips/attack.glb?url';
import devUnitDef from '../../../../assets/units/dev/mannequin.unitdef.json' with { type: 'json' };
import devClipLib from '../../../../assets/units/dev/biped-dev.core.cliplib.json' with { type: 'json' };
import type { ClipLib, UnitDef } from '../../../units/types.js';

/** How often the queue is re-read while the tab is open. */
const POLL_MS = 2000;

const MONO = "'Courier New',ui-monospace,monospace";

interface PendingImage {
  readonly name: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly findings: readonly ImageFinding[];
  readonly previewUrl: string;
  sha256: string | null;
  uploadError: string | null;
  unitId: string;
  skeletonId: string;
  faceLimit: number;
  clipIntents: string[];
  estimate: EstimateResult | null;
  busy: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text) node.textContent = text;
  return node;
}

const CARD =
  'background:rgba(16,16,24,.9);border:2px solid #3a3a4e;box-shadow:3px 3px 0 rgba(0,0,0,.5);' +
  'padding:14px 16px;margin:0 0 14px;';
const H2 = `font-family:${MONO};font-size:13px;letter-spacing:.08em;color:#f0f0f8;margin:0 0 10px;text-transform:uppercase;`;
const BODY = `font-family:${MONO};font-size:12px;color:#c8c8d8;line-height:1.55;`;
const MUTED = `font-family:${MONO};font-size:11px;color:#8a8aa0;line-height:1.5;`;
const INPUT =
  `font-family:${MONO};font-size:12px;background:#0d0d14;color:#e8e8f4;border:1px solid #4a4a5e;` +
  'padding:5px 7px;min-width:0;';

function button(label: string, kind: 'primary' | 'plain' | 'danger' = 'plain'): HTMLButtonElement {
  const colors =
    kind === 'primary'
      ? 'background:#2f5d3a;color:#dff5e3;border-color:#4b8a5e;'
      : kind === 'danger'
        ? 'background:#5d2f34;color:#f5dfe1;border-color:#8a4b52;'
        : 'background:#2a2a38;color:#c8c8d8;border-color:#4a4a5e;';
  const node = el('button');
  node.textContent = label;
  node.style.cssText =
    `font-family:${MONO};font-size:12px;letter-spacing:.05em;padding:6px 12px;cursor:pointer;` +
    `border:2px solid;box-shadow:2px 2px 0 rgba(0,0,0,.55);${colors}`;
  return node;
}

function section(title: string, subtitle = ''): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', CARD);
  root.appendChild(el('h2', H2, title));
  if (subtitle) root.appendChild(el('p', `${MUTED}margin:-6px 0 10px;`, subtitle));
  const body = el('div', BODY);
  root.appendChild(body);
  return { root, body };
}

const SEVERITY_COLOR = { blocker: '#e06c75', warning: '#e5c07b', note: '#8a8aa0' } as const;

/** Decodes an image far enough to measure it. Returns null for anything undecodable. */
async function decode(file: File): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return { width: image.width, height: image.height, data: image.data };
  } catch {
    return null;
  }
}

export function mountStudio(container: HTMLElement): ViewHandle {
  const api = new StudioApi();
  const root = el('div', 'max-width:1100px;margin:0 auto;');
  container.appendChild(root);

  const pending: PendingImage[] = [];
  let jobs: readonly JobView[] = [];
  let config: StudioConfigView | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let banner: { text: string; remedy: string } | null = null;

  // --- header ---------------------------------------------------------------
  const header = el('div', CARD);
  header.appendChild(el('h2', H2, 'Studio · unit authoring'));
  const bannerBox = el('div', `${BODY}margin-bottom:10px;`);
  const tokenRow = el('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;');
  const tokenInput = el('input', `${INPUT}flex:1;min-width:280px;`) as HTMLInputElement;
  tokenInput.type = 'password';
  tokenInput.placeholder = 'admin token (printed by `npm run server` at boot)';
  tokenInput.value = '';
  const tokenSave = button('Connect', 'primary');
  tokenRow.append(el('span', MUTED, 'admin token'), tokenInput, tokenSave);
  const statusLine = el('div', `${MUTED}margin-top:8px;`);
  header.append(bannerBox, tokenRow, statusLine);
  root.appendChild(header);

  // --- sections -------------------------------------------------------------
  const ingest = section('1 · Ingest', 'Drop reference images. Everything measurable is checked here; the rest is a list to check yourself.');
  const generate = section('2 · Generate', 'The projected cost is shown before anything can be confirmed. rig-check is free and always runs.');
  const library = section('3 · Library', 'What has been generated, what it cost, and where the files are.');
  const preview = section('4 · Preview', 'The turntable, clip player, state machine graph and timing bars. Spec 110.');
  const exporter = section('5 · Export', 'Stages a finished job into assets/units/ and validates what it wrote.');
  root.append(ingest.root, generate.root, library.root, preview.root, exporter.root);

  /**
   * The reference unit (spec 110), bundled so the preview works from a fresh
   * clone with no server and nothing generated. `?url` rather than inlined:
   * a skinned mesh in the main bundle would be paid for by every session,
   * including the ones that never open this tab.
   */
  let previewHandle: PreviewHandle | null = null;
  const previewMount = el('div');
  preview.body.append(
    el(
      'p',
      MUTED,
      'The reference unit (assets/units/dev/) -- a real skinned biped on the mixamo contract, so this screen works before anything has been generated. Rendered through the game\'s own retro pass and its cog; edits write back to the JSON on disk.',
    ),
    previewMount,
  );

  function startPreview(): void {
    if (previewHandle) return;
    previewHandle = mountPreview(
      {
        unitPath: 'dev/mannequin.unitdef.json',
        clipLibPath: 'dev/biped-dev.core.cliplib.json',
        unit: devUnitDef as unknown as UnitDef,
        clipLib: devClipLib as unknown as ClipLib,
        assets: {
          meshUrl: mannequinUrl,
          clipUrls: { idle: idleUrl, walk: walkUrl, run: runUrl, attack: attackUrl },
          importScale: (devUnitDef as unknown as UnitDef).import.scale,
        },
      },
      // Writes go through the server when one is reachable, and say so plainly
      // when it is not -- an edit that silently lived in the tab would be the
      // hidden state this whole road exists to avoid.
      async (path, doc) => {
        try {
          const result = await api.saveDocument(path, doc);
          return result.ok
            ? `saved assets/units/${result.path}`
            : `refused: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`;
        } catch (cause) {
          return cause instanceof StudioApiError ? `not saved -- ${cause.remedy}` : `not saved -- ${String(cause)}`;
        }
      },
    );
    previewMount.appendChild(previewHandle.element);
    previewHandle.start();
  }

  // --- ingest ---------------------------------------------------------------
  const drop = el(
    'div',
    'border:2px dashed #4a4a5e;padding:26px;text-align:center;cursor:pointer;' +
      `${BODY}background:rgba(10,10,16,.6);margin-bottom:12px;`,
    'Drop reference images here, or click to choose',
  );
  const filePicker = el('input', 'display:none;') as HTMLInputElement;
  filePicker.type = 'file';
  filePicker.accept = 'image/*';
  filePicker.multiple = true;
  const imageList = el('div');
  const checklist = el('div', `${MUTED}margin-top:12px;border-top:1px solid #2a2a38;padding-top:10px;`);
  checklist.appendChild(el('div', `${MUTED}color:#a8a8c0;margin-bottom:4px;`, 'Check these yourself -- no measurement can:'));
  for (const item of MANUAL_CHECKS) checklist.appendChild(el('div', MUTED, `· ${item}`));
  ingest.body.append(drop, filePicker, imageList, checklist);

  const jobQueue = el('div');
  generate.body.appendChild(jobQueue);
  const libraryList = el('div');
  library.body.appendChild(libraryList);
  const exportList = el('div');
  exporter.body.appendChild(exportList);

  // --- rendering ------------------------------------------------------------

  function renderBanner(): void {
    bannerBox.replaceChildren();
    if (!banner) return;
    const box = el(
      'div',
      `${BODY}border-left:3px solid #e5c07b;background:rgba(60,50,20,.4);padding:8px 10px;`,
    );
    box.appendChild(el('div', `${BODY}color:#e5c07b;`, banner.text));
    if (banner.remedy) box.appendChild(el('div', MUTED, banner.remedy));
    bannerBox.appendChild(box);
  }

  function renderStatus(credits: string): void {
    statusLine.replaceChildren();
    if (!config) {
      statusLine.textContent = api.hasToken ? 'connecting…' : 'not connected';
      return;
    }
    const perRun = config.ceilings.perRun === null ? 'none' : String(config.ceilings.perRun);
    const perDay = config.ceilings.perDay === null ? 'none' : String(config.ceilings.perDay);
    statusLine.textContent =
      `model ${config.modelVersion} · faces ${config.defaultFaceLimit} · ceilings run ${perRun} / day ${perDay} · ${credits}`;
    if (!config.keyConfigured) {
      const warn = el('div', `${BODY}color:#e5c07b;margin-top:6px;`, 'TRIPO_API_KEY is not set on the server. Everything here is read-only until it is.');
      statusLine.appendChild(warn);
    }
  }

  function renderImages(): void {
    imageList.replaceChildren();
    if (pending.length === 0) {
      imageList.appendChild(el('p', MUTED, 'No images yet.'));
      return;
    }

    for (const image of pending) {
      const card = el('div', 'border:1px solid #2f2f40;padding:10px;margin-bottom:10px;display:flex;gap:12px;');
      const thumb = el('img', 'width:120px;height:120px;object-fit:contain;background:#0a0a10;border:1px solid #2a2a38;') as HTMLImageElement;
      thumb.src = image.previewUrl;
      const right = el('div', 'flex:1;min-width:0;');

      const worst = worstSeverity(image.findings);
      right.appendChild(
        el(
          'div',
          `${BODY}color:${worst ? SEVERITY_COLOR[worst] : '#7bc47f'};`,
          `${image.name} · ${image.width}x${image.height} · ${formatBytes(image.bytes)}`,
        ),
      );
      right.appendChild(
        el('div', MUTED, image.sha256 === null ? (image.uploadError ?? 'hashing…') : `sha256 ${image.sha256.slice(0, 16)}…`),
      );
      for (const finding of image.findings) {
        right.appendChild(el('div', `${MUTED}color:${SEVERITY_COLOR[finding.severity]};`, `${finding.severity}: ${finding.message}`));
      }
      if (image.findings.length === 0) {
        right.appendChild(el('div', `${MUTED}color:#7bc47f;`, 'nothing measurable to flag'));
      }

      // --- the per-image form ---
      const form = el('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;');
      const unitInput = el('input', `${INPUT}width:150px;`) as HTMLInputElement;
      unitInput.placeholder = 'unit id';
      unitInput.value = image.unitId;
      unitInput.addEventListener('input', () => {
        image.unitId = unitInput.value.trim();
        image.estimate = null;
        renderImages();
      });

      const familyInput = el('input', `${INPUT}width:110px;`) as HTMLInputElement;
      familyInput.value = image.skeletonId;
      familyInput.addEventListener('input', () => {
        image.skeletonId = familyInput.value.trim();
        image.estimate = null;
        renderImages();
      });

      const faceInput = el('input', `${INPUT}width:90px;`) as HTMLInputElement;
      faceInput.type = 'number';
      faceInput.value = String(image.faceLimit);
      faceInput.addEventListener('input', () => {
        image.faceLimit = Number(faceInput.value) || image.faceLimit;
        image.estimate = null;
      });

      form.append(
        el('span', MUTED, 'unit'),
        unitInput,
        el('span', MUTED, 'family'),
        familyInput,
        el('span', MUTED, 'faces'),
        faceInput,
      );
      right.appendChild(form);

      // --- clip intents ---
      const establishes = establishesRigFamily(jobs, image.skeletonId);
      const clips = el('div', 'display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;');
      if (establishes) {
        for (const intent of CLIP_INTENTS) {
          const label = el('label', `${MUTED}display:flex;gap:4px;align-items:center;cursor:pointer;`);
          const box = el('input') as HTMLInputElement;
          box.type = 'checkbox';
          box.checked = image.clipIntents.includes(intent.id);
          box.addEventListener('change', () => {
            image.clipIntents = box.checked
              ? [...image.clipIntents, intent.id]
              : image.clipIntents.filter((id) => id !== intent.id);
            image.estimate = null;
            renderImages();
          });
          label.append(box, document.createTextNode(intent.label));
          clips.appendChild(label);
        }
      } else {
        // The shared-skeleton rule, made visible rather than merely enforced.
        clips.appendChild(
          el(
            'div',
            `${MUTED}color:#7bc47f;`,
            `"${image.skeletonId}" already has a clip library. This unit reuses it -- no retarget, and nothing to choose.`,
          ),
        );
      }
      right.appendChild(clips);

      // --- estimate / confirm ---
      const actions = el('div', 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;');
      const problem = unitIdProblem(image.unitId, jobs.map((job) => job.unitId));
      const priceBtn = button('Price it');
      priceBtn.disabled = image.sha256 === null || problem !== null || image.busy;
      priceBtn.style.opacity = priceBtn.disabled ? '0.5' : '1';
      priceBtn.addEventListener('click', () => void priceImage(image));
      actions.append(priceBtn);
      if (problem !== null) actions.appendChild(el('span', `${MUTED}color:#e5c07b;`, problem));
      right.appendChild(actions);

      if (image.estimate) {
        right.appendChild(renderEstimate(image, image.estimate, establishes));
      }

      card.append(thumb, right);
      imageList.appendChild(card);
    }
  }

  /**
   * The projection, and only then the button that spends it.
   *
   * Order is the whole point of this function: the total is written into the DOM
   * above the control that acts on it, so there is no arrangement of this UI in
   * which a generation can be confirmed by someone who was not shown a price.
   */
  function renderEstimate(image: PendingImage, estimate: EstimateResult, establishes: boolean): HTMLElement {
    const box = el('div', `${BODY}margin-top:10px;border-left:3px solid #4b8a5e;padding:8px 10px;background:rgba(20,40,26,.35);`);

    if (estimate.cached) {
      box.appendChild(el('div', `${BODY}color:#7bc47f;`, 'Cache hit: this exact image and these parameters have already been generated. Nothing to spend.'));
      if (estimate.job) box.appendChild(el('div', MUTED, `existing job ${estimate.job.id} (${estimate.job.unitId})`));
      return box;
    }

    box.appendChild(el('div', `${BODY}color:#dff5e3;`, `Projected cost: ${formatCredits(estimate.projection.totalCredits)} credits`));
    for (const step of estimate.projection.steps) {
      if (step.calls === 0 && step.credits === 0) continue;
      box.appendChild(
        el('div', MUTED, `  ${STAGE_LABELS[step.stage]} · ${step.calls} call(s) · ${formatCredits(step.credits)}`),
      );
    }
    if (!establishes) {
      box.appendChild(el('div', `${MUTED}color:#7bc47f;`, '  Retarget skipped: the rig family already has its clips.'));
    }
    if (estimate.credits) {
      const headroom = estimate.credits.dayHeadroom;
      box.appendChild(
        el(
          'div',
          MUTED,
          `today ${formatCredits(estimate.credits.today, estimate.credits.unreportedCalls)}` +
            (headroom === null ? '' : ` · ${formatCredits(headroom)} left under the day ceiling`),
        ),
      );
    }

    const confirm = button(`Generate for ${formatCredits(estimate.projection.totalCredits)} credits`, 'primary');
    confirm.disabled = image.busy || config?.keyConfigured !== true;
    confirm.style.opacity = confirm.disabled ? '0.5' : '1';
    confirm.addEventListener('click', () => void confirmImage(image));
    const row = el('div', 'margin-top:8px;');
    row.appendChild(confirm);
    if (estimate.expiresAtMs !== undefined) {
      row.appendChild(el('span', `${MUTED}margin-left:8px;`, 'this quote expires in a few minutes'));
    }
    box.appendChild(row);
    return box;
  }

  function renderJobs(): void {
    jobQueue.replaceChildren();
    const live = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
    const recent = jobs.filter((job) => job.status !== 'queued' && job.status !== 'running').slice(-8).reverse();
    if (jobs.length === 0) {
      jobQueue.appendChild(el('p', MUTED, 'No jobs yet.'));
      return;
    }
    for (const job of [...live, ...recent]) jobQueue.appendChild(renderJob(job));
  }

  function renderJob(job: JobView): HTMLElement {
    const card = el('div', 'border:1px solid #2f2f40;padding:10px;margin-bottom:10px;');
    const head = el('div', 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;');
    head.append(
      el('span', `${BODY}color:${STATUS_COLORS[job.status]};`, `${STATUS_LABELS[job.status]}`),
      el('span', BODY, job.unitId),
      el('span', MUTED, `${job.skeletonId} · ${formatCredits(job.creditsSpent)} credits · ${formatTimestamp(job.createdAtMs)}`),
    );
    if (job.status === 'queued' || job.status === 'running') {
      const cancel = button('Cancel', 'danger');
      cancel.addEventListener('click', () => void run(async () => {
        await api.cancel(job.id);
        await refresh();
      }));
      head.appendChild(cancel);
    }
    card.appendChild(head);

    for (const step of job.steps) {
      const done = step.status === 'done';
      const color =
        step.status === 'failed'
          ? '#e06c75'
          : done
            ? '#7bc47f'
            : step.status === 'running'
              ? '#6fa8dc'
              : step.status === 'skipped'
                ? '#8a8aa0'
                : '#5a5a70';
      const elapsed =
        step.startedAtMs !== null && step.finishedAtMs !== null
          ? ` · ${formatDuration(step.finishedAtMs - step.startedAtMs)}`
          : '';
      const credits = step.creditsConsumed > 0 ? ` · ${formatCredits(step.creditsConsumed)} credits` : '';
      const line = el(
        'div',
        `${MUTED}color:${color};`,
        `  ${done ? '✓' : step.status === 'skipped' ? '–' : step.status === 'failed' ? '✗' : '·'} ${STAGE_LABELS[step.stage]} · ${step.status}${elapsed}${credits}`,
      );
      card.appendChild(line);
      if (step.error) card.appendChild(el('div', `${MUTED}color:#e06c75;padding-left:16px;`, step.error));
    }

    if (job.message) {
      // A blocked job is not a failure, and its message is advice rather than an
      // error -- coloured to match, so the two do not read alike.
      const color = job.status === 'failed' ? '#e06c75' : '#e5c07b';
      card.appendChild(el('div', `${BODY}color:${color};margin-top:6px;`, job.message));
    }
    return card;
  }

  function renderLibrary(): void {
    libraryList.replaceChildren();
    const done = jobs.filter((job) => job.status === 'succeeded');
    if (done.length === 0) {
      libraryList.appendChild(el('p', MUTED, 'Nothing generated yet.'));
      return;
    }
    for (const job of done) {
      const card = el('div', 'border:1px solid #2f2f40;padding:10px;margin-bottom:10px;');
      card.appendChild(el('div', BODY, `${job.unitId}  ·  ${job.skeletonId}${job.establishesRigFamily ? ' (owns the clip library)' : ''}`));
      card.appendChild(
        el(
          'div',
          MUTED,
          `${formatCredits(job.creditsSpent)} credits · ${job.params.modelVersion} · faces ${job.params.faceLimit} · image ${job.referenceImageSha256.slice(0, 16)}…`,
        ),
      );
      const clips = Object.keys(job.artifacts.clipGlbs);
      card.appendChild(el('div', MUTED, clips.length > 0 ? `clips: ${clips.join(', ')}` : 'clips: reuses the family library'));
      for (const [label, path] of [
        ['mesh', job.artifacts.meshGlb],
        ['rigged', job.artifacts.riggedGlb],
      ] as const) {
        if (path) card.appendChild(el('div', MUTED, `${label}: ${path}`));
      }
      // Tri and bone counts need a parsed .glb, which is the preview's job. Said
      // plainly rather than shown as a blank column that looks like zero.
      card.appendChild(el('div', `${MUTED}color:#6a6a80;`, 'tri and bone counts are read off the .glb — spec 110'));
      libraryList.appendChild(card);
    }
  }

  function renderExport(): void {
    exportList.replaceChildren();
    const done = jobs.filter((job) => job.status === 'succeeded');
    if (done.length === 0) {
      exportList.appendChild(el('p', MUTED, 'Nothing to export yet.'));
      return;
    }
    for (const job of done) {
      const row = el('div', 'display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap;');
      const go = button(`Export ${job.unitId}`);
      const result = el('div', `${MUTED}width:100%;`);
      go.addEventListener('click', () => void run(async () => {
        const exported = await api.exportJob(job.id, { skeletonRef: `${job.skeletonId}.skeleton.json` });
        result.replaceChildren();
        result.appendChild(el('div', `${BODY}color:${exported.ok ? '#7bc47f' : '#e5c07b'};`, `assets/units/${job.unitId}/`));
        for (const file of exported.written) result.appendChild(el('div', `${MUTED}color:#7bc47f;`, `  wrote ${file}`));
        for (const note of exported.pending) result.appendChild(el('div', `${MUTED}color:#e5c07b;`, `  pending: ${note}`));
        for (const issue of exported.issues) {
          result.appendChild(
            el('div', `${MUTED}color:${issue.severity === 'error' ? '#e06c75' : '#e5c07b'};`, `  ${issue.severity} ${issue.path} ${issue.message}`),
          );
        }
      }));
      row.append(go, el('span', MUTED, job.id.slice(0, 8)), result);
      exportList.appendChild(row);
    }
  }

  function renderAll(credits = ''): void {
    renderBanner();
    renderStatus(credits);
    renderImages();
    renderJobs();
    renderLibrary();
    renderExport();
  }

  // --- behaviour ------------------------------------------------------------

  /** Runs an API call, turning its failure into the banner rather than a throw. */
  async function run(work: () => Promise<void>): Promise<void> {
    try {
      await work();
      banner = null;
    } catch (cause) {
      banner =
        cause instanceof StudioApiError
          ? { text: cause.message, remedy: cause.remedy }
          : { text: String(cause), remedy: '' };
    }
    renderAll(lastCredits);
  }

  let lastCredits = '';

  async function refresh(): Promise<void> {
    if (!api.hasToken) return;
    const [loadedConfig, credits, loadedJobs] = await Promise.all([api.config(), api.credits(), api.jobs()]);
    config = loadedConfig;
    jobs = loadedJobs;
    lastCredits =
      `spent ${formatCredits(credits.total, credits.unreportedCalls)}` +
      ` · today ${formatCredits(credits.today, credits.unreportedCalls)}`;
  }

  async function priceImage(image: PendingImage): Promise<void> {
    if (image.sha256 === null) return;
    image.busy = true;
    await run(async () => {
      const establishes = establishesRigFamily(jobs, image.skeletonId);
      image.estimate = await api.estimate({
        unitId: image.unitId,
        skeletonId: image.skeletonId,
        referenceImageSha256: image.sha256 ?? '',
        faceLimit: image.faceLimit,
        clipIntents: establishes ? image.clipIntents : [],
        establishesRigFamily: establishes,
      });
    });
    image.busy = false;
    renderAll(lastCredits);
  }

  async function confirmImage(image: PendingImage): Promise<void> {
    const estimate = image.estimate;
    if (!estimate || image.sha256 === null || estimate.confirmationToken === undefined) return;
    image.busy = true;
    await run(async () => {
      const establishes = establishesRigFamily(jobs, image.skeletonId);
      await api.createJob(
        {
          unitId: image.unitId,
          skeletonId: image.skeletonId,
          referenceImageSha256: image.sha256 ?? '',
          faceLimit: image.faceLimit,
          clipIntents: establishes ? image.clipIntents : [],
          establishesRigFamily: establishes,
        },
        estimate.confirmationToken ?? '',
      );
      // The quote is spent whether or not the job succeeds, so it is cleared
      // here rather than left on screen looking actionable.
      image.estimate = null;
      await refresh();
    });
    image.busy = false;
    renderAll(lastCredits);
  }

  async function addFiles(files: readonly File[]): Promise<void> {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const decoded = await decode(file);
      if (!decoded) continue;
      const buffer = await file.arrayBuffer();
      const stats = measureImage(decoded.width, decoded.height, decoded.data);
      const image: PendingImage = {
        name: file.name,
        bytes: file.size,
        width: decoded.width,
        height: decoded.height,
        findings: checkImage(stats),
        previewUrl: URL.createObjectURL(file),
        sha256: null,
        uploadError: null,
        unitId: file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_.-]/g, '-'),
        skeletonId: 'biped',
        faceLimit: config?.defaultFaceLimit ?? 8000,
        clipIntents: [...defaultClipIntents()],
        estimate: null,
        busy: false,
      };
      pending.push(image);
      renderImages();

      // Uploading here rather than at confirm time means the hash -- and so the
      // cache lookup -- is known before a price is ever asked for.
      try {
        const uploaded = await api.uploadImage(buffer, file.name, file.type);
        image.sha256 = uploaded.sha256;
      } catch (cause) {
        image.uploadError = cause instanceof StudioApiError ? cause.message : String(cause);
      }
      renderImages();
    }
  }

  drop.addEventListener('click', () => filePicker.click());
  filePicker.addEventListener('change', () => {
    const chosen = filePicker.files;
    void addFiles(chosen ? Array.from(chosen) : []);
    filePicker.value = '';
  });
  for (const event of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(event, (e) => {
      e.preventDefault();
      drop.style.borderColor = '#7bc47f';
    });
  }
  for (const event of ['dragleave', 'drop'] as const) {
    drop.addEventListener(event, (e) => {
      e.preventDefault();
      drop.style.borderColor = '#4a4a5e';
    });
  }
  drop.addEventListener('drop', (e) => {
    const dropped = e.dataTransfer?.files;
    void addFiles(dropped ? Array.from(dropped) : []);
  });

  tokenSave.addEventListener('click', () => {
    api.setToken(tokenInput.value);
    tokenInput.value = '';
    void run(refresh);
  });

  renderAll();

  return {
    element: root,
    start(): void {
      // Mounted on first activation, so a session that never opens Studio never
      // builds a second WebGL context or fetches a mesh.
      startPreview();
      previewHandle?.start();
      tokenInput.placeholder = api.hasToken
        ? 'a token is stored; paste a new one to replace it'
        : 'admin token (printed by `npm run server` at boot)';
      void run(refresh);
      // Polled rather than pushed: the queue changes on the server's schedule,
      // and a socket for a panel somebody has open for a minute at a time would
      // be a second transport to keep alive for no gain.
      timer = setInterval(() => void run(refresh), POLL_MS);
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
      previewHandle?.stop();
    },
  };
}
