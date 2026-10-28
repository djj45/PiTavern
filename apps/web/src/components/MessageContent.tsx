import React, { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: { ...defaultSchema.attributes, details: ["open"] },
};
const remarkPlugins = [remarkGfm];
const rehypePlugins: import("unified").PluggableList = [rehypeRaw, [rehypeSanitize, schema]];

/** Render only; the original message and model context never contain rendered HTML. */
export const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  return <div className="tavern-markdown">
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={{
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      img: ({ node: _node, ...props }) => <img {...props} loading="lazy" referrerPolicy="no-referrer" />,
      table: ({ node: _node, ...props }) => <div className="markdown-table-scroll"><table {...props} /></div>,
    }}>{text}</Markdown>
  </div>;
});
