export function buildPromptWithImageAttachments(prompt: string, imagePaths: string[]): string {
  const trimmedPrompt = prompt.trim();
  if (imagePaths.length === 0) {
    return trimmedPrompt;
  }

  const body = trimmedPrompt || "Please inspect the attached image(s).";
  const attachmentList = imagePaths.map((path) => `- ${path}`).join("\n");
  return `${body}\n\nAttached image file${imagePaths.length === 1 ? "" : "s"}:\n${attachmentList}`;
}
