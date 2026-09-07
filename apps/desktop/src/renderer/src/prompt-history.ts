export const PROMPT_HISTORY_COLLAPSED_CHARACTERS = 500;

export function promptHistoryPreview(
  text: string,
  expanded: boolean,
): { text: string; collapsible: boolean } {
  const collapsible = text.length > PROMPT_HISTORY_COLLAPSED_CHARACTERS;
  return {
    text: collapsible && !expanded
      ? text.slice(0, PROMPT_HISTORY_COLLAPSED_CHARACTERS)
      : text,
    collapsible,
  };
}
