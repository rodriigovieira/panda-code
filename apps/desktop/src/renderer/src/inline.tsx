import type { ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";

// Inline markdown rendering (bold / italic / code / strikethrough / links).
//
// This used to be a hand-rolled regex split. That approach leaked the literal
// markers whenever a span contained (or was preceded by) a stray asterisk —
// e.g. a glob like `*.ts` desynced `**bold**` pairing for the rest of the
// paragraph. We now lean on marked's CommonMark-compliant inline lexer and walk
// its typed token tree into React nodes. Nothing is passed through
// dangerouslySetInnerHTML: text/html tokens render as plain strings, so React
// escapes them and there is no injection surface.

function renderTokens(tokens: Token[] | undefined, keyPrefix: string): ReactNode {
  if (!tokens) {
    return null;
  }
  return tokens.map((token, index) => renderToken(token, `${keyPrefix}:${index}`));
}

function renderToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "strong":
      return <strong key={key}>{renderTokens(token.tokens, key)}</strong>;

    case "em":
      return <em key={key}>{renderTokens(token.tokens, key)}</em>;

    case "del":
      return <del key={key}>{renderTokens(token.tokens, key)}</del>;

    case "codespan":
      return <code key={key}>{(token as Tokens.Codespan).text}</code>;

    case "br":
      return <br key={key} />;

    case "link": {
      const link = token as Tokens.Link;
      return (
        <a href={link.href} key={key} rel="noreferrer" target="_blank">
          {renderTokens(link.tokens, key)}
        </a>
      );
    }

    case "image": {
      const image = token as Tokens.Image;
      // Render the alt text rather than fetching arbitrary remote URLs inline.
      return <span key={key}>{image.text}</span>;
    }

    // text / escape / html and any tokenizer we don't special-case: render the
    // child tokens if present (GFM text can nest), otherwise the raw string.
    default: {
      const nested = (token as { tokens?: Token[] }).tokens;
      if (nested && nested.length > 0) {
        return renderTokens(nested, key);
      }
      return (token as { text?: string }).text ?? "";
    }
  }
}

export function renderInline(value: string): ReactNode {
  return renderTokens(Lexer.lexInline(value), "inline");
}
