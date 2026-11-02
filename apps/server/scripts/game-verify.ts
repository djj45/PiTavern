import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fogharborAssets, prepareFogharbor } from "../src/games/fogharbor.ts";
import { normalizeCardBook, normalizeWorldFile } from "../src/context/worldinfo.ts";
import { CharacterStore } from "../src/stdata/characters.ts";
import { ChatStore } from "../src/stdata/chats.ts";
import { SessionManager } from "../src/session/manager.ts";
import { buildModels } from "../src/providers/models.ts";
import { stateFields } from "../src/stdata/replies.ts";
import { actorKnows, buildPlayerWorldView } from "../src/world/knowledge.ts";
import { twoStageFixture, type MockStep } from "./two-stage-fixture.ts";

const read = (name: string) => JSON.parse(fs.readFileSync(new URL(name, fogharborAssets), "utf8"));
const card = read("character.json"), book = read("worldbook.json"), envelope = read("template.json");
let checks = 0;
const check = (name: string) => { checks++; console.log("✓ " + name); };
const runRoot = path.resolve(import.meta.dirname, "../../../data/test-runs");
fs.mkdirSync(runRoot, { recursive: true });
const run = fs.mkdtempSync(path.join(runRoot, "fogharbor-"));
const prepared = prepareFogharbor(path.join(run, "fresh game with spaces"));
const config = JSON.parse(fs.readFileSync(prepared.configFile, "utf8"));
const initialChats = new ChatStore(config.stDataDir), initial = initialChats.readWorld(prepared.chatId)!;
assert.equal(initial.capability.mode, "enabled");
assert.equal(initial.snapshot.money.player, 30);
assert.equal(initial.snapshot.clockMinutes, 0);
assert.deepEqual(initial.snapshot.scene.presentActorIds.slice().sort(), ["lin", "player", "qiao", "yan"]);
assert.deepEqual(config.providers, []); assert.deepEqual(config.activeWorlds, []);
assert.equal(config.twoStage, false);
const parsedCard = new CharacterStore(path.join(config.stDataDir, "characters")).getCharacter(card.data.name)!;
assert.equal(parsedCard.firstMes, card.data.first_mes);
check("独立目录导入真实卡/书、发布模板与绑定开场；零密钥、零请求、30币和三NPC同场");

const hashTree = (dir: string): Record<string, string> => Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => { const file = path.join(e.parentPath, e.name); return [path.relative(dir, file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")]; }));
const beforeFiles = hashTree(prepared.directory);
assert.throws(() => prepareFogharbor(prepared.directory), /EEXIST/);
assert.deepEqual(hashTree(prepared.directory), beforeFiles);
const empty = path.join(run, "existing-empty"); fs.mkdirSync(empty);
assert.throws(() => prepareFogharbor(empty), /EEXIST/);
assert.deepEqual(fs.readdirSync(empty), []);
const link = path.join(run, "symlink"); fs.symlinkSync(prepared.directory, link, "dir");
assert.throws(() => prepareFogharbor(link), /EEXIST/);
assert.deepEqual(hashTree(prepared.directory), beforeFiles);
check("重复准备、已有空目录及符号链接均拒绝；既有文件逐项SHA-256不变");

const embedded = normalizeCardBook(parsedCard.characterBook, "fogharbor");
assert.equal(embedded.length, 12);
assert.deepEqual(embedded, normalizeWorldFile(book, "fogharbor"));
const publicMaterials = JSON.stringify([card, book, envelope.template.locations, envelope.template.actors, envelope.template.items]);
for (const fact of envelope.template.facts.filter((f: {visibility: string}) => f.visibility === "restricted")) {
  assert.ok(!publicMaterials.includes(fact.text), fact.id + " leaked");
}
assert.ok(!publicMaterials.includes("卢晦"));
assert.match(parsedCard.systemPrompt, /证词不能升级为定罪/);
assert.match(parsedCard.systemPrompt, /未登记的钥匙/);
assert.match(parsedCard.systemPrompt, /环境、动作与情绪可自由描写/);
assert.match(parsedCard.postHistoryInstructions, /后续目标/);
const initialView = buildPlayerWorldView(initial.snapshot, initial.template);
assert.deepEqual(initialView.knownFacts!.map(f => f.id), ["commission"]);
assert.deepEqual(initialView.quests!.map(q => q.id), ["repair", "investigate"]);
check("12条卡内/独立书归一化一致；开场仅公开委托与两个任务，无人物指控和受限正文");

type Call = { name: string; args: Record<string, unknown> };
const command = (args: Record<string, unknown>): Call => ({ name: "world_command", args: { commandId: randomUUID(), ...args } });
const move = (locationId: string) => command({ type: "move_to", actorId: "player", locationId });
const wait = (minutes: number) => command({ type: "advance_time", minutes });
const interact = (interactionId: string): Call => ({ name: "world_interact", args: { interactionId } });
const quest = (questId: string, action: "accept" | "advance" = "advance"): Call => ({ name: "world_quest", args: { questId, action } });
const buy = () => command({ type: "purchase_item", buyerId: "player", sellerId: "qiao", itemId: "lens", quantity: 1 });
const submit: Call = { name: "submit_narrative_plan", args: { scene: "雾港", beats: ["根据已经成功的工具结果叙述"], dialogue: [], references: [{ kind: "actor", id: "player" }] } };

const f = await twoStageFixture(envelope.template);
try {
  fs.writeFileSync(path.join(f.data, "characters", card.data.name + ".json"), JSON.stringify(card));
  const markers = ["worldInfoBefore", "charDescription", "charPersonality", "scenario", "chatHistory"];
  fs.writeFileSync(path.join(f.data, "OpenAI Settings/context.json"), JSON.stringify({
    prompts: markers.map(identifier => ({ identifier, marker: true })),
    prompt_order: [{ character_id: 100001, order: markers.map(identifier => ({ identifier, enabled: true })) }],
  }));
  const draft = f.sessions.worldTemplateLibrary.importTemplate(envelope);
  const published = f.sessions.worldTemplateLibrary.publish(draft.id, draft.draftRevision);
  for (const mode of ["simple", "bridge", "takeover"] as const) for (const dual of [false, true]) {
    const label = mode + (dual ? "/双阶段" : "/单阶段");
    f.config.contextMode = mode; f.config.twoStage = dual;
    const chat = f.chats.createChat(card.data.name, { name: card.data.name, is_user: false, is_system: false, mes: card.data.first_mes });
    f.sessions.initializeChatWorldByHash(chat.id, published.publishedHash!, f.chats.revisionId(chat.id), false);
    const state = () => f.chats.readWorld(chat.id)!.snapshot;
    const known = (id: string) => actorKnows(state(), f.chats.readWorld(chat.id)!.template!, "player", id);
    const turn = async (text: string, calls: Call[], final: MockStep = { text: "按照本轮成功结果继续调查。" }, noticeStatus?: "ready" | "later") => {
      const hidden = envelope.template.facts.filter((fact: {id: string; visibility: string}) => fact.visibility === "restricted" && !known(fact.id));
      const steps: MockStep[] = calls.map(call => ({ calls: [call] }));
      if (dual) steps.push({ calls: [submit] });
      steps.push(final);
      if (noticeStatus) {
        const inspect = final.inspect;
        final.inspect = body => {
          inspect?.(body);
          const input = body.messages.map((m: {content: unknown}) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
          assert.match(input, new RegExp('"id":"post_notice","name":"[^"\\n]+","availability":\\{"status":"' + noticeStatus + '"'), label + ": 最新公开可用性必须进入正文请求");
          assert.match(input, /证词不能升级为定罪|不能由证词推导定罪/);
          for (const fact of hidden) if (fact.id === "disclosure") assert.ok(!input.includes(fact.text));
        };
      }
      // At the beginning of a turn only the current branch's known facts may appear.
      const existingInspect = steps[0].inspect;
      steps[0].inspect = body => {
        existingInspect?.(body);
        const sent = JSON.stringify(body);
        assert.ok(sent.includes("雾港最后一盏灯"));
        assert.match(sent, /证词不能升级为定罪|不能由证词推导定罪/);
        for (const fact of hidden) assert.ok(!sent.includes(fact.text), label + ": " + fact.id);
      };
      f.plan(label + " " + text, steps);
      await f.sessions.send(chat.id, text);
      assert.equal(f.count(), steps.length, text + " mock requests");
    };
    await turn("提前验收与公开材料", [interact("confirm_light"), interact("post_notice")], {text:"公开材料仍是后续目标，先核验救援。"}, "later");
    assert.ok(!known("lamp") && !known("disclosure")); assert.equal(state().money.player, 30);
    check(label + "：凭空宣告修灯/公开均拒绝，无知识或金钱变化");

    await turn("接案、询问燕迟", [quest("repair", "accept"), quest("investigate", "accept"), interact("ask_yan"), quest("investigate")]);
    assert.ok(known("testimony")); assert.ok(!known("ledger"));
    await turn("前往北灯检查", [move("lighthouse"), interact("inspect_lamp"), quest("repair")]);
    assert.ok(known("survey")); assert.equal(state().clockMinutes, 0);
    await turn("等5分钟去工坊购买与交付", [wait(5), move("workshop"), buy(), quest("repair")]);
    assert.equal(state().money.player, 24); assert.equal(state().money.qiao, 46);
    assert.equal(state().questStates!.find(q => q.questId === "repair")!.status, "completed");
    assert.ok(!state().inventory.some(i => i.ownerId === "player" && i.itemId === "lens"));
    assert.ok(state().inventory.some(i => i.ownerId === "player" && i.itemId === "repair_receipt"));
    check(label + "：接案、两条受限线索、实际购买与交付；30→12→24，凭据来自NPC库存");

    await turn("提前去塔验收", [move("lighthouse"), interact("confirm_light")]);
    assert.ok(!known("lamp")); assert.equal(state().money.player, 24);
    await turn("去档案室核对值班簿", [move("archive"), interact("read_register"), quest("investigate")]);
    assert.ok(known("ledger"));
    await turn("有证词和记录仍不能提前公开", [interact("post_notice")], {text:"先完成救援核验，再回公所。"}, "later");
    const beforeFailed = stateFields(f.chats.readMetadata(chat.id));
    await turn("等到01:30并验收，但正文失败", [wait(85), move("lighthouse"), interact("confirm_light")], { failure: true });
    assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)), beforeFailed);
    await turn("等到01:30并验收", [wait(85), move("lighthouse"), interact("confirm_light")]);
    assert.equal(state().clockMinutes, 90); assert.ok(known("lamp"));
    assert.equal(state().actors.qiao.locationId, "lighthouse");
    check(label + "：错过在场拒绝，失败正文撤销等待/移动/揭示，重试到01:30才亮灯");

    await turn("到栈桥接船并核验到港", [move("pier"), quest("guide_ship", "accept"), quest("guide_ship"), interact("confirm_arrival")], {text:"救援已核验，下一步回公所确认林照在场。"}, "later");
    assert.ok(known("rescue")); assert.equal(state().money.player, 44); assert.equal(state().money.yan, 20);
    assert.ok(!known("disclosure"));
    const notice = buildPlayerWorldView(state(), f.chats.readWorld(chat.id)!.template).publicInteractions.find(i => i.id === "post_notice")!;
    assert.deepEqual(notice.availability!.reasons, ["需前往潮声公所", "需林照在场且可交互"]);
    check(label + "：灯火归航里程碑可先达成，未自动公开证据");

    await turn("到02:00回公所确认公开条件", [wait(30), move("hall")], {text:"林照在场，当前可以请求公开核验材料。"}, "ready");
    const beforeFinal = state();
    await turn("在公所报备并公开", [quest("investigate"), quest("public_record", "accept"), interact("post_notice"), quest("public_record")]);
    assert.equal(state().money.player, 52); assert.equal(state().money.lin, 42);
    assert.equal(Object.values(state().money).reduce((a, b) => a + b, 0), 160);
    assert.equal(state().clockMinutes, 120);
    assert.ok(state().questStates!.every(q => q.status === "completed")); assert.equal(state().questStates!.length, 4);
    assert.ok(state().publishedFactIds!.includes("disclosure"));
    check(label + "：岸上有证；四任务完成、52币，全体160币守恒，真相在核验后公开");
    const completed = stateFields(f.chats.readMetadata(chat.id));
    const restarted = new SessionManager(f.config, () => buildModels(f.config), f.cards, new ChatStore(f.data), f.data);
    assert.equal(restarted.snapshot(chat.id)!.world!.snapshot!.clockMinutes, 120);
    assert.deepEqual(stateFields(new ChatStore(f.data).readMetadata(chat.id)), completed);
    if (dual) {
      const e = f.sessions.snapshot(chat.id)!.rewrite!; assert.equal(e.enabled, true);
      f.plan(label + " 重写", [{ text: "钟声落定，告示栏前聚起人群。", inspect: b => assert.ok(!b.tools?.length) }]);
      await f.sessions.rewrite({ chatId: chat.id, messageId: e.messageId!, candidate: e.candidate!, revision: e.revision, requestId: randomUUID(), instruction: "简洁收束" });
      assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)), completed);
    }
    // Regenerate the final turn without executing the former actions, then select the original ending.
    const reply = f.chats.readChat(chat.id)!.at(-1)!;
    f.plan(label + " 留在栈桥", [...(dual ? [{ calls: [submit] }] : []), { text: "你决定暂留栈桥。" }]);
    await f.sessions.regenerate(chat.id, String(reply.extra!.messageId), reply.mes);
    assert.deepEqual(state(), beforeFinal);
    const user = f.sessions.snapshot(chat.id)!.messages.filter(m => m.role === "user").at(-1)!;
    f.sessions.selectReply(chat.id, user.id, 0, f.chats.revisionId(chat.id));
    assert.deepEqual(stateFields(f.chats.readMetadata(chat.id)), completed);
    await turn("再次领奖", [quest("repair"), quest("guide_ship"), quest("investigate"), quest("public_record")]);
    assert.equal(state().money.player, 52);
    check(label + "：重启/重生成/切候选恢复相应结局；重复不发奖" + (dual ? "，只重写正文不动世界" : ""));
  }
  assert.deepEqual(f.problems, []);
} finally { await f.close(); }
fs.writeFileSync(path.join(run, "report.json"), JSON.stringify({ checks, mockRun: f.run, provider: "synthetic_only", realModelPlayability: "not_requested", prepared }, null, 2) + "\n");
console.log(`${checks} 项雾港游戏检查通过：${run}`);
