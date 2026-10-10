import type { JSX } from 'solid-js';
import { ModelMenu } from './ModelMenu';
import {
  ASK_CODE_CLAUDE_MODELS,
  ASK_CODE_MODELS,
  type AskCodeProvider,
} from '../../electron/shared/ask-code-models';
import { codexModels, loadCodexModels } from '../lib/codex-models';
import { store } from '../store/core';
import { setAskCodeModel, setAskCodeProvider } from '../store/store';
import { askCodeLabel } from './understanding/ask-code-label';
import { defaultAskCodeModel } from '../../electron/shared/ask-code-models';

interface ModelChoice {
  provider: AskCodeProvider;
  /** Undefined for MiniMax, which offers a single model. */
  model?: string;
  label: string;
  /** Shown on hover where the label is a display name, not the slug sent to the CLI. */
  title?: string;
}

interface ModelGroup {
  heading: string;
  choices: ModelChoice[];
  /** Shown in place of the rows when a provider offers nothing. */
  empty?: string;
}

/**
 * The providers in one flat list, so arrow keys walk them in the order shown.
 * Codex models come from its CLI cache, so that group can be empty.
 */
function groups(): ModelGroup[] {
  return [
    {
      heading: 'Claude Code',
      choices: ASK_CODE_CLAUDE_MODELS.map((model) => ({
        provider: 'claude' as const,
        model,
        label: model,
      })),
    },
    {
      heading: 'Codex',
      choices: codexModels().map((model) => ({
        provider: 'codex' as const,
        model: model.slug,
        label: model.displayName,
        title: model.slug,
      })),
      empty: 'No Codex models found',
    },
    {
      heading: 'MiniMax',
      choices: [{ provider: 'minimax', label: ASK_CODE_MODELS.minimax }],
    },
  ];
}

function pick(choice: ModelChoice): void {
  setAskCodeProvider(choice.provider);
  if (choice.model) setAskCodeModel(choice.model);
}

/** Shared model choices and preference for tours, code questions, and new reviewers. */
export function AgentModelMenu(props: {
  style?: JSX.CSSProperties;
  class?: string;
  label?: string;
  disabled?: boolean;
  providers?: AskCodeProvider[];
  provider?: AskCodeProvider;
  onSelect?: (provider: AskCodeProvider) => void;
}) {
  const availableGroups = () =>
    groups().filter(
      (group) =>
        !props.providers ||
        group.choices.some((choice) => props.providers?.includes(choice.provider)),
    );
  const choices = () => availableGroups().flatMap((group) => group.choices);
  const provider = () => props.provider ?? store.askCodeProvider;
  const model = () =>
    provider() === store.askCodeProvider ? store.askCodeModel : defaultAskCodeModel(provider());
  const key = (choice: ModelChoice) => `${choice.provider}:${choice.model ?? ''}`;
  return (
    <ModelMenu
      {...props}
      label={props.label ?? 'Model'}
      title={`Model: ${askCodeLabel(provider(), model())}`}
      value={`${provider()}:${provider() === 'minimax' ? '' : model()}`}
      groups={availableGroups().map((group) => ({
        ...group,
        choices: group.choices.map((choice) => ({ ...choice, value: key(choice) })),
      }))}
      onOpen={loadCodexModels}
      onSelect={(value) => {
        const choice = choices().find((choice) => key(choice) === value);
        if (choice) {
          pick(choice);
          props.onSelect?.(choice.provider);
        }
      }}
    />
  );
}
