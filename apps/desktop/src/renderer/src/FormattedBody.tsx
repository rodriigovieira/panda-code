import { Bell } from "lucide-react";
import { useMemo } from "react";
import type { ReactElement } from "react";
import { parseBodyBlocks } from "./formatting";
import { renderInline } from "./inline";

/**
 * Markdown text, rendered.
 *
 * This lived inside App.tsx while the transcript was the only thing in the app
 * made of prose. Backlog cards are the second: agents write descriptions with
 * headings and bullet lists, and a card that showed them as literal `-` and `##`
 * was asking the reader to parse Markdown by eye. Same parser, same block
 * vocabulary, same CSS — so a list looks like a list wherever it is written.
 *
 * Nothing here uses dangerouslySetInnerHTML: `renderInline` walks marked's token
 * tree into React nodes, so text and html tokens land as escaped strings.
 */
export function FormattedBody({ value }: { value: string }): ReactElement {
  const blocks = useMemo(() => parseBodyBlocks(value), [value]);
  return (
    <div className="formatted-body">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre className="formatted-code" key={`code:${index}`}>
              {block.language ? <span className="formatted-code-language">{block.language}</span> : null}
              <code>{block.code}</code>
            </pre>
          );
        }

        if (block.type === "task-notification") {
          return (
            <section className="task-notification-card" key={`task-notification:${index}`}>
              <div className="task-notification-kicker">
                <span className="task-notification-icon">
                  <Bell size={13} aria-hidden="true" />
                </span>
                <strong>Task notification</strong>
                {block.taskId ? <code>{block.taskId}</code> : null}
              </div>
              {block.summary ? <p className="task-notification-summary">{renderInline(block.summary)}</p> : null}
              {block.event ? <p className="task-notification-event">{renderInline(block.event)}</p> : null}
            </section>
          );
        }

        if (block.type === "table") {
          return (
            <div className="formatted-table-shell" key={`table:${index}`}>
              <table className="formatted-table">
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`${header}:${headerIndex}`}>{renderInline(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`row:${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`${cell}:${cellIndex}`}>{renderInline(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === "quote") {
          return (
            <blockquote key={`quote:${index}`}>
              <FormattedBody value={block.text} />
            </blockquote>
          );
        }

        if (block.type === "rule") {
          return <hr key={`rule:${index}`} />;
        }

        if (block.type === "heading") {
          const Heading = `h${block.level}` as const;
          return <Heading key={`heading:${index}`}>{renderInline(block.text)}</Heading>;
        }

        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={`list:${index}`}>
              {block.items.map((item, itemIndex) => (
                <li className={item.checked === undefined ? undefined : "task-list-item"} key={`${item.text}:${itemIndex}`}>
                  {item.checked === undefined ? null : (
                    <input checked={item.checked} disabled readOnly type="checkbox" aria-label={item.checked ? "Completed" : "Incomplete"} />
                  )}
                  <span>{renderInline(item.text)}</span>
                </li>
              ))}
            </ListTag>
          );
        }

        return <p key={`paragraph:${index}`}>{renderInline(block.text)}</p>;
      })}
    </div>
  );
}
