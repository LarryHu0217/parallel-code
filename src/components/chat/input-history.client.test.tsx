import { describe, expect, it } from 'vitest';
import { createInputHistory } from './input-history';

function setup(initialEntries: string[], initial = '') {
  const entries = [...initialEntries];
  const state = { draft: initial };
  const history = createInputHistory({
    entries: () => entries,
    draft: () => state.draft,
    onDraft: (text) => (state.draft = text),
  });
  const area = document.createElement('textarea');
  const press = (key: string) => {
    area.value = state.draft;
    area.setSelectionRange(area.value.length, area.value.length);
    let handled = false;
    area.addEventListener('keydown', (e) => (handled = history.onKeyDown(e)), { once: true });
    area.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    return handled;
  };
  return { state, press, entries };
}

describe('createInputHistory', () => {
  it('cycles back through earlier messages and restores the draft', () => {
    const { state, press } = setup(['one', 'two'], 'typing');
    press('ArrowUp');
    expect(state.draft).toBe('two');
    press('ArrowUp');
    expect(state.draft).toBe('one');
    press('ArrowUp');
    expect(state.draft).toBe('one');
    press('ArrowDown');
    press('ArrowDown');
    expect(state.draft).toBe('typing');
    expect(press('ArrowDown')).toBe(false);
  });

  it('leaves the key alone with no history', () => {
    expect(setup([]).press('ArrowUp')).toBe(false);
  });

  it('stops browsing once the user edits the recalled text', () => {
    const { state, press } = setup(['one', 'two']);
    press('ArrowUp');
    state.draft = 'two!';
    expect(press('ArrowDown')).toBe(false);
  });

  it('starts from the newest entry again after a send grows the list', () => {
    const { state, entries, press } = setup(['one']);
    press('ArrowUp');
    entries.push('one');
    state.draft = '';
    press('ArrowUp');
    expect(state.draft).toBe('one');
    press('ArrowUp');
    expect(state.draft).toBe('one');
  });

  it('does not recall while the caret is inside a multi-line draft', () => {
    const { state, press } = setup(['one'], 'a\nb');
    expect(press('ArrowUp')).toBe(false);
    expect(state.draft).toBe('a\nb');
  });
});
