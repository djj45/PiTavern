import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageContent } from "../src/components/MessageContent.tsx";
import { displayMessage } from "../src/messageDisplay.ts";

const render = (text: string) => renderToStaticMarkup(<MessageContent text={text} />);
const ticks = String.fromCharCode(96).repeat(3);
const html = render([
  "# 标题", "", "**粗体** 和 *斜体*", "", "- 列表", "", "> 引用", "",
  "| 名称 | 值 |", "| --- | --- |", "| 金币 | 10 |", "", ticks + "js", "const x = '<tag>';", ticks, "",
  "<details><summary>查看详情</summary>安全内容</details>", "", "[链接](https://example.com)",
].join("\n"));
for (const tag of ["h1", "strong", "em", "ul", "blockquote", "table", "pre", "code", "details", "summary"]) {
  assert.match(html, new RegExp("<" + tag + "[ >]"), "应渲染 " + tag);
}
assert.ok(html.includes("&lt;tag&gt;"));
assert.ok(html.includes('rel="noopener noreferrer"'));
const unsafe = render('<script>globalThis.pwned=1</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">危险链接</a><iframe srcdoc="x"></iframe><div style="position:fixed">文本</div>');
assert.doesNotMatch(unsafe, /<script|onerror|javascript:|<iframe|style=/i);
assert.ok(unsafe.includes("危险链接") && unsafe.includes("文本"));
assert.doesNotThrow(() => render("**尚未结束的流式内容\n\n" + ticks + "js\nconst x = 1"));
assert.doesNotThrow(() => render("<details><summary>尚未结束"));
assert.ok(render("第一行\n第二行").includes("第一行\n第二行"));
console.log("✓ Markdown 表格、代码、折叠、链接、换行、未完成流式内容与 HTML 安全过滤");

const displayed = displayMessage("[details]旅馆有三层[/details]", 2, 0, { char: "向导", user: "旅人", scripts: [{
  findRegex: "/\\[details\\]([\\s\\S]*?)\\[\\/details\\]/g", replaceString: "<details><summary>场景资料</summary>$1</details>",
  placement: [2], markdownOnly: true,
}] });
assert.match(render(displayed), /<details><summary>场景资料<\/summary>旅馆有三层<\/details>/);
assert.match(render(displayMessage("[details]未完成", 2, 0)), /未完成/);
console.log("✓ 显示层替换先于 Markdown，折叠布局及未完成内容可渲染");
