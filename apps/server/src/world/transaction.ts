import { randomUUID } from "node:crypto";
import type {
  WorldCommandErrorCode, WorldCommandReceipt, WorldCommandRejected, WorldCommandResult, WorldEngineCapability, WorldSnapshot, WorldTemplate, WorldInteractionResult, WorldEvent, WorldQuestResult,
} from "@pitavern/shared/world";
import { worldContentHash } from "./hash.ts";
import { applyWorldCommand, WorldRuleError } from "./rules.ts";
import { parseWorldCommand, WorldValidationError } from "./schema.ts";
import { actorKnows, buildPlayerWorldView } from "./knowledge.ts";
import type { WorldState } from "./state.ts";
import {applyQuestAction,questAction,rejectedQuest} from "./quests.ts";

/** 只在内存中结算；commit 返回独立快照，文件提交与并发校验由 M2 调用者负责。 */
export class WorldTransaction {
  private readonly base: WorldSnapshot;
  private working: WorldSnapshot;
  private readonly template?: WorldTemplate;
  private readonly access: WorldEngineCapability;
  private readonly receiptMap = new Map<string, WorldCommandReceipt>();
  private phase: "open" | "committed" | "discarded" = "open";
  private readonly questReceipts = new Map<string,WorldQuestResult>();

  constructor(state: WorldState, private readonly turn: number) {
    if (!Number.isSafeInteger(turn) || turn < 0) throw new WorldValidationError("回合数必须是非负安全整数");
    this.base = state.snapshot;
    this.working = structuredClone(this.base);
    this.template = state.template;
    this.access = state.capability;
  }

  get status(): "open" | "committed" | "discarded" { return this.phase; }
  get snapshot(): WorldSnapshot { return structuredClone(this.working); }
  get receipts(): WorldCommandReceipt[] { return structuredClone([...this.receiptMap.values()]); }

  quest(input:unknown):WorldQuestResult {
    if(this.phase!=="open" || this.access.mode!=="enabled" || !this.template)return rejectedQuest(this.working);
    const action=questAction(input);if(!action)return rejectedQuest(this.working);
    const key=JSON.stringify(action),previous=this.questReceipts.get(key);
    if(previous)return structuredClone(previous);
    const applied=applyQuestAction(this.working,this.template,action,this.turn);
    // Failed conditions can be met by a later legitimate tool action in this turn.
    if(applied.result.status!=="rejected"){this.working=applied.snapshot;this.questReceipts.set(key,structuredClone(applied.result));}
    return applied.result;
  }

  execute(input: unknown): WorldCommandResult {
    const commandId = input && typeof input === "object" && typeof (input as { commandId?: unknown }).commandId === "string"
      ? (input as { commandId: string }).commandId : "";
    const rejected = (code: WorldCommandErrorCode, message: string): WorldCommandRejected => ({
      status: "rejected", commandId, error: { code, message },
    });
    if (this.phase !== "open") return rejected("INVALID_COMMAND", "世界事务已结束");
    let command;
    try { command = parseWorldCommand(input); }
    catch (error) {
      if (!(error instanceof WorldValidationError)) throw error;
      if (this.receiptMap.has(commandId)) return rejected("COMMAND_CONFLICT", "相同命令 ID 的参数不同");
      const code = error.issues.some((issue) => issue.path === "/quantity") ? "INVALID_QUANTITY"
        : error.issues.some((issue) => issue.path === "/minutes") ? "TIME_LIMIT" : "INVALID_COMMAND";
      return rejected(code, error.message);
    }
    const argsHash = worldContentHash(command);
    const previous = this.receiptMap.get(commandId);
    if (previous) {
      return previous.argsHash === argsHash ? structuredClone(previous.result) : rejected("COMMAND_CONFLICT", "相同命令 ID 的参数不同");
    }
    let result: WorldCommandResult;
    if (this.access.mode !== "enabled" || !this.template) {
      result = rejected("READ_ONLY", this.access.reason ?? "当前世界不能执行命令");
    } else {
      const candidate = structuredClone(this.working);
      try {
        result = applyWorldCommand(candidate, this.template, command, this.turn);
        this.working = candidate;
      } catch (error) {
        if (!(error instanceof WorldRuleError)) throw error;
        result = { status: "rejected", commandId, error: error.error };
      }
    }
    this.receiptMap.set(commandId, { commandId, argsHash, result });
    return structuredClone(result);
  }

  /** Only public interaction IDs are accepted. Knowledge is never a model-authored command. */
  interact(input: unknown): WorldInteractionResult {
    const reject = (): WorldInteractionResult => ({status:"rejected",summary:"当前无法完成该交互。世界状态没有变化。",revision:this.working.revision});
    if (this.phase !== "open" || this.access.mode !== "enabled" || !this.template || this.template.schemaVersion < 2) return reject();
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input,"interactionId") || typeof (input as {interactionId?:unknown}).interactionId !== "string") return reject();
    const interaction = this.template.interactions?.find(i=>i.id===(input as {interactionId:string}).interactionId);
    if (!interaction) return reject();
    const snapshot = this.working, template = this.template, player = template.initial.actorId;
    const present = (id:string) => snapshot.actors[id]?.status === "alive" && snapshot.actors[id].locationId === snapshot.actors[player]?.locationId;
    if (!present(player) || !interaction.conditions.every(c=>{
      switch(c.type) {
        case "at_location": return snapshot.actors[player].locationId === c.locationId;
        case "npc_present": return c.actorId !== player && present(c.actorId);
        case "has_item": return snapshot.inventory.some(i=>i.ownerId===player && i.itemId===c.itemId && i.quantity>=c.quantity);
        case "knows_fact": return actorKnows(snapshot,template,c.actorId,c.factId);
      }
    })) return reject();
    if (interaction.effects.some(e=>e.type === "learn" && e.fromActorId && (!present(e.fromActorId) || !actorKnows(snapshot,template,e.fromActorId,e.factId)))) return reject();
    const next = structuredClone(snapshot), events:WorldEvent[] = [];
    for (const effect of interaction.effects) {
      if (effect.type === "learn") {
        if (actorKnows(next,template,effect.actorId,effect.factId)) continue;
        next.knowledge!.push({actorId:effect.actorId,factId:effect.factId,source:{type:"interaction",turn:this.turn,interactionId:interaction.id,...(effect.fromActorId?{fromActorId:effect.fromActorId}:{})}});
      } else {
        if (next.publishedFactIds!.includes(effect.factId) || template.facts!.some(f=>f.id===effect.factId && f.visibility==="public")) continue;
        next.publishedFactIds!.push(effect.factId);
      }
      events.push({id:randomUUID(),commandId:worldContentHash({interaction:interaction.id}),turn:this.turn,
        type:effect.type==="learn"?"knowledge_learn":"knowledge_publish",factId:effect.factId,interactionId:interaction.id,
        ...(effect.type==="learn"?{actorId:effect.actorId}:{}),worldTimeMinutes:next.clockMinutes,summary:effect.type==="learn"?"角色获知事实":"事实已公开"});
    }
    if (events.length && (next.revision === Number.MAX_SAFE_INTEGER || next.knowledge!.length > 2048)) return reject();
    if (events.length) next.revision++;
    next.recentEvents = [...next.recentEvents,...events].slice(-100);
    this.working = next;
    return {status:events.length?"staged":"unchanged",summary:events.length?"交互已暂存，整轮成功后提交；失败或停止会撤销。":"交互完成，没有新的知识变化。",revision:next.revision,knownFacts:buildPlayerWorldView(next,template).knownFacts};
  }

  commit(): WorldSnapshot {
    if (this.phase !== "open") throw new WorldValidationError("世界事务已结束");
    this.phase = "committed";
    return this.snapshot;
  }

  discard(): void {
    if (this.phase !== "open") throw new WorldValidationError("世界事务已结束");
    this.working = structuredClone(this.base);
    this.receiptMap.clear();
    this.questReceipts.clear();
    this.phase = "discarded";
  }
}
