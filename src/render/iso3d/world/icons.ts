/**
 * The weapon switch's icons (spec 094), and the window buttons' (spec 140).
 *
 * Keyed by the *attack* rather than the item, because the attack is what the
 * switch is choosing (spec 079): two swords that both slash are one entry, and
 * they are one icon for the same reason.
 *
 * Inline SVG strings rather than a font. Emoji would draw as whatever the phone
 * happened to have, in colour on half of them; a sprite sheet would have to be
 * fetched, and nothing here may be fetched (spec 065). Every path paints in
 * `currentColor`, so the lit/unlit colours the HUD's update loop already writes
 * onto the button carry the icon with them -- there is no second place deciding
 * which weapon looks selected.
 *
 * Pure: it returns markup, it does not touch the DOM, and the shapes are
 * therefore checkable in Node.
 */

export interface IconOptions {
  /** Both sides of the square the icon draws in, in CSS px. */
  readonly size?: number;
  /** Ink. Left as `currentColor` so the button's own colour drives it. */
  readonly color?: string;
}

/**
 * The icon bodies, in a 24x24 box.
 *
 * The wrapper supplies `fill="none" stroke="currentColor"`, so a stroked shape
 * is bare geometry and only the solid parts (a pommel, a shuriken) say
 * otherwise.
 */
export const WEAPON_ICONS: Readonly<Record<string, string>> = {
  // A sword down the diagonal: blade, crossguard, grip, pommel.
  'melee.slash':
    '<path d="M21 3 L10 14" stroke-width="2.8"/>' +
    '<path d="M7.4 11.4 L12.6 16.6"/>' +
    '<path d="M9.4 14.6 L6.2 17.8"/>' +
    '<circle cx="4.9" cy="19.1" r="1.5" fill="currentColor" stroke="none"/>',
  // A bow drawn with the string vertical and the arrow across it, which is the
  // reading that survives being 24px wide.
  'ranged.shot':
    '<path d="M8.5 3 A 10 10 0 0 1 8.5 21"/>' +
    '<path d="M8.5 3 L8.5 21" stroke-width="1.2"/>' +
    '<path d="M3.5 12 L20.5 12"/>' +
    '<path d="M16.8 8.6 L20.5 12 L16.8 15.4"/>',
  // A four-pointed star with the hole a shuriken has, so it is not a sparkle.
  'ranged.star':
    '<path fill="currentColor" stroke="none" fill-rule="evenodd" ' +
    'd="M12 1.5 L14.6 9.4 L22.5 12 L14.6 14.6 L12 22.5 L9.4 14.6 L1.5 12 L9.4 9.4 Z ' +
    'M12 10.1 a1.9 1.9 0 1 0 0 3.8 a1.9 1.9 0 1 0 0 -3.8 Z"/>',
};

/**
 * What an attack with no icon of its own gets.
 *
 * A shape rather than nothing: an empty button is a target the player cannot
 * see, and a weapon added to the item table should look unfinished rather than
 * look absent.
 */
export const FALLBACK_ICON = '<path d="M12 3.5 L20.5 12 L12 20.5 L3.5 12 Z"/>';

/**
 * The action bar's own icons (spec 164): the vial, and the mark an empty slot
 * carries.
 *
 * Separate from {@link WEAPON_ICONS} because these are keyed by what a *slot*
 * is rather than by an ability -- the empty one has no ability to be keyed by,
 * which is the point of it.
 */
export const SLOT_ICONS: Readonly<Record<'vial' | 'empty', string>> = {
  // A flask: a narrow neck, a stopper, a round body and a level of liquid in it.
  // The level is drawn as a solid chord rather than a fill, so a slot that is
  // dimmed for having no charges left still reads as a flask rather than as a
  // circle.
  vial:
    '<path d="M10 3 h4"/>' +
    '<path d="M10.5 3.5 v4.4 a6.5 6.5 0 1 0 3 0 V3.5"/>' +
    '<path d="M7.1 14.5 h9.8" stroke-width="1.4"/>' +
    '<path fill="currentColor" stroke="none" ' +
    'd="M7.1 14.9 a6.4 6.4 0 0 0 9.8 0 a6.5 6.5 0 0 1 -9.8 0 Z"/>',
  // An empty slot: a dashed square, which is the shape every interface uses for
  // "something goes here". Not a question mark and not a plus -- a plus is a
  // button that adds something and there is nothing here to press.
  empty: '<rect x="5" y="5" width="14" height="14" rx="2" stroke-dasharray="3 2.6"/>',
};

/** Which window a HUD button opens, as far as the icon table is concerned. */
export type SystemIconId = 'inventory' | 'character' | 'options';

/**
 * The window buttons' icons (spec 140), in the same 24x24 box.
 *
 * Three shapes that have to read at 24px on a phone and mean something without
 * a caption, which rules out anything with text in it. A bag, a figure and a
 * cog are the three every game already uses, and being unoriginal is the point:
 * this row exists because `I` and `C` are undiscoverable.
 */
export const SYSTEM_ICONS: Readonly<Record<SystemIconId, string>> = {
  // A bag: a body with a flap and a strap over the top.
  inventory:
    '<path d="M4.5 8.5 h15 v11 a1.5 1.5 0 0 1 -1.5 1.5 h-12 a1.5 1.5 0 0 1 -1.5 -1.5 Z"/>' +
    '<path d="M8.5 8.5 V6.5 a3.5 3.5 0 0 1 7 0 v2"/>' +
    '<path d="M4.5 12.5 h15" stroke-width="1.4"/>',
  // A figure, head and shoulders, which is what a character sheet is about.
  character:
    '<circle cx="12" cy="7" r="3.5"/>' +
    '<path d="M4.5 20.5 a7.5 7.5 0 0 1 15 0"/>',
  // A cog. Eight teeth as a dashed ring rather than eight paths: at 24px the
  // teeth are two pixels each and the difference is invisible, and the ring is
  // one shape to get right instead of eight to keep in step.
  options:
    '<circle cx="12" cy="12" r="3.2"/>' +
    '<circle cx="12" cy="12" r="7.6" stroke-width="3.4" stroke-dasharray="2.6 3.4"/>',
};

/**
 * The swirl that marks a stunned body (spec 169).
 *
 * Its own export rather than a row in one of the tables above, because those
 * are both *button* vocabularies -- an inventory bag and a bow are things you
 * press, and this is a thing that happens to you. It also floats over a body
 * rather than sitting in the chrome, which is a different set of constraints:
 * it is drawn small, over moving ground, in a scene it must stay legible
 * against.
 *
 * An open spiral of about a turn and a half, drawn from the outside in. Two
 * choices in it are worth stating. It is **open rather than closed**, so it has
 * a visible head and tail and therefore reads as *turning* once the element is
 * rotated -- a symmetrical ring rotates into a picture of itself and looks
 * still. And it is **off-centre by construction**: the spiral tightens toward a
 * point that is not the viewBox centre, which is what stops the animation
 * looking like a wheel on an axle and makes it tumble the way the stars-round-
 * the-head convention it is borrowing from does.
 */
export const STUN_ICON =
  '<path d="M20 11.5 a8 8 0 1 1 -6.2 -7.8"/>' +
  '<path d="M6.6 13.2 a5 5 0 1 0 5.0 -5.0"/>' +
  '<path d="M13.6 12.4 a2.1 2.1 0 1 1 -2.4 -2.1"/>';

/** The swirl over a stunned body, as markup ready to drop into the HUD. */
export function stunIconSvg(options: IconOptions = {}): string {
  return iconSvg(STUN_ICON, options);
}

/** The icon for an attack, as markup ready to drop into a button. */
export function weaponIconSvg(abilityId: string, options: IconOptions = {}): string {
  return iconSvg(WEAPON_ICONS[abilityId] ?? FALLBACK_ICON, options);
}

/** The icon for an action-bar slot: the vial, or an empty slot's dashed square. */
export function slotIconSvg(id: 'vial' | 'empty', options: IconOptions = {}): string {
  return iconSvg(SLOT_ICONS[id] ?? FALLBACK_ICON, options);
}

/** The icon for a window button. */
export function systemIconSvg(id: SystemIconId, options: IconOptions = {}): string {
  return iconSvg(SYSTEM_ICONS[id] ?? FALLBACK_ICON, options);
}

/** The wrapper both tables' bodies are dropped into. */
function iconSvg(body: string, options: IconOptions): string {
  const size = options.size ?? 20;
  // `color` is set as a style rather than an attribute because `currentColor`
  // inside the paths resolves against the CSS colour property, which is the
  // whole trick that lets one string serve a lit and an unlit button.
  const ink = options.color === undefined ? '' : `color:${options.color};`;
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" ` +
    `style="display:block;${ink}" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );
}
