# `src/ui/` GUI framework + shop (spec 123+) — replaces the stale pre-123 version of this note

This file previously documented the *old* hand-rolled DOM system in `src/render/`.
That system is gone from the Play tab. Since spec 123 there is a real retained-mode,
canvas-independent GUI framework at `src/ui/`, mounted over the world by
`src/render/iso3d/world/ui-screens.ts`. This note describes that framework.
Canonical docs: `docs/ui/00-architecture.md` (design) and
`docs/ui/01-building-a-screen.md` (walkthrough with copy-paste recipes — read this
first when adding a screen).

## 1. `src/ui/core/` — the widget tree

`src/ui/core/widget.ts` — `abstract class Widget` (line 76). Full API surface:

- Tree: `parent`, `children` (getter), `add(child)`, `addAll(children)`,
  `remove(child)`, `clearChildren()`.
- Flags: `visible=true`, `enabled=true`, `focusable=false`,
  `focusOnPress=false` (only `TextField` sets `true` — spec 137: a press only
  hands the keyboard to something that types), `pointerTransparent=false`,
  `layoutGrow=0`, `layoutAlign: 'start'|'center'|'end'|'stretch'='stretch'`.
- `sounds: SoundSink | null = null` (widget.ts:126) — set on **one** node
  (`UiRoot` sets it on `content`); every descendant finds it by walking
  `parent`. `protected emitSound(id: UiSoundId)` (line 348) walks up from
  `this.parent` (checking `this` first) and no-ops if nothing above has a sink.
- Layout (final, not overridable): `measure(constraint, context): Size` (252),
  `arrange(target: Rect, context): void` (276, snaps to whole px). Subclasses
  override `protected abstract measureSelf(constraint, context): Size` and
  `protected arrangeSelf(rect, context): void` (default: give every child the
  full box). Dirty flags: `invalidateMeasure()` (walks up), `invalidateArrange()`
  (marks subtree + walks up via `subtreeArrangeDirty`, for e.g. `ScrollView`
  whose own rect never changes but whose content slides). `needsMeasure`,
  `needsArrange`, `needsArrangeInSubtree`, `desiredSize`, `rect: Rect`.
- Paint: `paint(out: DrawList, context: PaintContext): void` (291, final —
  calls `paintSelf` then `paintChildren`; `UiWindow`/`Dialog`/`ChatScreen`
  override the *whole* `paint()` method, not `paintSelf`, to clip a reveal
  animation around it). Subclasses override `protected paintSelf(out, context)`
  (default: draws nothing) and may override `protected paintChildren(out, context)`
  (e.g. `ScrollView`/`Panel`/`TabStrip` push a clip around it).
- Hit-testing: `hitTest(point): Widget | null` (302, concrete on `Widget`,
  back-to-front, returns `null` if `pointerTransparent`). Override point:
  `protected containsForHitTest(point): boolean` (314) — the *only* place
  `ItemSlot` (bigger catch rect) and `TabStrip`/`Window` grip differ from paint rect.
- `path(): readonly Widget[]` (324, root→this, for capture/bubble),
  `walk(): Generator<Widget>` (335, depth-first paint order, used by focus).
- **`onCapture`/`onEvent`/`onGesture` are NOT declared on `Widget` itself.**
  They are an optional duck-typed `EventHandler` interface
  (`core/router.ts:30`): `onCapture?(context: EventContext)`,
  `onEvent?(context: EventContext)`, `onGesture?(gesture: Gesture)`. A subclass
  implements whichever it needs; `EventRouter.dispatch` casts
  (`widget as unknown as EventHandler`) and calls them if present. Capture runs
  root→target, bubble (`onEvent`) runs target→root, `onGesture` fires from
  `EventRouter.emit` for derived clicks/drags/hover.

`src/ui/widgets/base.ts` — `abstract class StyledWidget extends Widget`, the
base every real widget uses instead of `Widget` directly. Adds:
`constructor(readonly styleKey: string, name = '')`, `style(context): WidgetStyle`,
`stateFor(context): WidgetState` (disabled > pressed > hover > focused > normal),
`resolved(context): StateStyle`, `protected drawChrome(out, context, box)` (fill,
then 9-slice frame, then focus ring).

### Routing (`core/router.ts`, `core/events.ts`)

`EventRouter.route(root, event, keyTarget)` (router.ts:85): pointer events go
through `routePointer` (hit-test, implicit capture on `down`, drag-threshold →
`dragStart`/`drag`, click only if release lands back on the press target,
double-click within `theme.input.doubleClickMs`); wheel goes to
`press?.widget ?? hitTest ?? root`; key/text go to `keyTarget` (i.e. whatever
`UiRoot.focus` holds). `UiEvent` union (events.ts): `PointerEventData` (`kind:
'pointer'`, `phase: 'down'|'up'|'move'`, `pos`, `button`, `mods`, `time`),
`WheelEventData` (`delta` in notches — `wheelNotches(deltaY)` converts a DOM
`deltaY`), `KeyEventData` (`code: PhysicalKey` = `KeyboardEvent.code`),
`TextEventData` (`text`). `ContextStack` (events.ts:158): `gameplay → ui →
modal → textEntry`; `modal`/`textEntry` have `blocksBelow: true`,
`swallowsKeys: true`. `reachesGameplay(kind)` checks the top context.

### Containers (`core/containers.ts`)

`Linear` (base of `Row`/`Column`): `gap`, three-pass sizing —
`Linear.shareSpace` (110) implements "grow shares leftover space, never takes
it" (two `grow:1` children end up equal width regardless of content — ADR-101).
`Stack` (191): every child gets the whole box, paint order = z-order.
`Anchor` (222): `place(child, side: AnchorSide)` — `topLeft|top|topRight|left|
center|right|bottomLeft|bottom|bottomRight`; this is what docks HUD furniture.
`Grid` (280): uniform cells, `columns`/`cellWidth`/`cellHeight`, no packing.

### Layers (`core/layers.ts`)

`LAYER_IDS = ['hud','windows','dragGhost','modal','tooltip','notification']`.
`LayerStack extends Stack`: one child `Stack` per layer, `layer(id)`,
`place(id, widget)`, `isBlocked()`, `hitTest` stops at the first `blocksBelow`
layer with a visible child (this — not `Dialog` itself — is what makes a modal
modal). Every layer is `pointerTransparent = true` always; `spec.interactive`
decides whether it's even *consulted*, so an interactive-but-empty layer never
swallows a click (ADR-106).

### Windows (`core/window-manager.ts`, `widgets/window.ts`)

`WindowManager extends Widget`: owns z-order as a `string[]` (`stack`), not a
number on each window. `register(window: UiWindow, id: string)`, `focus(id)`,
`open(id, nowMs?)` (nowMs → wipe-in animation), `close(id)`, `toggle(id)`,
`closeTopmost()` (skips pinned/unclosable), `windowAt(point)`, `setViewport`.
`UiWindow extends StyledWidget` (`widgets/window.ts:61`):
`constructor(readonly content: Widget, options: WindowOptions, name?)` where
`WindowOptions = { title, closable?=true, resizable?=false, minSize?, maxSize?,
at?, size? }`. Title bar is the only drag handle; grip (7px, bottom-right) hit-
tests *before* content (window.ts:293) so a scroller inside doesn't eat resize
drags. `pinned` (Escape-immune, player's own choice per window),
`appear(nowMs, durationMs, easing)` (reveal-clip wipe, not a slide — draw list
has no transform op). `hasFocusWithin(context)` drives the bold title bar.

### Focus (`core/focus.ts`)

`FocusManager`: `focus(widget|null)`, `move(scope, step)` (Tab, wraps),
`revalidate(scope)` (drops focus if it became unreachable — hidden ancestor,
disabled, etc). `focusableWidgets(scope)` filters to `focusable && enabled &&
visible` **including every ancestor**.

### `UiRoot` (`core/root.ts:64`) — the one object a caller holds

`new UiRoot(content: Widget, options: UiRootOptions)` where options =
`{ theme, motion?, atlas, viewport, windows?, layers?, sounds? }`.
Three verbs: `update(nowMs): void` (lays out only if dirty, `layoutPasses`
counter for "a still frame does zero work" tests), `handle(event: UiEvent):
boolean` (click-to-focus-window before routing; Escape → `windows.closeTopmost()`
first, NOT consumed if nothing closed so gameplay still sees it for cast-cancel;
else `router.route`), `paint(): DrawList`. Also: `reachesGameplay(kind)`,
`pushContext`/`popContext`, `moveFocus(step)`, `resize(viewport)`.

## 2. `src/ui/screens/` — full list (14 files)

`character.ts`, `chat.ts`, `keybindings.ts`, `hud.ts` (gallery-only DOM HUD,
not used by the Play tab), `shop.ts`, `selected-unit.ts`, `trade.ts`,
`action-bar.ts`, `account.ts`, `display.ts`, `audio.ts`, `options.ts`,
`inventory.ts`. Registered as `UiWindow`s by `ui-screens.ts`: `inventory`,
`character`, `account`, `shop`, `trade`, `options` (`WindowId` union,
`control-actions.ts:34`). `chat`, `selected-unit`, `action-bar` are **not**
windows — docked `hud`-layer furniture (see below).

### Window screen — `ShopScreen` (`src/ui/screens/shop.ts:92`)

`class ShopScreen extends Column`. Constructor takes `ShopOptions = { theme,
contexts: ContextStack, focus?: FocusManager }`. Structure: heading `Label` +
purse `Label` + `Separator` + 3x (`sectionLabel` + `ScrollView(Column)` of
`ShopLine extends Row` — each line is `Label(name) + Label(price) + Button`).
`readonly dialog: Dialog` is built in the constructor (confirm-sale modal) but
**not placed in a layer by ShopScreen itself** — the mount does
`this.layers.place('modal', this.shop.dialog)` (ui-screens.ts:584). Public API:
`setShop(view: ShopView)` (the *only* thing that mutates the screen — rebuilds
lines via `sync()`, a grow-only reuse-the-widgets helper), `onBuy/onSell/
onBuyBack: ((id) => void) | null`, `askToSell(row, nowMs?)` opens `dialog`,
`dismiss(): boolean` (Escape hook, used by `ui-screens.ts` handleKey's
`escapeTaken` list). **No prediction**: buying and selling both wait for the
next `setShop` from the server; only selling asks first (via `Dialog`), buying
does not (ADR-123/124 in `01-building-a-screen.md`).

### HUD furniture screen — `ChatScreen` (`src/ui/screens/chat.ts:238`) and
`SelectedUnitScreen` (`src/ui/screens/selected-unit.ts:160`)

Both are **not** `UiWindow`s — no title bar, never dragged, nothing in the
layout store ("furniture that is always there"). Mounted via `Anchor` + a
`hud`-layer placement in `UiScreens`' constructor:
```
this.chat = new ChatScreen({ theme: THEME });
this.chatDock = new Anchor('chat:dock');
this.chatDock.pointerTransparent = true;
this.chatDock.padding = chatInsets(THEME, 0);
this.chatDock.place(this.chat, 'bottomLeft');
this.layers.place('hud', this.chatDock);
```
(ui-screens.ts:676-680; `selected-unit` mirrors this at 705-709, anchored
`'topRight'`.) Both screens set `this.pointerTransparent = true` on themselves
(and their inert children) so the world underneath stays clickable, opting
specific interactive bits back in (`ChatScreen` flips `pointerTransparent =
false` on itself/log only while the field is open). Both draw **nothing** when
there is nothing to show (`ChatScreen.setView` checks `holdsSomething` *before*
the same-content early-out; `SelectedUnitScreen.setView(null)` hides *before*
comparing) — settling visibility first is the rule; deciding it after an
early-out is a decision that's never taken on the very first frame. Neither
does layout work every frame: `Meter`/label fields are set directly, only
identity changes (`ChatLine` id list changing, `view.statuses[index]` changing)
call `invalidateMeasure()`.
`ChatScreen` pushes `'textEntry'` on its `TextField` focus via `setFocused`
(chat.ts:113/327) so a typed digit doesn't cast a hotbar skill.
`SelectedUnitScreen extends Panel` (has a frame); `ChatScreen`/its `ScrollView`
subclass `ChatLogView` override `paintSelf` to draw *no* chrome, since the
screen draws one shared translucent plate itself (chat.ts:463, the framework's
**only** blend — `PLATE_ALPHA=156` chosen so the premultiplied round-trip is
lossless, asserted in `budget.test.ts`).

## 3. `src/ui/widgets/` — the widget catalogue

CLAUDE.md's "the nine" (`docs/ui/01-building-a-screen.md:3`) is spec 123's
**original phase-1** set: `Panel, Label, Button, Icon, Checkbox, Slider,
TextField, ScrollView, Separator`. The directory now holds 14 files / ~20
exported classes (added in later specs): `Window`(124), `Tab`/`TabStrip`/
`TabPanel`(124/198), `Tooltip`(124), `Dialog`(130), `ItemSlot`/`DragGhost`(127),
`Meter`/`SkillSlot`(128), `Section`/`Spacer`/`Padded`(panel.ts extras).

Exact constructor signatures:

- `Button(labelText = '', name = 'button')` — button.ts:39. Fields: `onPress:
  ((nowMs: number) => void)|null`, `fontId: FontId='body'`, `iconName:
  string|null`. `press(nowMs=0)` emits `'ui.press'` then calls `onPress`
  unconditionally of listeners ("at the intent, not the outcome").
- `Icon(iconName: string, name='icon')` — button.ts:147 (not focusable/pressable;
  a pressable icon is `Button` with `iconName` set).
- `Separator(axis: 'row'|'column'='row', name='separator')` — button.ts:174.
- `Label(textValue='', fontId: FontId='body')` — label.ts:55. Fields: `align:
  HorizontalAlign='start'`, `wrap=false` (opt-in, never automatic —
  auto-wrap makes layout order-dependent), `colorToken: string|null`.
  `setText(value)`, `lines(maxWidth)`.
- `Checkbox(labelText='', name='checkbox')` — checkbox.ts:30. `onToggle:
  ((checked:boolean)=>void)|null`, `checked` (getter), `setChecked(value)`
  (silent), `toggle()` (notifies).
- `Slider(min=0, max=100, initial=0, step=1, name='slider')` — slider.ts:31.
  `onChange: ((value:number)=>void)|null`, `current` (getter), `setValue(next)`
  (silent), `fraction` (0..1 getter). Press-anywhere-on-track jumps + drags.
- `TextField(initial='', name='textField')` — text-field.ts:66. Fields:
  `onChange`, `onSubmit: ((text:string)=>void)|null`, `fontId`, `placeholder=''`,
  `maxLength=64`, `masked=false` (paint-only `*` masking, spec 226), `columns=12`.
  `text` (getter), `setText(value)` (caret→end), `setFocused(focused, contexts:
  {push(id:'textEntry'), pop(id:'textEntry')})` — **the field pushes its own
  context**, nothing else does it for it. `focusOnPress = true` (the only
  built-in widget with this set).
- `ScrollView(readonly content: Widget, name='scrollView')` — scroll-view.ts:90.
  `maxHeight: number|null=null` (ceiling; null = take what's offered).
  `scrollOffset`/`maxScroll`/`scrollable` (getters), `scrollTo(next)`,
  `scrollBy(delta)`, `wheelBy(notches): boolean` (public so a screen that pins
  a band above its own scroller — `CharacterScreen`, `TabPanel` — can forward a
  wheel notch into it), `WHEEL_STEP=12` px/notch.
- `Tab(readonly id: string, labelText: string)` — tabs.ts:47 (one tab header).
  `TabStrip(name='tabStrip')` — tabs.ts:125 (horizontal-scrolls when tabs
  overflow). `TabPanel(name='tabs')` — tabs.ts:238. `addTab(id, label, build:
  () => Widget): this` — **content built lazily on first `select(id)`, then
  kept** (each tab gets its own `TabBody extends ScrollView`, spec 198: "a tab
  strip is never inside the thing it scrolls" — the strip is the scroller's
  *sibling*, not its parent). `select(id)`, `activeId`, `isBuilt(id)`,
  `bodyScroller`, `wheelBody(delta)`, `tabRect(id)`.
- `ItemSlot(readonly ref: SlotRef, name='itemSlot')` — item-slot.ts:228.
  `implements DropTarget`. Fields: `item: ItemView|null`, `acceptsSlot:
  string|null` (family id, not a lookup — a widget checking a table would have
  an opinion about game rules), `dropCandidate=false`, `pending: SlotPending|
  null` (spec 188 in-flight swap marker, `{role:'out'|'in', progress}`),
  `onDropItem: ((drag,to)=>void)|null`, `onClick: ((slot,gesture)=>void)|null`
  (fed by `click`/`dragEnd`/`doubleClick` — one press-and-release vocabulary,
  spec 137). `SLOT_SIDE=20`, `SLOT_CATCH=2` (hit-test rect is bigger than paint
  rect by exactly half the gutter, so catch rects tile with no overlap/gap).
  Not `focusable` — the bag is a pointer surface, arrow keys belong to the game.
- `DragGhost(name='dragGhost')` — drag-ghost.ts:21. `show(item, count, at:
  Point)`; centred on the cursor; lives in the non-interactive `dragGhost` layer.
- `Meter(name='meter')` — meter.ts:30. `fraction=1` (**a plain field, no
  setter, no dirty flag** — the whole reason retained mode works for a health
  bar), `fillToken='danger'`, `caption=''`, `captionFont: FontId='body'`
  (never `'numeric'` — that face can't spell `84/120`), `thickness=12`.
  `setValue(current, max)` (snap), `setValueAnimated(current, max, nowMs)`
  (spec 133 chase tween). Deliberately not `layoutGrow=1`.
- `SkillSlot(readonly index: number, name='skillSlot')` — skill-slot.ts:41.
  `ability: AbilityView|null`, `keyLabel=''`, `onActivate: ((index)=>void)|
  null`, `side=SLOT_SIDE` (physical-px-driven, unlike `ItemSlot`'s fixed 20 —
  action-bar slots are tap targets), `iconScale=1` (whole numbers only —
  nearest-neighbour blit), `badge=''` (vial charge count), `highlight:
  string|null` (aimed/casting/requested token), `change: {label,progress}|null`
  (spec 188 swap overlay, opposite direction from the cooldown wedge).
- `Panel(axis: Axis='column', name='panel')` — panel.ts:17 (a drawing `Linear`;
  `styleKey` is mutable so `Window`/`Tooltip` reuse this class's chrome logic
  conceptually, though they're separate classes). `withThemePadding(padding):
  this`. `Section(heading: Widget, name)` — heading + body, `Spacer(size)`,
  `Padded(child, padding, name)` — all in panel.ts.
- `Dialog(options: DialogOptions)` — dialog.ts:49, `DialogOptions = { theme,
  title, message, confirmLabel?, cancelLabel?, cancellable?=true }`.
  `confirmButton`/`cancelButton: Button`, `onConfirm`/`onCancel: (()=>void)|
  null`. `ask(title, message)` (reuse one dialog for a new question rather than
  building a second), `show(contexts: ContextStack, focus?: FocusManager,
  nowMs?)` — **pushes `'modal'`**, focuses `confirmButton` — `focus` MUST be
  the root's own `FocusManager` or no keystroke ever reaches it (bitten twice,
  per the docs). `hide(contexts, focus?)` pops `'modal'`. `isOpen`. Narrower
  than offered (`MAX_WIDTH=180`), centres itself in whatever rect it's given
  (its parent is a full-viewport `modal` layer `Stack`).
- `UiWindow` — see §1 above (window.ts).
- `Tooltip(name='tooltip')` — tooltip.ts:97. `point(content: TooltipContent|
  null, at: Point, now: number)` — waits `theme.input.tooltipDelayMs` from
  timestamps handed to `update(now, delayMs): boolean`; `TooltipContent =
  string | readonly TooltipLine[]`; `TooltipLine = { text, colorToken?, spans?:
  readonly TooltipSpan[] }` (spans = coloured runs on one line, e.g. weapon
  scaling letters — never wrapped). Flips to stay on-screen (`placementFor`).
  `MAX_WIDTH=140`, `CURSOR_GAP=8`. Wrapping is **per line** — each line folds
  on its own so a long name can't run into the stat under it.

## 4. `src/ui/theme/` — the palette

`theme.json` `palette` (22 named colours — `theme.test.ts:41` asserts
`Object.keys(THEME.palette).length <= 22`; several long-form comments
elsewhere in the tree, including CLAUDE.md's prose, still say "nineteen" and
are stale — that was true before spec 216 added the three `attr*` colours):

```
ink, shadow, panel, panelRaised, panelSunken, edgeLight, edgeDark,
text, textDim, textInverse, accent, accentDark, danger, success, focus,
overlay, rarityCommon, rarityRare, rarityExceptional,
attrStrength, attrAgility, attrIntelligence
```

A widget never spells a colour: it asks `context.theme.color('accent')` (→
`Color = {r,g,b,a}`, `theme.ts:238`) or, for per-widget-kind chrome, reads
`context.theme.widget(styleKey).state(stateFor(context))` for `{fill,
frameTint, text, mark}`. `Theme.widget(name)`/`color(name)` **throw** on an
unknown name — a widget naming a style that isn't there is a bug, not a
fallback case. `eslint.config.js` bans hex literals in `widgets/`, `screens/`
and `gallery/`; a colour must come from `theme.color(token)` or
`Label.colorToken`/`Meter.fillToken`/etc.

`ScalingAttributeId`/`ATTRIBUTE_TOKENS` (theme.ts:46-65): `strength→
attrStrength`, `agility→attrAgility`, `intelligence→attrIntelligence` — kept
here (not in `server/`) because `src/ui/` may not import the server; a test
keeps the two string sets in sync.

## 5. The shop, end to end

**Client view-model** — `src/render/iso3d/world/shop-model.ts`:
`nearestVendorTo(x, y): string|null` (54) picks the nearest in-reach vendor
from `ALL_VENDORS`/`withinReach` — a *guess*, since the server still decides
whether it'll serve one. `shopViewOf(source: ShopSource): ShopView|null` (74)
— `ShopSource = { vendor: {id,name,stock,buyback}|null, inventory: Inventory,
coins: number }`. Builds each row's `enabled`/`blockedBecause` by running the
server's own `buy`/`sell` pure functions against the client's own copy of the
bag (ADR-124: a greyed button and a refusal give the same reason).

**Server rules** (pure, no session) — `src/server/player/shop.ts`:
`buy(inventory, coins, vendor: VendorDefinition, defId, count): ShopOutcome`
(62), `sell(inventory, coins, vendor, index, count): ShopOutcome` (96),
`buyBack(inventory, coins, entry: BuybackEntry): ShopOutcome` (138).
`ShopOutcome = {ok:true, inventory, coins, sold?}|{ok:false, reason}`.
Currency field is **`coins: number`** (`server/state/types.ts:281`,
`PlayerRecord.coins`). Proximity is deliberately **not** checked here (session
state, not pure-exchange state).

**Session/proximity glue** — `src/server/player/player-manager.ts`:
`vendorInReach(session, vendorId): VendorDefinition|string` (618, string =
refusal reason) uses `withinReach(vendor, x, y)` from
`src/server/data/vendors.ts:108`. `async buyItem(playerId, vendorId, defId,
count)` (669), `async sellItem(...)` (684), `async buyBackItem(playerId,
vendorId, index)` (703) — each resolves the vendor, calls the pure `shop.ts`
function, then `private async settle(...)` (639) commits
`{ ...session.record, inventory, coins }`, calls `recalculate`, and
**persists immediately** (`persistNow`) rather than waiting for the autosave
loop — a purchase moves currency, spec 226's "persist money now" rule.

**Wire** (`src/server/net/`): opcodes in `protocol.ts:49-52` —
`BuyItem: 0x0e`, `SellItem: 0x0f`, `OpenVendor` (between them), `BuyBack:
0x10`. Message shapes (`messages.ts:213-236`):
`BuyItemMessage { type, requestId, vendorId, defId, count }`,
`SellItemMessage { type, requestId, vendorId, index, count }` (index is an
**inventory slot** — equipment is never sold off the body, spec 129),
`BuyBackMessage { type, requestId, vendorId, index }` (index into the
server-sent buyback list). `PROTOCOL.md:572-574` documents the bytes.

**Client send** (`src/server/client/game-client.ts:1247-1289`):
`buyItem(vendorId, defId, count=1): number`, `sellItem(vendorId, index,
count=1): number`, `buyBack(vendorId, index): number` — each increments
`this.shopRequests` (used as `requestId`) and returns it.

**Server receive** (`src/server/server.ts:903-945`): `case
ClientMessageType.BuyItem/SellItem/BuyBack` each call the matching
`this.players.*Item(...)`, `reportAction(connection, ok?null:reason)`,
`sendInventory(connection, message.requestId)`, and
`sendVendorState(connection, connection.openVendorId)` (refreshes the buyback
list, which changes on every sale).

**UI wiring** (`src/render/iso3d/world/ui-screens.ts:574-584, 932-948`):
`this.shop.onBuy = defId => options.onBuy(this.openVendorId, defId)` etc. —
`options.onBuy/onSell/onBuyBack` (declared `UiScreensOptions`, ui-screens.ts:
153-155) are supplied by `view.ts` and ultimately call
`GameClient.buyItem/sellItem/buyBack`. Per frame: `this.openVendorId =
view.vendor?.id ?? ''`; if the `shop` window `isOpen`, rebuild via
`shopViewOf` and `this.shop.setShop(shopView)`; **if the server has actually
answered `null` for `view.vendor` and that answer is newer than the ask
(`view.vendorRevision > this.shopAskedAt`), the window is closed by the
client** — the shop never decides to open/stay-open on its own guess, only to
close on a confirmed "there is no vendor here." `show('shop')` (line 1651-1654)
sends `onVendor(nearestVendor())` *before* opening the window, so the first
drawn frame is already the server's shop rather than an empty one filling in
later. `close('shop')` sends `onVendor('')`. `shop`/`trade` are excluded from
`playerDriven(id)` (line 271) — a server-opened window is never restored open
from the saved layout.

## 6. Mounting (`src/render/iso3d/world/ui-screens.ts`, `ui-routing.ts`)

`UiScreens` (ui-screens.ts:322) is the pure half of the mount — everything
about what the interface *is*; `ui-layer.ts` (not detailed here) is the one
impure file: a canvas, the UI scale, and pointer-pixel conversion. Built once
per session with `UiScreensOptions` (a big bag of `on*` request callbacks +
`map: InputMap` + optional `sounds`/`audio`).

Construction pattern per window screen: build the screen, wire its `on*`
callbacks to `options.on*`, then `this.registerWindow(id: WindowId, screen,
{scrolled?=true, minSize?})` (776) — wraps in a `ScrollView` unless
`scrolled:false` (screens with their own internal `TabPanel` scrolling, spec
198), builds a `UiWindow`, `this.windows.register(window, id)`, starts
`visible=false`. HUD furniture (`chat`, `selectedUnit`, `actionBar`) is built
and `this.layers.place('hud', dock)`ed directly in the constructor instead —
no `registerWindow` call, no `WindowId`.

Per frame: `update(view: ClientView, nowMs: number, drawnTick?)` (887) —
`this.restoreLayout()` first, then for each **open** window/dock, re-derive
its view-model from `view` (the wire-decoded `ClientView`) via the matching
`*-model.ts` / `*ViewOf` function and call `screen.setView(...)`/
`setContainers(...)`/`setCharacter(...)`/`setShop(...)` etc. — **screens never
read `view` directly; the mount always translates.** `paint(): readonly
DrawCommand[]` (1167) is `this.root.paint().finish()`.

Windows: `show(id)` / `close(id)` / `toggle(id)` / `isOpen(id)` /
`opened(): readonly WindowId[]`. `show` calls `this.windows.open(id, this.now)`
(time → wipe-in) and plays `'ui.open'`; a window not yet `placed` is queued in
`awaitingPlacement` and sized by `placeWindow(id)` **after** the screens are
fed this frame (a window sized before its screen has content measures too
small and never grows). `WindowId = 'inventory'|'character'|'shop'|'trade'|
'options'|'account'` (`control-actions.ts:34`) — **to add a new window
screen, add its id here, its title to `WINDOW_TITLES` (ui-screens.ts:275), and
a `registerWindow` call in the constructor.**

Input entry points, all called by `view.ts`, all return **`true` when
gameplay must NOT act on the event**:
`handlePointer(phase, pos, button, mods): boolean` (1803),
`handleWheel(pos, delta, mods): boolean` (1885),
`handleKey(code, phase, mods, text?): boolean` (1908).
Each ends with `return !reachesGameplay(this.routingOf(consumed, kind))`.
`private routingOf(consumed, kind): Routing` (1998) = `{ consumed, blocked:
!this.root.reachesGameplay(kind) }`. `ui-routing.ts` (59 lines, pure) defines
`Routing = {consumed, blocked}`, `reachesGameplay(routing)` (consumed OR
blocked ⇒ don't reach gameplay — checked in that order because "consumed" is
the common case), and `escapeTaken(steps: readonly (()=>boolean)[])` — the
Escape priority list is an actual array of thunks in `handleKey` (1926-1936):
`inventory.cancelDrag()` → `shop.dismiss()` → `escapeChat()` →
`closeTopmost()` → (if none returned true) gameplay's own cast-cancel runs.

Layer ids (from `core/layers.ts`, reused verbatim): `hud → windows →
dragGhost → modal → tooltip → notification`. `this.layers.place('modal',
this.shop.dialog)` (584) is the *only* thing that makes the sell-confirmation
a real modal — the layer's `blocksBelow` does the blocking, `Dialog` only adds
the keyboard (Enter/Escape) and the `'modal'` context push.

## 7. Text rendering (`src/ui/text/font.ts`, `glyphs-6x10.ts`)

Two bitmap faces, both **monospaced**, no proportional layout anywhere:
- `body` (`FontId='body'`): 6 wide x 10 tall, spacing 1, baseline 8
  (`glyphs-6x10.ts:23-28`), full-ish ASCII incl. lowercase — the "prose" face,
  used by `Label`, `Button`, `TextField`, `Tooltip`, `Dialog`, window titles.
- `numeric` (`FontId='numeric'`): 5 wide x 7 tall, rebuilt at module load from
  `src/render/iso3d/world/pixel-font.ts`'s glyph rects (`glyphNames()`/
  `glyphRects()`) so the UI's numeric face and the world's floating damage
  numbers can never drift — one source of truth. Glyph set is digits + `+-!`
  only (**cannot spell `/`** — `Meter.captionFont` defaults to `'body'` for
  exactly this reason, ADR-119). Used for `Meter` fill captions when digits-
  only, `ItemSlot` stack counts, `SkillSlot` cooldown/badge/key-label text.

Core functions (`font.ts`): `fontById(id): Font`, `advance(font) = font.width
+ font.spacing`, `measureText(font, text): number` (monospace arithmetic:
`[...text].length * advance - spacing`; iterates code points so it's
surrogate-pair-safe), `glyphFor(font, character): Glyph` (falls back to a
solid block for an undrawable character — silent at draw time, which is why
`isDrawable(font, text): boolean` exists as an authoring-time check: an item
description with a curly quote or em dash silently drew as holes for a
hundred specs before this predicate existed), `wrapText(font, text, maxWidth):
readonly string[]` (177) — breaks at spaces, chops mid-word only when a single
word can't fit a line on its own, honours explicit `\n`. Drawing goes through
`core/paint.ts`'s `drawText`/`drawTextClipped` (append `DrawCommand`s to a
`DrawList`; nothing here calls a canvas API — see `draw-list.ts`).

**`Tooltip` wrapping**: plain lines wrap through `wrapText(font, line.text,
MAX_WIDTH=140)` in `measureSelf` (tooltip.ts:195-221), one call per line, each
wrapped fragment keeping its source line's `colorToken` — so a long name folds
without bleeding its colour into the stat line below it. A line with `spans`
(coloured runs, e.g. `S / D / -` in three attribute colours) is **never
wrapped** — laid out by measuring each run's width and advancing an x pen
(paintSelf, tooltip.ts:254-259); wrapping a spanned line would strand half a
run on the next line with no way to say which colour that half was, so every
spanned line this widget is ever handed is authored short enough not to need it.
`Label.wrap` (label.ts:25) is the general mechanism `Tooltip` reuses the
algorithm of, not the class: it's opt-in per-`Label`, cached per
`(text, wrapWidth)` pair, and paints at `measuredWidth` (the width `measure`
last saw) rather than `rect.width`, because those two can legitimately differ
by a frame and re-wrapping at paint time can silently draw more lines than
were reserved for (ADR-103).

## Notes / stale things found

- The *old* `.claude/notes/ui-framework-map.md` (now overwritten by this file)
  described a hand-rolled-DOM Play tab HUD that predates spec 123. That system
  (`src/render/iso3d/world/hud.ts`, gallery-only now) still exists as a
  reference/testbed but is **not** what the Play tab draws — `ui-screens.ts` /
  `src/ui/screens/action-bar.ts` replaced its bar, pools and death overlay
  (spec 196), and `chat.ts`/`selected-unit.ts` are pure `src/ui/` screens.
- Several long-form comments (chat.ts:52, selected-unit.ts, and CLAUDE.md's
  own prose) say the palette is capped at **nineteen** colours. The actual
  current cap, enforced by `theme.test.ts:41`, is **twenty-two** — spec 216
  added `attrStrength`/`attrAgility`/`attrIntelligence` after those comments
  were written and they were never updated. Trust `theme.test.ts` and
  `theme.json`, not the prose, if this ever matters again.
