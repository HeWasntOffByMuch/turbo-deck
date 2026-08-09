/**
 * One open menu at a time (spec 107).
 *
 * The Play tab's settings live behind six buttons in the same top-right corner,
 * and their popovers all open into the same few hundred pixels. Two of them open
 * at once would overlap; so a group owns the fact that at most one is, and each
 * menu only says "toggle me".
 *
 * Pure on purpose. There is no DOM here and no styling -- a member is a callback
 * that gets told when *its* state changes -- which is what lets the rule be
 * asserted in Node while the panels it governs stay unassertable for want of a
 * document.
 */

/** A registered menu's end of the group. */
export interface MenuHandle {
  isOpen(): boolean;
  /** Open this menu if it is closed; close it if it is already open. */
  toggle(): void;
  /** Open this menu, closing whichever sibling was open. */
  open(): void;
  /** Close this menu. A no-op if it was not the open one. */
  close(): void;
}

export interface MenuGroup {
  /**
   * Register a menu. `apply` is called when this menu opens or closes, and only
   * then -- a member that was already closed is not told to close again because
   * a sibling opened.
   */
  add(apply: (open: boolean) => void): MenuHandle;
  /** Close whatever is open. A no-op when nothing is. */
  closeAll(): void;
  /** Which member is open, in registration order, or -1 when none is. */
  openIndex(): number;
}

export function createMenuGroup(): MenuGroup {
  const members: ((open: boolean) => void)[] = [];
  let openAt = -1;

  /**
   * The outgoing menu is applied `false` before the incoming one is applied
   * `true`, so nothing ever observes two open popovers -- including a listener
   * that measures layout from inside `apply`.
   */
  const show = (index: number): void => {
    if (openAt === index) return;
    const previous = openAt;
    openAt = index;
    if (previous >= 0) members[previous]?.(false);
    if (index >= 0) members[index]?.(true);
  };

  return {
    add(apply) {
      const index = members.length;
      members.push(apply);
      return {
        isOpen: () => openAt === index,
        toggle: () => show(openAt === index ? -1 : index),
        open: () => show(index),
        close: () => {
          if (openAt === index) show(-1);
        },
      };
    },
    closeAll: () => show(-1),
    openIndex: () => openAt,
  };
}
