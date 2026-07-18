import { describe, expect, it, vi } from 'vitest';
import { createImportWorktreesCloseHandler } from './import-worktrees-dismiss';

describe('createImportWorktreesCloseHandler', () => {
  it('closes when no import is running', () => {
    const onClose = vi.fn();
    const requestClose = createImportWorktreesCloseHandler(() => false, onClose);

    requestClose();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('blocks dismissal until the running import finishes', () => {
    let importing = true;
    const onClose = vi.fn();
    const requestClose = createImportWorktreesCloseHandler(() => importing, onClose);

    requestClose();
    expect(onClose).not.toHaveBeenCalled();

    importing = false;
    requestClose();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
