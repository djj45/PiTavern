import React, { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { DialoguePairDto } from "@pitavern/shared";

const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: { ...defaultSchema.attributes, details: ["open"] },
};
const remarkPlugins = [remarkGfm];
const rehypePlugins: import("unified").PluggableList = [rehypeRaw, [rehypeSanitize, schema]];

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function splitDialogue(value: string, pairs: DialoguePairDto[]): { text: string; pair?: DialoguePairDto }[] {
  const usable = pairs.filter((pair) => pair.open && pair.close && pair.open !== pair.close);
  if (!usable.length || !value) return [{ text: value }];
  const segments: { text: string; pair?: DialoguePairDto }[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    let best: { index: number; pair: DialoguePairDto } | undefined;
    for (const pair of usable) {
      const index = value.indexOf(pair.open, cursor);
      if (index >= 0 && (!best || index < best.index)) best = { index, pair };
    }
    if (!best) break;
    const close = value.indexOf(best.pair.close, best.index + best.pair.open.length);
    if (close < 0) break;
    if (best.index > cursor) segments.push({ text: value.slice(cursor, best.index) });
    segments.push({ text: value.slice(best.index, close + best.pair.close.length), pair: best.pair });
    cursor = close + best.pair.close.length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor) });
  return segments;
}

/** 在 sanitize 之后给对白文本包一层 span；只加类名，颜色由气泡上的 CSS 变量控制。 */
function rehypeDialogue(pairs: DialoguePairDto[]) {
  return () => (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (node.type === "element" && (node.tagName === "code" || node.tagName === "pre" || node.tagName === "a")) return;
      if (!Array.isArray(node.children)) return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string") {
          for (const segment of splitDialogue(child.value, pairs)) {
            if (segment.pair) {
              const color = segment.pair.color && /^#[0-9a-f]{6}$/i.test(segment.pair.color) ? segment.pair.color : "";
              next.push({ type: "element", tagName: "span",
                properties: { className: ["tavern-dialogue"], ...(color ? { style: "color: " + color } : {}) },
                children: [{ type: "text", value: segment.text }] });
            } else {
              next.push({ type: "text", value: segment.text });
            }
          }
        } else {
          visit(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    visit(tree);
  };
}

/** Render only; the original message and model context never contain rendered HTML. */
export const MessageContent = memo(function MessageContent({ text, dialoguePairs }: {
  text: string;
  dialoguePairs?: DialoguePairDto[];
}) {
  const plugins = dialoguePairs?.length ? [...rehypePlugins, rehypeDialogue(dialoguePairs)] : rehypePlugins;
  return <div className="tavern-markdown">
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={plugins} components={{
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      img: ({ node: _node, ...props }) => <img {...props} loading="lazy" referrerPolicy="no-referrer" />,
      table: ({ node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props} /></div>,
    }}>{text}</Markdown>
  </div>;
});
