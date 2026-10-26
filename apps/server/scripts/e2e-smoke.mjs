#!/usr/bin/env node
/**
 * M1 端到端冒烟：mock 中转 + PiTavern 服务 + WS 客户端完整走一遍。
 * 验收：状态接口 → 无配置提示 → 写入连接 → 造卡 → 建聊天 → WS 流式往返 → JSONL 落库。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(ROOT, "data/e2e-test");
const CONFIG = path.join(ROOT, "data/e2e-config.json");

function cleanup() {
  for (const p of [DATA_DIR, CONFIG]) fs.rmSync(p, { recursive: true, force: true });
}
cleanup();

function waitProcess(child, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 启动超时`)), 20000);
    const onData = (data) => {
      if (String(data).includes(label)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`${label} 进程退出: ${code}`)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 最小合法 1x1 PNG + tEXt(chara) 角色卡
function buildTestCardPng(name) {
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const card = { spec: "chara_card_v2", spec_version: "2.0", data: { name, description: `${name} 是测试用酒馆看板娘。`, personality: "温柔", scenario: "深夜酒馆", first_mes: "欢迎光临，请随便坐。", mes_example: "" } };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const idat = zlib.deflateSync(Buffer.from([0, 212, 162, 78]));
  const text = Buffer.concat([Buffer.from("chara", "latin1"), Buffer.alloc(1), Buffer.from(b64(JSON.stringify(card)), "latin1")]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("tEXt", text),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const mock = spawn("node", ["scripts/mock-relay.mjs"], { cwd: path.join(ROOT, "apps/server"), stdio: "pipe" });

// 预写配置（stDataDir 必须在启动前给定：CharacterStore 启动时锁定目录）
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
fs.writeFileSync(
  CONFIG,
  JSON.stringify(
    {
      port: PORT,
      stDataDir: DATA_DIR,
      providers: [
        {
          id: "mock",
          name: "Mock",
          baseUrl: "http://127.0.0.1:18789/v1",
          apiKey: "sk-test",
          models: [{ id: "mock-rp", name: "Mock RP" }],
        },
      ],
      defaultProvider: "mock",
      defaultModel: "mock-rp",
      persona: { name: "测试员", description: "" },
    },
    null,
    2,
  ),
);

const server = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: path.join(ROOT, "apps/server"),
  stdio: "pipe",
  env: { ...process.env, PORT: String(PORT), PITAVERN_CONFIG: CONFIG },
});

try {
  await waitProcess(mock, "mock 中转已启动");
  await waitProcess(server, "PiTavern 服务已启动");

  // 1. 状态
  let res = await fetch(`${BASE}/api/status`);
  assert.equal(res.status, 200);
  console.log("✓ /api/status");

  // 2. 初始配置（预写的 mock 连接应已生效）
  res = await fetch(`${BASE}/api/connection`);
  const conn = await res.json();
  assert.equal(conn.providers.length, 1);
  assert.equal(conn.providers[0].hasApiKey, true);
  assert.equal(conn.defaultModel, "mock-rp");
  assert.equal(conn.persona.name, "测试员");
  console.log("✓ /api/connection 初始（apiKey 已脱敏）");

  // 3. 局部 PUT 不清空 providers
  res = await fetch(`${BASE}/api/connection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-rp" }),
  });
  assert.ok((await res.json()).ok);
  res = await fetch(`${BASE}/api/connection`);
  assert.equal((await res.json()).providers.length, 1);
  console.log("✓ PUT /api/connection 局部更新");

  // 4. 放卡（server 启动时已播种目录）
  fs.mkdirSync(path.join(DATA_DIR, "characters"), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "characters", "测试看板娘.png"), buildTestCardPng("测试看板娘"));
  const cardsDir = path.join(DATA_DIR, "characters");
  fs.writeFileSync(path.join(cardsDir, "测试看板娘.png"), buildTestCardPng("测试看板娘"));
  res = await fetch(`${BASE}/api/characters`);
  const characters = await res.json();
  assert.equal(characters.length, 1);
  assert.equal(characters[0].name, "测试看板娘");
  assert.ok(characters[0].firstMes.includes("欢迎光临"));
  console.log("✓ PNG 人物卡解析");

  // 4.5 头像可访问
  res = await fetch(`${BASE}/api/characters/${encodeURIComponent("测试看板娘")}/avatar`);
  assert.equal(res.status, 200);
  const avatarBytes = Buffer.from(await res.arrayBuffer());
  assert.ok(avatarBytes.subarray(1, 4).toString("latin1") === "PNG");
  console.log("✓ 头像接口");

  // 5. 建聊天（含开场白）
  res = await fetch(`${BASE}/api/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ character: "测试看板娘" }),
  });
  const { id: chatId } = await res.json();
  assert.ok(chatId.endsWith(".jsonl"));
  res = await fetch(`${BASE}/api/chats/${chatId.split("/").map(encodeURIComponent).join("/")}`);
  const chat = await res.json();
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].role, "assistant");
  console.log("✓ 新建聊天 + 开场白");

  // 6. WS 流式往返
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
  ws.on("message", (raw) => events.push(JSON.parse(String(raw))));
  ws.send(JSON.stringify({ type: "chat.send", chatId, text: "来一杯热的。" }));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === "chat.done")) break;
    if (events.some((e) => e.type === "chat.error")) throw new Error(`chat.error: ${events.find((e) => e.type === "chat.error").message}`);
    await sleep(100);
  }
  const done = events.find((e) => e.type === "chat.done");
  assert.ok(done, "应收到 chat.done");
  assert.ok(done.message.text.length > 5, "回复应有内容");
  assert.ok(events.some((e) => e.type === "chat.delta"), "应有流式 delta");
  assert.ok(events.some((e) => e.type === "chat.usage"), "应有 usage 统计");
  console.log(`✓ WS 流式往返（${events.filter((e) => e.type === "chat.delta").length} 个 delta）`);
  ws.close();

  // 7. 落库校验
  const lines = fs.readFileSync(path.join(DATA_DIR, chatId), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[1].is_user, true);
  assert.equal(lines[1].name, "测试员");
  assert.equal(lines[2].is_user, false);
  console.log("✓ JSONL 落库（3 行：开场白 + 用户 + 助手）");

  // 8. 桥接模式全链路：迷你 ST 预设 + 世界书 + 提示词正则
  const presetDir = path.join(DATA_DIR, "OpenAI Settings");
  fs.mkdirSync(presetDir, { recursive: true });
  fs.writeFileSync(
    path.join(presetDir, "e2e桥接.json"),
    JSON.stringify({
      temperature: 0.7,
      top_p: 0.9,
      openai_max_tokens: 2048,
      prompts: [
        { identifier: "main", name: "Main", role: "system", content: "你是 {{char}}，与 {{user}} 演绎故事。" },
        { identifier: "worldInfoBefore", name: "World Info (before)", role: "system", marker: true, content: "" },
        { identifier: "chatHistory", name: "Chat History", role: "system", marker: true, content: "" },
        { identifier: "absTail", name: "尾部注入", role: "system", content: "|e2e深度注入|", injection_position: 1, injection_depth: 0 },
      ],
      prompt_order: [{ character_id: 100001, order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "absTail", enabled: true },
      ] }],
      extensions: {
        regex_scripts: [{
          scriptName: "去思考", findRegex: "/<think>([\\s\\S]*?)<\\/think>/g", replaceString: "",
          placement: [2], disabled: false, markdownOnly: false, promptOnly: true, minDepth: 1, maxDepth: null,
        }],
      },
    }),
  );
  fs.writeFileSync(
    path.join(DATA_DIR, "worlds", "e2e世界.json"),
    JSON.stringify({ entries: {
      0: { uid: "0", key: [], keysecondary: [], content: "[E2E常驻设定] 月亮是蓝色的。", constant: true, disable: false, order: 10, position: 0 },
      1: { uid: "1", key: ["银剑"], keysecondary: [], content: "[E2E银剑设定] 银剑会鸣响。", constant: false, disable: false, order: 20, position: 0 },
    } }),
  );
  res = await fetch(`${BASE}/api/connection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contextMode: "bridge", activePreset: "e2e桥接", activeWorlds: ["e2e世界"] }),
  });
  assert.ok((await res.json()).ok);

  // 第二轮：先追加一条带 think 标签的助手消息（模拟历史），再发含世界书关键词的用户消息
  fs.appendFileSync(
    path.join(DATA_DIR, chatId),
    `${JSON.stringify({ name: "测试看板娘", is_user: false, is_system: false, send_date: new Date().toISOString(), mes: "<think>客人提到银剑，翻下设定</think>（她眯起眼）银剑？您倒是识货。" })}\n`,
    "utf8",
  );
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => { ws2.on("open", resolve); ws2.on("error", reject); });
  ws2.send(JSON.stringify({ type: "chat.send", chatId, text: "我拔出银剑。" }));
  const deadline2 = Date.now() + 30000;
  const events2 = [];
  ws2.on("message", (raw) => events2.push(JSON.parse(String(raw))));
  while (Date.now() < deadline2) {
    if (events2.some((e) => e.type === "chat.done") || events2.some((e) => e.type === "chat.error")) break;
    await sleep(100);
  }
  assert.ok(events2.some((e) => e.type === "chat.done"), `桥接轮应成功: ${JSON.stringify(events2.filter((e) => e.type === "chat.error"))}`);
  ws2.close();

  // 校验 mock 中转实际收到的请求结构
  const sent = JSON.parse(fs.readFileSync("/tmp/mock-last-request.json", "utf8"));
  assert.equal(sent.temperature, 0.7, "预设采样参数应透传");
  assert.equal(sent.top_p, 0.9);
  assert.equal(sent.max_tokens ?? sent.max_completion_tokens, 2048, "maxTokens 应透传（compat 决定字段名）");
  const msgTexts = sent.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  assert.ok(msgTexts.includes("你是 测试看板娘，与 测试员 演绎故事。"), "宏应替换（char/user）");
  assert.ok(msgTexts.includes("[E2E常驻设定]"), "世界书常驻条目应注入");
  assert.ok(msgTexts.includes("[E2E银剑设定]"), "世界书关键词条目应注入");
  assert.ok(!msgTexts.includes("<think>"), "提示词正则应去除 think 标签");
  const lastUser = sent.messages.map((m) => m.role).lastIndexOf("user");
  assert.ok(lastUser === sent.messages.length - 1 || sent.messages[lastUser + 1]?.role !== "user", "用户消息定位正确");
  // pi-ai 的 transcript 语义：所有 system 消息按序重放合并为开头一条 leading system，
  // 尾部注入的内容保留、位置前移（与 ST 的差异已文档化）
  assert.ok(msgTexts.includes("|e2e深度注入|"), "depth0 绝对注入内容应在请求中");
  assert.equal(sent.messages[0].role, "system");
  console.log("✓ 桥接模式全链路（预设/宏/世界书/正则/深度注入/采样透传）");

  console.log("\n=== M1+M2 冒烟全部通过 ===");
} finally {
  mock.kill();
  server.kill();
  cleanup();
}
