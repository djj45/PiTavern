import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialWorldSnapshot, createWorldTemplateRecord } from "../src/world/index.ts";
import { getWorldTemplate, worldTemplateName, worldTemplateSummaries } from "../src/world/catalog.ts";

test("内置世界模板摘要可加载且哈希稳定", () => {
  const summaries = worldTemplateSummaries();
  assert.equal(summaries.length, 2);
  assert.equal(new Set(summaries.map((entry) => entry.id)).size, summaries.length);
  for (const summary of summaries) {
    assert.match(summary.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(summary.name.trim().length > 0);
    assert.ok(summary.locations > 0 && summary.actors > 0);
    assert.equal(worldTemplateName(summary.id), summary.name);
    const template = getWorldTemplate(summary.id);
    assert.ok(template);
    const record = createWorldTemplateRecord(template);
    assert.equal(record.contentHash, summary.contentHash);
    const snapshot = createInitialWorldSnapshot(record);
    assert.equal(snapshot.templateHash, summary.contentHash);
    assert.equal(snapshot.money[template.initial.actorId], template.initial.money);
  }
});

test("未知世界模板不伪造目录项", () => {
  assert.equal(getWorldTemplate("missing-template"), undefined);
  assert.equal(worldTemplateName("missing-template"), "missing-template");
});
