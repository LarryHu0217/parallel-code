export function hasNewTaskDraft(prompt: string, name: string): boolean {
  return prompt.trim().length > 0 || name.trim().length > 0;
}
