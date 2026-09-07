import { redactBrowserUrl } from "./browser";
const PRIVATE_FIELD = /^(?:token|authorization|password|secret|apiKey|keyBase64|payloadCipher|resultCipher|prompt|preview|body|content|data|output|stdout|stderr|text|question|input)$/i;
export function redactDiagnosticValue(value: unknown, field = ""): unknown {
  if (PRIVATE_FIELD.test(field)) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactDiagnosticValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key, redactDiagnosticValue(item, key)]));
  if (typeof value === "string") {
    const scrubbed = value.replace(/https?:\/\/[^\s<>"']+/g, url => redactBrowserUrl(url));
    return scrubbed.length > 500 ? `${scrubbed.slice(0, 500)}…` : scrubbed;
  }
  return value;
}
