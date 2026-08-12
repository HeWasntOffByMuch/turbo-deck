import { describe, expect, it } from 'vitest';
import { createMenuGroup } from './menu-group.js';

/**
 * Spec 107's rule, asserted where it can be: the group is pure, so "one open at
 * a time" is a claim about a state machine rather than about a document.
 */

/** A member that records every state it was told to take. */
function member(group: ReturnType<typeof createMenuGroup>, log: string[], name: string) {
  return group.add((open) => log.push(`${name}:${open ? 'open' : 'closed'}`));
}

describe('createMenuGroup', () => {
  it('opens nothing to begin with', () => {
    const group = createMenuGroup();
    const log: string[] = [];
    const a = member(group, log, 'a');
    expect(group.openIndex()).toBe(-1);
    expect(a.isOpen()).toBe(false);
    expect(log).toEqual([]);
  });

  it('closes the open menu when another opens', () => {
    const group = createMenuGroup();
    const log: string[] = [];
    const a = member(group, log, 'a');
    const b = member(group, log, 'b');

    a.toggle();
    expect(a.isOpen()).toBe(true);
    b.toggle();

    expect(a.isOpen()).toBe(false);
    expect(b.isOpen()).toBe(true);
    expect(group.openIndex()).toBe(1);
  });

  it('applies the outgoing close before the incoming open', () => {
    const group = createMenuGroup();
    const log: string[] = [];
    const a = member(group, log, 'a');
    const b = member(group, log, 'b');

    a.open();
    b.open();

    expect(log).toEqual(['a:open', 'a:closed', 'b:open']);
  });

  it('tells a menu only about its own changes', () => {
    const group = createMenuGroup();
    const log: string[] = [];
    const a = member(group, log, 'a');
    const b = member(group, log, 'b');
    member(group, log, 'c');

    a.open();
    b.open();
    // 'c' was closed throughout and was never told so; 'a' was told once.
    expect(log.filter((entry) => entry.startsWith('c'))).toEqual([]);
    expect(log.filter((entry) => entry === 'a:closed')).toHaveLength(1);
  });

  it('toggles the open menu shut', () => {
    const group = createMenuGroup();
    const log: string[] = [];
    const a = member(group, log, 'a');

    a.toggle();
    a.toggle();

    expect(a.isOpen()).toBe(false);
    expect(group.openIndex()).toBe(-1);
    expect(log).toEqual(['a:open', 'a:closed']);
  });

  it('ignores opening the menu that is already open', () => {
    const group = createMenuGroup();
    const log: string[] = [];
    const a = member(group, log, 'a');

    a.open();
    a.open();

    expect(log).toEqual(['a:open']);
  });

  it('closes only the menu asked, and only when it is the open one', () => {
    const group = createMenuGroup();
    const log: string[] = [];
    const a = member(group, log, 'a');
    const b = member(group, log, 'b');

    a.open();
    b.close();
    expect(a.isOpen()).toBe(true);
    expect(log).toEqual(['a:open']);

    a.close();
    expect(group.openIndex()).toBe(-1);
    expect(log).toEqual(['a:open', 'a:closed']);
  });

  it('closes whatever is open, and stays quiet when nothing is', () => {
    const group = createMenuGroup();
    const log: string[] = [];
    const a = member(group, log, 'a');

    group.closeAll();
    expect(log).toEqual([]);

    a.open();
    group.closeAll();
    expect(a.isOpen()).toBe(false);
    expect(log).toEqual(['a:open', 'a:closed']);
  });

  it('keeps separate groups independent', () => {
    const first = createMenuGroup();
    const second = createMenuGroup();
    const log: string[] = [];
    const a = member(first, log, 'a');
    const b = member(second, log, 'b');

    a.open();
    b.open();

    expect(a.isOpen()).toBe(true);
    expect(b.isOpen()).toBe(true);
  });
});
