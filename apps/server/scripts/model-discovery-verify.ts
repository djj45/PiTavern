/** Isolated model discovery checks against a local synthetic provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ModelDiscoveryRequest } from "@pitavern/shared";

const root = path.resolve(import.meta.dirname, "../../..");
fs.mkdirSync(path.join(root, "data/test-runs"), { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, "data/test-runs/model-discovery-"));
process.env.PITAVERN_CONFIG = path.join(runDir, "config.json");
const { defaultConfig, seedDataDirs, saveConfig } = await import("../src/config.ts");
const { discoverModels } = await import("../src/providers/discovery.ts");
const { buildModels } = await import("../src/providers/models.ts");
const { CharacterStore } = await import("../src/stdata/characters.ts");
const { ChatStore } = await import("../src/stdata/chats.ts");
const { SessionManager } = await import("../src/session/manager.ts");
const { createHttpApp } = await import("../src/api/http.ts");
const requests: { method: string; url: string; credential: string }[] = [];
let mode = "normal";
const mock = http.createServer((req, res) => {
  const record = { method: req.method!, url: req.url!, credential: req.headers.authorization === "Bearer synthetic-saved" ? "saved"
    : req.headers.authorization === "Bearer synthetic-draft" ? "draft" : req.headers.authorization ? "other" : "none" };
  requests.push(record);
  fs.appendFileSync(path.join(runDir, "requests.ndjson"), JSON.stringify(record) + "\n");
  if (mode === "wait-headers") return;
  if (mode.startsWith("http-")) { res.writeHead(Number(mode.slice(5))); res.end("Provider unavailable"); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  if (mode === "wait-body") { res.flushHeaders(); return; }
  if (mode === "bad-json") { res.end("not JSON"); return; }
  if (mode === "oversize") { res.end(" ".repeat(2 * 1024 * 1024 + 1)); return; }
  const payload = mode === "empty" ? { data: [] } : mode === "wrong-shape" ? { models: [] }
    : mode === "invalid-entries" ? { data: [{ id: "" }, null, { id: 12 }] }
    : mode === "too-many" ? { data: Array.from({ length: 10_001 }, (_, i) => ({ id: "m" + i })) }
    : { object: "list", data: [{ id: "z-model", context_length: 32768 }, { id: "a-model", name: "合成模型" },
      { id: "a-model", name: "重复条目" }, { id: " fixture " }, null, { id: 42 }, { id: "" }] };
  res.end(JSON.stringify(payload));
});
mock.listen(0, "127.0.0.1"); await once(mock, "listening");
const origin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
const config = defaultConfig();
config.stDataDir = path.join(runDir, "st"); seedDataDirs(config.stDataDir);
config.providers = [{ id: "local", name: "本地合成连接", baseUrl: origin + "/v1", apiKey: "synthetic-saved",
  models: [{ id: "fixture", name: "已配置模型", contextWindow: 8000, maxTokens: 500, tokenizer: "estimate" }] }];
config.defaultProvider = "local"; config.defaultModel = "fixture";
saveConfig(config);
const characters = new CharacterStore(path.join(config.stDataDir, "characters"));
const chats = new ChatStore(config.stDataDir);
const modelsRef = { current: buildModels(config) };
const originalModels = modelsRef.current;
const sessions = new SessionManager(config, () => modelsRef.current, characters, chats, config.stDataDir);
const server = http.createServer(createHttpApp({ config, modelsRef, characters, chats, sessions, stDataDir: config.stDataDir, webDistDir: null }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = async (body: unknown) => {
  const response = await fetch(appUrl + "/api/connection/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const draft: ModelDiscoveryRequest = { providerId: "local", baseUrl: origin + "/v1/", apiKey: "" };
const before = JSON.stringify(config);
const diskBefore = fs.readFileSync(process.env.PITAVERN_CONFIG, "utf8");
const checks: string[] = [];
const passed = (message: string) => { checks.push(message); console.log("✓ " + message); };
try {
  const result = await post(draft);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.models, [{ id: "a-model", name: "合成模型" }, { id: "fixture", name: "fixture" }, { id: "z-model", name: "z-model" }]);
  assert.deepEqual(requests.at(-1), { method: "GET", url: "/v1/models", credential: "saved" });
  passed("标准模型列表、去重排序、名称与 ID、保留接口前缀及已保存密钥");

  assert.equal((await post({ ...draft, apiKey: "synthetic-draft" })).status, 200);
  assert.equal(requests.at(-1)?.credential, "draft");
  assert.equal((await post({ ...draft, baseUrl: origin + "/custom/prefix", apiKey: "synthetic-draft" })).status, 200);
  assert.equal(requests.at(-1)?.url, "/custom/prefix/models");
  assert.equal((await post({ providerId: "new", baseUrl: origin + "/anonymous" })).status, 200);
  assert.equal(requests.at(-1)?.credential, "none");
  const beforeInvalid = requests.length;
  assert.equal((await post({ ...draft, baseUrl: origin + "/changed" })).status, 400);
  for (const body of [{}, { baseUrl: "https://" }, { ...draft, apiKey: 12 }]) assert.equal((await post(body)).status, 400);
  assert.equal(requests.length, beforeInvalid);
  passed("草稿地址和密钥、匿名本地服务、地址变更时需重新填写密钥、输入校验");

  mode = "empty"; assert.deepEqual((await post(draft)).body, { models: [] });
  for (const failedMode of ["bad-json", "wrong-shape", "invalid-entries", "oversize", "too-many"]) {
    mode = failedMode;
    const failure = await post(draft);
    assert.equal(failure.status, 502, failedMode);
    assert.equal(typeof failure.body.error, "string");
  }
  for (const status of [401, 403, 404, 405, 429, 503]) {
    mode = "http-" + status;
    const failure = await post(draft);
    assert.equal(failure.status, 502);
    assert.match(failure.body.error, new RegExp("HTTP " + status));
  }
  passed("空列表、格式不兼容、列表容量限制与上游错误提示");

  for (const slowMode of ["wait-headers", "wait-body"]) {
    mode = slowMode;
    await assert.rejects(discoverModels(config.providers, draft, { timeoutMs: 150 }), /超时/);
  }
  mode = "wait-body";
  const abort = new AbortController();
  const beforeCancel = requests.length;
  const pending = discoverModels(config.providers, draft, { signal: abort.signal });
  const rejected = assert.rejects(pending, /取消/);
  const deadline = Date.now() + 5000;
  while (requests.length === beforeCancel) {
    assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 10));
  }
  abort.abort(); await rejected;
  passed("响应头与响应体超时、请求取消");

  assert.equal(JSON.stringify(config), before);
  assert.equal(fs.readFileSync(process.env.PITAVERN_CONFIG, "utf8"), diskBefore);
  assert.equal(modelsRef.current, originalModels);
  const dto = await (await fetch(appUrl + "/api/connection")).json() as any;
  assert.equal(dto.defaultModel, "fixture");
  assert.equal(dto.providers[0].models[0].contextWindow, 8000);
  assert.equal(dto.providers[0].apiKey, undefined);
  passed("获取列表不修改配置文件、默认模型、模型参数或运行时注册");

  const patch = (body: unknown) => fetch(appUrl + "/api/connection/model", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await patch({ providerId: "local", modelId: "fixture", thinkingLevel: "high" })).status, 200);
  const patchDto = await (await fetch(appUrl + "/api/connection")).json() as any;
  assert.equal(patchDto.providers[0].models[0].thinkingLevel, "high");
  assert.equal(patchDto.providers[0].models[0].reasoning, true);
  const patchDisk = JSON.parse(fs.readFileSync(process.env.PITAVERN_CONFIG!, "utf8"));
  assert.equal(patchDisk.providers[0].models[0].thinkingLevel, "high");
  assert.notEqual(modelsRef.current, originalModels);
  assert.equal((await patch({ providerId: "local", modelId: "fixture", thinkingLevel: "max" })).status, 400);
  assert.equal((await patch({ providerId: "local", modelId: "missing", thinkingLevel: "high" })).status, 404);
  passed("单模型思考等级写入、推理能力同步、配置落盘与无效参数");
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify({ ok: true, checks, requests: requests.length }, null, 2));
  console.log("模型列表验证通过；合成产物保留：" + runDir);
} catch (error) {
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify({ ok: false, checks, error: String(error) }, null, 2));
  throw error;
} finally {
  server.closeAllConnections(); server.close(); mock.closeAllConnections(); mock.close();
}
