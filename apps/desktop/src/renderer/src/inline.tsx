import { createContext, useContext, useState, type ReactElement, type ReactNode } from "react";
import { ImageOff, Play } from "lucide-react";
import { Lexer, type Token, type Tokens } from "marked";
import {
  localFileUrl,
  localMediaPath,
  mediaFileName,
  mediaKindForPath,
  openMediaPreview,
  type MediaKind,
} from "./media";
import { localDocPath, openDocument } from "./documents";

// Inline markdown rendering (bold / italic / code / strikethrough / links).
//
// This used to be a hand-rolled regex split. That approach leaked the literal
// markers whenever a span contained (or was preceded by) a stray asterisk —
// e.g. a glob like `*.ts` desynced `**bold**` pairing for the rest of the
// paragraph. We now lean on marked's CommonMark-compliant inline lexer and walk
// its typed token tree into React nodes. Nothing is passed through
// dangerouslySetInnerHTML: text/html tokens render as plain strings, so React
// escapes them and there is no injection surface.

/**
 * `panda://backlog/<id>` is the one link scheme that means "somewhere in this
 * app" instead of "somewhere on the web": agents write it when they mention a
 * card, and clicking it opens the board with that card's editor already up.
 * The id may be a prefix — agents quote the short form of a uuid in prose.
 */
export const BACKLOG_LINK_PREFIX = "panda://backlog/";
export const OPEN_BACKLOG_ITEM_EVENT = "panda:open-backlog-item";

export function backlogLinkId(href: string): string | null {
  if (!href.startsWith(BACKLOG_LINK_PREFIX)) {
    return null;
  }
  const id = href.slice(BACKLOG_LINK_PREFIX.length).trim();
  // `#12` / `12` (a card number, the form everything now writes) or a uuid, in
  // full or in the prefix form agents used to quote.
  return /^#?\d{1,6}$/.test(id) || /^[0-9a-fA-F-]{4,}$/.test(id) ? id : null;
}

/**
 * The card numbers of the workspace on screen, so `#12` in prose can become a
 * link to `#12` on the board.
 *
 * A context rather than a prop because the text that mentions a card is nested
 * six components deep in a transcript, and because *not* knowing the board is
 * the important case: `#42` in a sentence about a pull request is far more
 * common than a card by that number, and a link that leads nowhere is worse
 * than plain text. Only numbers that are actually on this workspace's board
 * light up. Empty by default, so anything rendering outside a workspace (a
 * test, a settings pane) simply gets text.
 */
export type BacklogCardIndex = ReadonlyMap<number, { id: string; title: string }>;

export const BacklogCardsContext = createContext<BacklogCardIndex>(new Map());

function openBacklogItem(id: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_BACKLOG_ITEM_EVENT, { detail: { id } }));
}

/** A bare `#12` in prose. Renders as text unless the board has a card by that number. */
function CardRefLink({ number }: { number: number }): ReactElement {
  const cards = useContext(BacklogCardsContext);
  const card = cards.get(number);
  if (!card) {
    return <>{`#${number}`}</>;
  }
  return (
    <a
      className="inline-app-link inline-card-ref"
      href={`${BACKLOG_LINK_PREFIX}${number}`}
      title={card.title}
      onClick={(event) => {
        event.preventDefault();
        openBacklogItem(card.id);
      }}
    >
      {`#${number}`}
    </a>
  );
}

/**
 * Split plain text on card references.
 *
 * Four digits at most, and nothing word-like on either side, so `#ff0000` and
 * `#123456` (a colour) and `word#3` stay text. A board that ever reaches five
 * digits has bigger problems than an unlinked reference.
 */
const CARD_REF_PATTERN = /(?<![\w#])#(\d{1,4})(?![\w-])/g;

/**
 * `![caption](/Users/example/…/Application Support/…/shot.png)` — an image whose path
 * contains a space, written without the angle brackets CommonMark requires.
 *
 * The lexer does not see an image there at all; the whole thing stays one text
 * token and the user reads the markup instead of seeing the picture. And this is
 * the *common* case, not an edge one: the two directories agents screenshot into
 * are `Application Support/Panda Code/…` and macOS's own
 * `Screenshot 2026-08-12 at 02.52.35.png`. Rather than lose the evidence to a
 * syntax rule, recover it here.
 *
 * Only an absolute path qualifies, and `<`, `>`, `(`, `)` and `"` in the
 * destination disqualify it — a title argument or a nested paren is beyond what
 * this is for, and `localMediaPath` still has the final say on whether the file
 * is ours to load. Code spans are lexed before this runs, so a path quoted as
 * `` `![a](/x y.png)` `` stays literal.
 */
const UNBRACKETED_IMAGE_PATTERN = /!\[([^\]]*)\]\((\/[^()<>"\n]*\s[^()<>"\n]*)\)/g;

function renderText(text: string, key: string): ReactNode {
  if (text.includes("![")) {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of text.matchAll(UNBRACKETED_IMAGE_PATTERN)) {
      const at = match.index ?? 0;
      const path = localMediaPath(match[2] ?? "");
      const kind = path ? mediaKindForPath(path) : null;
      if (!path || !kind) {
        continue;
      }
      if (at > last) {
        parts.push(renderText(text.slice(last, at), `${key}:t${at}`));
      }
      parts.push(<InlineMedia caption={match[1] ?? ""} key={`${key}:img${at}`} kind={kind} path={path} />);
      last = at + match[0].length;
    }
    if (parts.length > 0) {
      parts.push(renderText(text.slice(last), `${key}:tail`));
      return parts;
    }
  }
  if (!text.includes("#")) {
    return text;
  }
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CARD_REF_PATTERN)) {
    const at = match.index ?? 0;
    if (at > last) {
      parts.push(text.slice(last, at));
    }
    parts.push(<CardRefLink key={`${key}:#${at}`} number={Number(match[1])} />);
    last = at + match[0].length;
  }
  if (parts.length === 0) {
    return text;
  }
  parts.push(text.slice(last));
  return parts;
}

/**
 * A picture or a recording an agent put in its own message.
 *
 * `![what it shows](/Users/example/…/shot.png)` — the ordinary Markdown image, pointed
 * at a file on this Mac. It is how an agent shows evidence instead of asserting
 * it: the screenshot of the page it checked, the mp4 `browser_record` handed
 * back. Rendered as a thumbnail that opens the same full-size viewer the user's
 * own attachments use, so both halves of a conversation show pictures the same
 * way.
 *
 * A path can be wrong or the file can be gone by the time the transcript is
 * re-read — screenshots live in temp directories. That case gets a labelled
 * chip rather than a broken-image glyph, because the caption is usually the
 * only remaining record of what was there.
 */
function InlineMedia({ path, kind, caption }: { path: string; kind: MediaKind; caption: string }): ReactElement {
  const [failed, setFailed] = useState(false);
  const name = mediaFileName(path);
  const label = caption.trim() || name;

  if (failed) {
    return (
      <span className="inline-media-missing" title={path}>
        <ImageOff size={12} aria-hidden="true" />
        {label}
      </span>
    );
  }

  return (
    <button
      className="inline-media"
      type="button"
      title={caption.trim() ? `${caption.trim()} — ${path}` : path}
      onClick={() => openMediaPreview({ path, kind })}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.claudeSections?.showAttachmentContextMenu(path);
      }}
    >
      <span className="inline-media-frame">
        {kind === "image" ? (
          <img alt={label} src={localFileUrl(path)} onError={() => setFailed(true)} />
        ) : (
          <>
            {/* `#t=0.1` seeks just past the start: `preload="metadata"` reads the
                duration but decodes no frame, so the tile would be blank grey. */}
            <video muted playsInline preload="metadata" src={`${localFileUrl(path)}#t=0.1`} onError={() => setFailed(true)} />
            <span className="inline-media-play" aria-hidden="true">
              <Play size={16} fill="currentColor" />
            </span>
          </>
        )}
      </span>
      <span className="inline-media-caption">{label}</span>
    </button>
  );
}

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
      const backlogId = backlogLinkId(link.href);
      if (backlogId) {
        // In-app destination, not a URL: open the board on that card rather than
        // handing `panda://` to the OS, which has nothing registered for it.
        return (
          <a
            className="inline-app-link"
            href={link.href}
            key={key}
            onClick={(event) => {
              event.preventDefault();
              openBacklogItem(backlogId);
            }}
          >
            {renderTokens(link.tokens, key)}
          </a>
        );
      }
      const mediaPath = localMediaPath(link.href);
      const mediaKind = mediaPath ? mediaKindForPath(mediaPath) : null;
      if (mediaPath && mediaKind) {
        // Agents often describe a capture with an ordinary text link instead
        // of image syntax: `[five-second pilot](/tmp/pilot.mp4)`. Keep the
        // compact linked label in the transcript, but open it in the same
        // in-app lightbox as an inline thumbnail. Handing the file URL to
        // Chromium opened a separate blank-looking page and skipped the video
        // player's global keyboard controls.
        return (
          <a
            className="inline-app-link inline-media-link"
            href={link.href}
            key={key}
            title={mediaPath}
            onClick={(event) => {
              event.preventDefault();
              openMediaPreview({ path: mediaPath, kind: mediaKind });
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              void window.claudeSections?.showAttachmentContextMenu(mediaPath);
            }}
          >
            {renderTokens(link.tokens, key)}
          </a>
        );
      }
      const docPath = localDocPath(link.href);
      if (docPath) {
        // A local document — most often one the agent just wrote and linked to.
        // Opening it in the app's reader beats handing a `file://` URL to the
        // browser, which would show the Markdown source at best.
        return (
          <a
            className="inline-app-link"
            href={link.href}
            key={key}
            title={docPath}
            onClick={(event) => {
              event.preventDefault();
              openDocument({ path: docPath });
            }}
          >
            {renderTokens(link.tokens, key)}
          </a>
        );
      }
      return (
        <a href={link.href} key={key} rel="noreferrer" target="_blank">
          {renderTokens(link.tokens, key)}
        </a>
      );
    }

    case "image": {
      const image = token as Tokens.Image;
      const path = localMediaPath(image.href);
      const kind = path ? mediaKindForPath(path) : null;
      if (!path || !kind) {
        // A remote URL, or a file we cannot show: render the alt text rather
        // than fetching arbitrary things an agent typed.
        return <span key={key}>{image.text}</span>;
      }
      return <InlineMedia caption={image.text} key={key} kind={kind} path={path} />;
    }

    // text / escape / html and any tokenizer we don't special-case: render the
    // child tokens if present (GFM text can nest), otherwise the raw string —
    // which is the only place a bare `#12` can appear, since a code span or a
    // link's href has already been claimed above.
    default: {
      const nested = (token as { tokens?: Token[] }).tokens;
      if (nested && nested.length > 0) {
        return renderTokens(nested, key);
      }
      return renderText((token as { text?: string }).text ?? "", key);
    }
  }
}

export function renderInline(value: string): ReactNode {
  return renderTokens(Lexer.lexInline(value), "inline");
}
