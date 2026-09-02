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

import type { StatusIconId } from '../../../server/data/status-visuals.js';

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
  // --- active skills (spec 188) ---
  //
  // Keyed by ability id like the three above, so the compact bar draws a skill
  // rather than the fallback lozenge. Silhouette rather than detail, for the
  // reason the ability art already gives: these have to read at a glance while
  // something is trying to kill you.
  //
  // A shield with a crack across it: the guard, broken.
  'skill.guardBreak':
    '<path d="M12 2.6 L20 5.6 V12 c0 5.2 -3.4 8 -8 9.4 C8 20 4.6 17.2 4.6 12 V5.6 Z"/>' +
    '<path d="M15.5 6.4 L9.5 12.4 L13.5 13.6 L8 18.6" stroke-width="1.6"/>',
  // A fist, and the shock coming off it: the blow that puts somebody down.
  'skill.stunningBlow':
    '<path d="M7.5 10.5 h6.2 a2.4 2.4 0 0 1 0 4.8 H7.5 Z"/>' +
    '<path d="M7.5 10.9 V9 a2 2 0 0 1 2 -2 h3.6"/>' +
    '<path d="M17.6 6.4 L20.6 4.2 M18.8 10 L22.4 9.4 M17.4 13.6 L20.6 15.2"/>',
  // Two arcs round a centre: a sweep at everything at once.
  'skill.whirlwind':
    '<path d="M12 4.2 A 7.8 7.8 0 0 1 19.8 12"/>' +
    '<path d="M12 19.8 A 7.8 7.8 0 0 1 4.2 12"/>' +
    '<path d="M17 1.8 L19.9 4.4 L17 6.6"/>' +
    '<path d="M7 22.2 L4.1 19.6 L7 17.4"/>' +
    '<circle cx="12" cy="12" r="2.1"/>',
  // A leg, and the cut behind the knee.
  'skill.cripplingStrike':
    '<path d="M10.4 2.8 V9.6 L14.6 14 V21.2"/>' +
    '<path d="M14.6 21.2 h4"/>' +
    '<path d="M6 10.6 L15.4 6.8" stroke-width="1.6"/>',
  // The test row (spec 190): a body with a full row of marks over its head,
  // which is the only thing the skill does. Three ticks and a head rather than
  // a weapon, because it is not one -- a sword shape here would put a test
  // instrument in the same visual language as the four skills that ship.
  'skill.testStatuses':
    '<circle cx="12" cy="14.6" r="4.2"/>' +
    '<path d="M12 18.8 v2.6"/>' +
    '<path d="M5.4 6.6 v3.2 M12 5.4 v4.4 M18.6 6.6 v3.2" stroke-width="2.2"/>',
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

/**
 * Which window a HUD button opens, as far as the icon table is concerned.
 *
 * `account` since spec 227 -- the one window button that does not live beside
 * the other three, but draws from the same table because it *is* one of them.
 */
export type SystemIconId = 'inventory' | 'character' | 'options' | 'account';

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
  // A key: a ring, a shaft and two teeth (spec 227) -- what unlocks an
  // account, and different enough from `character`'s head and shoulders that
  // the two cannot be mistaken for the same button.
  account:
    '<circle cx="7.5" cy="7.5" r="4"/>' +
    '<path d="M10.5 10.5 L20.5 20.5"/>' +
    '<path d="M16 16 L17.6 14.4 M18.5 18.5 L20.1 16.9" stroke-width="1.8"/>',
};

/**
 * The swirl that marks a stunned body (spec 173).
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

/**
 * The status glyphs (specs 186, 190).
 *
 * The same constraints the swirl above states -- drawn small, over moving
 * ground, in a scene they must stay legible against -- plus one more that does
 * not apply to it: **there may be several of them at once, in a row.** So each
 * is built to be told apart at 14px by its *silhouette* rather than by its
 * detail, and they are deliberately spread across shape families: an arrow, a
 * chevron, a diamond, a ring, a crack, a target, a shield, a wave, a leg, a
 * flame, a spatter, a trefoil, a bitten edge, a bolt, a star and a barred
 * cross. Two glyphs that were both "a circle with something in it" would be one
 * glyph as far as a player glancing at a fight is concerned.
 *
 * That constraint got sharper with spec 190, which is why the seven afflictions
 * below reach for the most *conventional* shapes in the set rather than the
 * most considered ones. Every mark here is one colour and they are all the same
 * colour, so the silhouette is carrying the entire identity -- and a player
 * reading a fight has no time to learn a private vocabulary. A flame is fire, a
 * bolt is lightning, a barred cross is "not healing". Inventing a better sign
 * for burning would have been a worse mark.
 *
 * Colour is not here and must not come here: it is set by `kind` at the mount,
 * so a boon and an affliction are told apart before either is identified.
 */
const STATUS_ICONS: Record<StatusIconId, string> = {
  // Flow -- a chevron stream. Motion kept, which is what Flow is.
  flow: '<path d="M5 8 l5 4 -5 4"/><path d="M12 8 l5 4 -5 4"/>',
  // Momentum -- an arrow driven into a wall. The break, then the follow-through.
  momentum: '<path d="M3 12h12"/><path d="M10 7l5 5-5 5"/><path d="M19 5v14"/>',
  // Prepared -- a held charge: a diamond wound tight, with nothing leaving it.
  prepared: '<path d="M12 3l6 9-6 9-6-9z"/><path d="M12 8v8"/>',
  // Patient Read -- an eye. The one mark in this table that is about *looking*
  // rather than about a condition, which is what the mechanic is: the reticle
  // shape is already Vulnerable's and would say the wrong thing here.
  patientRead: '<path d="M2.5 12s4-6 9.5-6 9.5 6 9.5 6-4 6-9.5 6-9.5-6-9.5-6z"/>' +
    '<circle cx="12" cy="12" r="2.5"/>',
  // Attuned -- concentric rings, the stack reading as depth rather than count.
  attuned: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/>',
  // Exposed -- a seam opened up. Two halves parted, with the gap the subject.
  exposed: '<path d="M9 3v18"/><path d="M15 3v18"/><path d="M12 8v8"/>',
  // Vulnerable -- a target, because the body has told you where it is going.
  vulnerable: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3v5"/><path d="M12 16v5"/>' +
    '<path d="M3 12h5"/><path d="M16 12h5"/>',
  // Sundered -- armour with a crack through it.
  sundered: '<path d="M12 3l8 3v7c0 4-4 7-8 8-4-1-8-4-8-8V6z"/><path d="M13 7l-3 5h4l-3 5"/>',
  // Adapted -- a wave meeting a wall and turning back.
  adapted: '<path d="M4 9c3-3 5 3 8 0s5-3 8 0"/><path d="M4 15c3-3 5 3 8 0s5-3 8 0"/>',
  // Slowed -- a footprint with a drag behind it. The one mark here that is
  // about the legs, so it says so with a leg: everything else in this table is
  // an abstract shape because everything else is an abstract condition.
  slowed:
    '<path d="M14 4.5a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z" fill="currentColor" stroke="none"/>' +
    '<path d="M14.5 9v4l-3.5 3.5V21"/>' +
    '<path d="M11 16.5L7 18"/>' +
    '<path d="M3 15h4M4 18.5h3"/>',

  // --- the afflictions (spec 190) ----------------------------------------
  // Burn -- a tongue of flame. Asymmetric at the top, so it is a flame at 14px
  // and not the teardrop below it.
  burn: '<path d="M12 3c4.1 3.9 5.6 6.3 5.6 9.1a5.6 5.6 0 0 1-11.2 0c0-2.1 1-3.8 2.7-5.4 0 1.7.6 2.6 1.6 2.9C10.3 7.6 10.6 5.4 12 3z"/>',
  // Bleed -- a spatter rather than one drop: three, at three sizes, falling
  // apart. One teardrop would have been the flame above with the top cut off.
  bleed:
    '<path d="M9 3.4c2 2.7 3.1 4.4 3.1 6.1a3.1 3.1 0 0 1-6.2 0C5.9 7.8 7 6.1 9 3.4z" fill="currentColor" stroke="none"/>' +
    '<path d="M16.5 10.5c1.3 1.8 2 2.9 2 4a2 2 0 0 1-4 0c0-1.1.7-2.2 2-4z" fill="currentColor" stroke="none"/>' +
    '<path d="M10 16c1 1.4 1.5 2.2 1.5 3a1.5 1.5 0 0 1-3 0c0-.8.5-1.6 1.5-3z" fill="currentColor" stroke="none"/>',
  // Poison -- a trefoil. The one abstract sign in the seven, and it is here
  // because there is no picture of "attrition": three rings round nothing is
  // the shape a century of hazard labelling has already taught everybody.
  poison: '<circle cx="12" cy="7" r="3.3"/><circle cx="7.1" cy="15.4" r="3.3"/><circle cx="16.9" cy="15.4" r="3.3"/>',
  // Corrosion -- a surface with a bite taken out of it, and what is left of it
  // running off underneath. The bar is what makes it armour rather than rain.
  corrosion:
    '<path d="M3.5 8h5.6a3 3 0 0 0 5.8 0h5.6"/>' +
    '<path d="M7 12v2.5"/><path d="M12 13.5V17"/><path d="M17 12v2.5"/>',
  // Shock -- a bolt. Nothing else needed considering.
  shock: '<path d="M13.6 3 6.2 13.4h4.9l-1.7 7.6 8.4-10.6h-5.1z"/>',
  // Frostbite -- a six-spoke star with barbs. No enclosing circle, which is the
  // whole of what keeps it away from Vulnerable's target two rows up.
  frostbite:
    '<path d="M12 3v18"/><path d="M4.2 7.5l15.6 9"/><path d="M19.8 7.5l-15.6 9"/>' +
    '<path d="M12 7.4 9.7 5.2M12 7.4l2.3-2.2M12 16.6l-2.3 2.2M12 16.6l2.3 2.2"/>',
  // Decay -- a cross with a bar through it. The most literal mark in the table
  // on purpose: what this affliction costs is not the damage, it is that the
  // thing you would normally do about damage stops working.
  decay: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/><path d="M4.8 19.2 19.2 4.8"/>',

  // --- the aura fields (spec 223) ----------------------------------------
  // Scorched Earth -- a ring with flames standing on it, which is the one shape
  // in this table that is a picture of the *ground* rather than of a body. It
  // has to sit clear of Burn's single tongue eight rows up and of Attuned's
  // concentric rings: the ring is open at the top where the flames stand, so
  // the silhouette is a bowl and not a circle, and the flames are three small
  // points rather than one large one. That the mark echoes the sigil drawn on
  // the ground in the world is the point -- it is the same fire, said twice.
  scorched:
    '<path d="M3.5 16.5a8.5 4.5 0 0 0 17 0"/>'
    + '<path d="M12 4.5c2.4 2.3 3.3 3.7 3.3 5.3a3.3 3.3 0 0 1-6.6 0c0-1.2.6-2.2 1.6-3.2 0 1 .4 1.5 1 1.7-.5-1.4-.4-2.7.7-3.8z"/>'
    + '<path d="M6.6 12.6c1.1 1.1 1.5 1.7 1.5 2.4a1.5 1.5 0 0 1-3 0c0-.7.4-1.3 1.5-2.4z"/>'
    + '<path d="M17.4 12.6c1.1 1.1 1.5 1.7 1.5 2.4a1.5 1.5 0 0 1-3 0c0-.7.4-1.3 1.5-2.4z"/>',
  // Conjured light (spec 250) -- a small disc with four rays off it.
  //
  // The one thing it must not be is a *flame*, because Burn is one eight rows
  // up and the two would read as the same mark in the same colour. So this is
  // the shape nothing else in the table uses: a filled circle radiating, where
  // Attuned's concentric rings are open and Prepared's diamond has straight
  // sides. Four rays rather than eight, because at 14px eight is a blur round
  // a dot and what carries the silhouette is the *gaps*.
  light:
    '<circle cx="12" cy="12" r="3.4"/>'
    + '<path d="M12 2.5v3.4M12 18.1v3.4M2.5 12h3.4M18.1 12h3.4"/>',

  // --- the Warden's recovery (spec 262) ----------------------------------
  // Overheated -- a thermometer, which is this table's own rule about reaching
  // for the conventional sign rather than the considered one. What it has to
  // stay clear of is Burn's tongue of flame and Scorched's bowl of them: a
  // machine venting is *heat* rather than fire, and the two would read as one
  // mark in one colour.
  //
  // What carries it at 14px is being **bottom-heavy**. Every other mark here is
  // either centred or top-weighted -- Slowed is the near miss, a filled dot with
  // a leg under it, and that dot is at the top where this one's bulb is at the
  // bottom. The two ticks are what stop the stem reading as a bare line.
  overheated:
    '<path d="M10.3 13.8V6.6a1.7 1.7 0 0 1 3.4 0v7.2"/>'
    + '<circle cx="12" cy="17.4" r="3.6"/>'
    + '<circle cx="12" cy="17.4" r="1.5" fill="currentColor" stroke="none"/>'
    + '<path d="M6.8 8.6h2.4M6.8 11.6h2.4"/>',
};

/** One status mark, as markup ready to drop into the HUD. */
export function statusIconSvg(id: StatusIconId, options: IconOptions = {}): string {
  return iconSvg(STATUS_ICONS[id] ?? FALLBACK_ICON, options);
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
