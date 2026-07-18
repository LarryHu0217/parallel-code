export function createImportWorktreesCloseHandler(
  isImporting: () => boolean,
  onClose: () => void,
): () => void {
  return () => {
    if (!isImporting()) onClose();
  };
}
