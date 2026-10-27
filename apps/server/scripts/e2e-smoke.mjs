#!/usr/bin/env node
/**
 * M1 端到端冒烟：mock 中转 + PiTavern 服务 + WS 客户端完整走一遍。
 * 验收：状态接口 → 无配置提示 → 写入连接 → 造卡 → 建聊天 → WS 流式往返 → JSONL 落库。
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const ROOT = path.resolve(import.meta.dirname, "../../..");
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
const PORT = await freePort();
const MOCK_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const runsRoot = path.join(ROOT, "data/test-runs");
fs.mkdirSync(runsRoot, { recursive: true });
const RUN_DIR = fs.mkdtempSync(path.join(runsRoot, "e2e-"));
const DATA_DIR = path.join(RUN_DIR, "st");
const CONFIG = path.join(RUN_DIR, "config.json");
const REQUEST_DIR = path.join(RUN_DIR, "requests");
const sockets = [];
const createSocket = (url) => { const ws = new WebSocket(url); sockets.push(ws); return ws; };
const lastRequest = () => {
  const relayDir = path.join(REQUEST_DIR, fs.readdirSync(REQUEST_DIR)[0]);
  const file = fs.readdirSync(relayDir).filter((name) => name.endsWith(".json")).sort().at(-1);
  return JSON.parse(fs.readFileSync(path.join(relayDir, file), "utf8"));
};
console.log(`测试数据与请求记录: ${RUN_DIR}`);

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

const mock = spawn(process.execPath, ["scripts/mock-relay.mjs"], {
  cwd: path.join(ROOT, "apps/server"), stdio: "pipe",
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_REQUEST_DIR: REQUEST_DIR },
});
const mockReady = waitProcess(mock, "mock 中转已启动");

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
          baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
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

const server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: path.join(ROOT, "apps/server"),
  stdio: "pipe",
  env: { ...process.env, PORT: String(PORT), PITAVERN_CONFIG: CONFIG },
});

try {
  await Promise.all([mockReady, waitProcess(server, "PiTavern 服务已启动")]);

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
  const ws = createSocket(`ws://127.0.0.1:${PORT}/ws`);
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

  // 7. 落库校验（首行为 ST 元数据头，其余 3 条消息）
  const rawLines = fs.readFileSync(path.join(DATA_DIR, chatId), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rawLines[0].chat_metadata !== undefined, "首行应为 ST 元数据头");
  assert.equal(rawLines[0].character_name, "测试看板娘");
  const msgs = rawLines.filter((l) => typeof l.mes === "string");
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].is_user, true);
  assert.equal(msgs[1].name, "测试员");
  assert.equal(msgs[2].is_user, false);
  console.log("✓ JSONL 落库（元数据头 + 3 条：开场白/用户/助手）");

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
      2: { uid: "2", key: ["烛火"], keysecondary: [], content: "[E2E烛火] 烛火摇曳不定。", constant: false, disable: false, order: 30, position: 0, sticky: 5 },
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
  const ws2 = createSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => { ws2.on("open", resolve); ws2.on("error", reject); });
  ws2.send(JSON.stringify({ type: "chat.send", chatId, text: "我拔出银剑，烛火晃了一下。" }));
  const deadline2 = Date.now() + 30000;
  const events2 = [];
  ws2.on("message", (raw) => events2.push(JSON.parse(String(raw))));
  while (Date.now() < deadline2) {
    if (events2.some((e) => e.type === "chat.done") || events2.some((e) => e.type === "chat.error")) break;
    await sleep(100);
  }
  assert.ok(events2.some((e) => e.type === "chat.done"), `桥接轮应成功: ${JSON.stringify(events2.filter((e) => e.type === "chat.error"))}`);

  // 工具循环断言：worldbook_search 被调用并返回了世界书全文
  const toolStart = events2.find((e) => e.type === "chat.tool_start");
  const toolEnd = events2.find((e) => e.type === "chat.tool_end" && e.toolName === "worldbook_search");
  assert.ok(toolStart && toolStart.toolName === "worldbook_search", "应有 worldbook_search tool_start 事件");
  assert.ok(toolEnd && !toolEnd.isError, "worldbook_search 应成功结束");
  assert.ok(toolEnd.details?.summary, "tool_end 应携带 UI 摘要");
  console.log(`✓ 工具循环（worldbook_search 调用→返回全文→续写，${toolEnd.durationMs}ms）`);
  ws2.close();

  // 校验 mock 中转实际收到的请求结构（最后一次请求 = 工具结果回传后的续写请求）
  const sent = lastRequest();
  assert.equal(sent.temperature, 0.7, "预设采样参数应透传");
  assert.equal(sent.top_p, 0.9);
  assert.equal(sent.max_tokens ?? sent.max_completion_tokens, 2048, "maxTokens 应透传（compat 决定字段名）");
  const msgTexts = sent.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  assert.ok(msgTexts.includes("你是 测试看板娘，与 测试员 演绎故事。"), "宏应替换（char/user）");
  assert.ok(msgTexts.includes("[E2E常驻设定]"), "世界书常驻条目应注入");
  assert.ok(msgTexts.includes("[E2E银剑设定]"), "世界书关键词条目应注入");
  assert.ok(!msgTexts.includes("<think>"), "提示词正则应去除 think 标签");
  // 工具结果以 role=tool 回传给上游，内容含世界书全文
  const toolMsg = sent.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "应有 role=tool 的工具结果消息");
  assert.ok(JSON.stringify(toolMsg.content).includes("[E2E银剑设定] 银剑会鸣响"), "工具结果应含世界书全文");
  const lastUser = sent.messages.map((m) => m.role).lastIndexOf("user");
  assert.ok(lastUser >= 0, "用户消息定位正确");
  assert.ok(msgTexts.includes("|e2e深度注入|"), "depth0 绝对注入内容应在请求中");
  assert.equal(sent.messages[0].role, "system");
  console.log("✓ 桥接模式全链路（预设/宏/世界书/正则/深度注入/采样透传）");

  // 8.5 计时效果：烛火（sticky=5）命中后写入 chat_metadata.timedWorldInfo
  {
    const headerLine = fs.readFileSync(path.join(DATA_DIR, chatId), "utf8").split("\n", 1)[0];
    const header = JSON.parse(headerLine);
    const timed = header.chat_metadata?.timedWorldInfo;
    assert.ok(timed?.sticky?.["e2e世界/2"], `sticky 区间应持久化: ${JSON.stringify(timed)}`);
    assert.equal(timed.sticky["e2e世界/2"].end - timed.sticky["e2e世界/2"].start, 5, "sticky 区间长度=5");
    console.log("✓ 计时效果持久化（sticky 写入 chat_metadata.timedWorldInfo）");
  }

  // 8.6 导入导出
  {
    // 角色卡导入：复用造卡函数生成第二张 PNG
    fs.mkdirSync(path.join(DATA_DIR, "characters"), { recursive: true });
    const card2 = buildTestCardPng("异乡客");
    const upRes = await fetch(`${BASE}/api/import/character`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent("异乡客.png") },
      body: card2,
    });
    const upBody = await upRes.json();
    assert.ok(upBody.ok, "角色卡应可导入");
    assert.equal(upBody.file, "异乡客.png", "上传文件名应解码一次后保存");
    assert.ok(fs.existsSync(path.join(cardsDir, "异乡客.png")));
    const chars = await (await fetch(`${BASE}/api/characters`)).json();
    assert.ok(chars.some((c) => c.name === "异乡客"), "导入的卡应出现在列表");

    // 覆盖已有中文文件，不能另存一份百分号编码的同名角色卡。
    const overwrite = await fetch(`${BASE}/api/import/character`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent("测试看板娘.png") },
      body: buildTestCardPng("测试看板娘"),
    });
    assert.equal((await overwrite.json()).file, "测试看板娘.png");
    const jsonName = "中文 100% 卡.json";
    fs.writeFileSync(path.join(cardsDir, jsonName), JSON.stringify({ name: "中文 JSON 角色", description: "旧设定" }));
    const jsonImport = await fetch(`${BASE}/api/import/character`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent(jsonName) },
      body: JSON.stringify({ name: "中文 JSON 角色", description: "更新后的设定" }),
    });
    assert.equal((await jsonImport.json()).file, jsonName);
    const importedCards = await (await fetch(`${BASE}/api/characters`)).json();
    assert.equal(importedCards.filter((c) => c.name === "测试看板娘").length, 1);
    const jsonCards = importedCards.filter((c) => c.name === "中文 JSON 角色");
    assert.equal(jsonCards.length, 1);
    assert.equal(jsonCards[0].description, "更新后的设定");
    assert.deepEqual(fs.readdirSync(cardsDir).sort(), ["测试看板娘.png", "异乡客.png", jsonName].sort());
    const badRes = await fetch(`${BASE}/api/import/character`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-file-name": encodeURIComponent("坏卡.png") },
      body: Buffer.from("not a png"),
    });
    assert.equal(badRes.status, 400, "非卡文件应被拒绝");

    // 世界书导入
    const wRes = await fetch(`${BASE}/api/import/world`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "导入世界", data: { entries: { 0: { uid: "0", key: ["秘境"], content: "[秘境] 有入口。", constant: false } } } }),
    });
    const wBody = await wRes.json();
    assert.ok(wBody.ok && wBody.entryCount === 1, "世界书应可导入");
    const worlds = await (await fetch(`${BASE}/api/worlds`)).json();
    assert.ok(worlds.some((w) => w.name === "导入世界"));

    // 聊天导出
    const chatPath = chatId.split("/").map(encodeURIComponent).join("/");
    const mdRes = await fetch(`${BASE}/api/chats/${chatPath}/export?format=md`);
    assert.equal(mdRes.status, 200);
    const md = await mdRes.text();
    assert.ok(md.includes("# 测试看板娘"), "MD 导出应含标题");
    assert.ok(md.includes("我拔出银剑"), "MD 导出应含消息正文");
    const jlRes = await fetch(`${BASE}/api/chats/${chatPath}/export?format=jsonl`);
    const jl = await jlRes.text();
    assert.ok(JSON.parse(jl.split("\n")[0]).chat_metadata, "JSONL 导出首行应为元数据头");
    console.log("✓ 导入导出（角色卡上传/世界书导入/MD+JSONL 导出）");
  }

  // 9. 输出协议（game_tool）：mock 返回 think+game 双工具调用 → 服务端还原落库
  res = await fetch(`${BASE}/api/connection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputProtocol: "game_tool" }),
  });
  assert.ok((await res.json()).ok);

  const ws3 = createSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => { ws3.on("open", resolve); ws3.on("error", reject); });
  const events3 = [];
  ws3.on("message", (raw) => events3.push(JSON.parse(String(raw))));
  ws3.send(JSON.stringify({ type: "chat.send", chatId, text: "这把银剑有什么来历？" }));
  const deadline3 = Date.now() + 30000;
  while (Date.now() < deadline3) {
    if (events3.some((e) => e.type === "chat.done") || events3.some((e) => e.type === "chat.error")) break;
    await sleep(100);
  }
  const done3 = events3.find((e) => e.type === "chat.done");
  assert.ok(done3, `协议轮应完成: ${JSON.stringify(events3.filter((e) => e.type === "chat.error"))}`);
  assert.ok(done3.message.text.includes("会认主"), "正文应从 game_content 参数还原");
  assert.ok(done3.message.thinking?.includes("调用世界书"), "思考应从 tavern_think 参数还原");
  // 参数流式宽松提取：toolcall_delta 期间应产生 chat.delta
  assert.ok(events3.some((e) => e.type === "chat.delta"), "协议模式下正文应流式渲染");
  // 请求层：tool_choice=required 透传
  const sent2 = lastRequest();
  assert.equal(sent2.tool_choice, "required", "strict 模式应透传 tool_choice=required");
  ws3.close();

  // 落库校验：mes=正文，extra 带 thinking/summary/protocol
  const saved = fs.readFileSync(path.join(DATA_DIR, chatId), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lastMsg = saved[saved.length - 1];
  assert.equal(lastMsg.is_user, false);
  assert.ok(lastMsg.mes.includes("会认主"));
  assert.ok(lastMsg.mes.includes("<summary>"), "正文应带 summary 标签（供压缩层提取）");
  assert.ok(lastMsg.extra?.thinking?.includes("调用世界书"));
  assert.equal(lastMsg.extra?.protocol, "game_tool");
  assert.ok(typeof lastMsg.extra?.summary === "string");
  console.log("✓ 输出协议（game_tool 双工具调用→还原落库→参数流式→tool_choice 透传）");

  // 10. 协议轮之后的下一轮：历史里 assistant 是还原后的纯文本（无 tool_calls 形态）
  res = await fetch(`${BASE}/api/connection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outputProtocol: "native", contextMode: "simple" }),
  });
  assert.ok((await res.json()).ok);
  const ws4 = createSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => { ws4.on("open", resolve); ws4.on("error", reject); });
  ws4.on("message", () => {});
  ws4.send(JSON.stringify({ type: "chat.send", chatId, text: "收剑入鞘，再讲讲。" }));
  const deadline4 = Date.now() + 30000;
  const done4 = { value: false };
  const onMsg4 = (raw) => { const e = JSON.parse(String(raw)); if (e.type === "chat.done" || e.type === "chat.error") done4.value = e; };
  ws4.on("message", (raw) => onMsg4(raw));
  while (Date.now() < deadline4 && !done4.value) await sleep(100);
  assert.ok(done4.value?.type === "chat.done", `native 回归轮应成功: ${JSON.stringify(done4.value)}`);
  ws4.close();
  const finalSent = lastRequest();
  const assistantHistory = finalSent.messages.filter((m) => m.role === "assistant");
  assert.ok(assistantHistory.some((m) => JSON.stringify(m.content).includes("会认主")), "历史应含还原后的协议正文");
  // 协议正文只应出现在消息 content（还原态），而不是藏在任何 tool_calls 参数里
  assert.ok(
    !finalSent.messages.some((m) => m.tool_calls && JSON.stringify(m.tool_calls).includes("会认主")),
    "协议正文不应以 tool_calls 形态残留在历史",
  );
  console.log("✓ 协议轮后历史还原为纯文本（正文不在 tool_calls 里）");

  // 11. 构建后的前端可由服务端托管。
  if (fs.existsSync(path.join(ROOT, "apps/web/dist/index.html"))) {
    const page = await fetch(`${BASE}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root">/);
    console.log("✓ 生产前端托管目录");
  }

  // 12. 空白聊天、生成中保存设置后停止、断线重连恢复。
  res = await fetch(`${BASE}/api/chats`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ character: "测试看板娘", greeting: "" }),
  });
  assert.equal(res.status, 200);
  const emptyId = (await res.json()).id;
  const emptyChat = await (await fetch(`${BASE}/api/chats/${emptyId.split("/").map(encodeURIComponent).join("/")}`)).json();
  assert.equal(emptyChat.character, "测试看板娘");
  assert.equal(emptyChat.messages.length, 0);
  const lifecycle = [];
  const ws5 = createSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws5.on("message", (raw) => lifecycle.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { ws5.on("open", resolve); ws5.on("error", reject); });
  const until = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate() && Date.now() < deadline) await sleep(20);
    assert.ok(predicate(), label);
  };
  ws5.send(JSON.stringify({ type: "chat.send", chatId: emptyId, text: "测试生成中修改设置" }));
  await until(() => lifecycle.some((e) => e.type === "chat.delta"), "应开始流式生成");
  const started = lifecycle.find((e) => e.type === "chat.started");
  assert.equal(started.message.role, "user");
  assert.equal(started.message.name, "测试员");
  res = await fetch(`${BASE}/api/connection`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona: { name: "改名后的测试员", description: "" } }),
  });
  assert.ok((await res.json()).ok);
  ws5.send(JSON.stringify({ type: "chat.abort", chatId: emptyId }));
  await until(() => lifecycle.some((e) => e.type === "chat.finished"), "改设置后仍能停止当前 Agent");
  assert.ok(!lifecycle.some((e) => e.type === "chat.error"), "用户停止不应当作生成错误");
  lifecycle.length = 0;
  ws5.send(JSON.stringify({ type: "chat.send", chatId: emptyId, text: "测试断线恢复" }));
  await until(() => lifecycle.some((e) => e.type === "chat.delta"), "第二轮应开始");
  assert.equal(lifecycle.find((e) => e.type === "chat.started").message.name, "改名后的测试员");
  ws5.close();
  const restored = [];
  const ws6 = createSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws6.on("message", (raw) => restored.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { ws6.on("open", resolve); ws6.on("error", reject); });
  ws6.send(JSON.stringify({ type: "chat.sync", chatId: emptyId }));
  await until(() => restored.some((e) => e.type === "chat.snapshot"), "重连应获取快照");
  const runningSnapshot = restored.find((e) => e.type === "chat.snapshot").snapshot;
  assert.equal(runningSnapshot.running, true);
  assert.ok(runningSnapshot.streamingText.length > 0);
  await until(() => restored.some((e) => e.type === "chat.finished"), "重连后仍收到结束事件");
  restored.length = 0;
  ws6.send(JSON.stringify({ type: "chat.sync", chatId: emptyId }));
  await until(() => restored.some((e) => e.type === "chat.snapshot"), "结束后可再次同步");
  const finalSnapshot = restored.find((e) => e.type === "chat.snapshot").snapshot;
  assert.equal(finalSnapshot.running, false);
  assert.equal(finalSnapshot.streamingText, "");
  assert.ok(finalSnapshot.messages.at(-1).text.length > 5);
  ws6.close();
  console.log("✓ 空白聊天、配置隔离、生成中停止、重连快照与后续事件");

  // ---- M5 接管模式：常驻注入 + 关键词排除 + 历史截断 + set_state 工具就位
  res = await fetch(`${BASE}/api/connection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contextMode: "takeover", outputProtocol: "native", takeover: { recentTurns: 3, stateProjection: true } }),
  });
  assert.ok((await res.json()).ok);
  const ws7 = createSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events7 = [];
  ws7.on("message", (raw) => events7.push(JSON.parse(String(raw))));
  await until(() => ws7.readyState === 1, "ws7 连接");
  ws7.send(JSON.stringify({ type: "chat.send", chatId, text: "接管模式下再讲一段。" }));
  await until(() => events7.some((e) => e.type === "chat.finished"), "接管轮应完成");
  assert.ok(events7.some((e) => e.type === "chat.done"), `接管轮: ${JSON.stringify(events7.filter((e) => e.type === "chat.error"))}`);

  const takeoverSent = lastRequest();
  const toolNames = (takeoverSent.tools ?? []).map((t) => t.function?.name);
  assert.ok(toolNames.includes("tavern_set_state"), `接管模式应挂 set_state 工具: ${toolNames}`);
  assert.ok(!toolNames.includes("game_content"), "native 协议下不应有 game_content");
  const sysMsg = takeoverSent.messages.find((m) => m.role === "system");
  assert.ok(sysMsg, "应有 system 消息");
  const sysText = JSON.stringify(sysMsg.content);
  assert.ok(sysText.includes("[E2E常驻设定]"), "常驻世界书应注入 system");
  assert.ok(!sysText.includes("[E2E银剑设定]"), "关键词条目不得注入 system（靠工具检索）");
  assert.ok(sysText.includes("上下文规则（接管模式）"), "接管指引应在 system");
  const allText = takeoverSent.messages.map((m) => JSON.stringify(m.content)).join("\n");
  assert.ok(!allText.includes("来一杯热的"), "接管模式早期轮不应进上下文（近 3 轮截断）");
  assert.ok(allText.includes("接管模式下再讲一段"), "本轮用户消息应在");
  assert.equal(takeoverSent.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes("接管模式下再讲一段。")).length, 1, "本轮用户消息只能发送一次");
  const projectionEvent = events7.find((e) => e.type === "chat.projection");
  assert.equal(projectionEvent?.projection, "测试员在酒馆大堂，银剑由掌柜保管。");
  assert.ok(events7.some((e) => e.type === "chat.tool_end" && e.toolName === "tavern_set_state" && !e.isError));
  const projectedSnapshot = await (await fetch(`${BASE}/api/chats/${chatId.split("/").map(encodeURIComponent).join("/")}`)).json();
  assert.equal(projectedSnapshot.projection, projectionEvent.projection, "投影应持久化并进入重连快照");

  events7.length = 0;
  ws7.send(JSON.stringify({ type: "chat.send", chatId, text: "继续接管，确认上一轮状态。" }));
  await until(() => events7.some((e) => e.type === "chat.finished"), "投影回注轮应完成");
  assert.ok(events7.some((e) => e.type === "chat.done"));
  const projectedRequest = lastRequest();
  assert.ok(JSON.stringify(projectedRequest.messages.find((m) => m.role === "system").content).includes(projectionEvent.projection), "下一轮 system 必须回注上一轮状态");
  ws7.close();
  console.log("✓ 接管模式（常驻注入/关键词排除/近3轮截断/单次用户消息/投影增量事件与落库/下一轮回注）");

  console.log("\n=== M1~M6 冒烟全部通过 ===");
} finally {
  mock.kill();
  server.kill();
  for (const ws of sockets) ws.terminate();
}
