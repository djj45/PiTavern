import { randomUUID } from "node:crypto";
import type {
  WorldActionTimeReceipt, WorldCommandErrorCode, WorldCommandReceipt, WorldCommandRejected, WorldCommandResult, WorldEngineCapability, WorldSnapshot, WorldTemplate, WorldInteractionResult, WorldEvent, WorldQuestResult,
} from "@pitavern/shared/world";
import { worldContentHash } from "./hash.ts";
import { applyWorldCommand, WorldRuleError } from "./rules.ts";
import { parseWorldCommand, WorldValidationError } from "./schema.ts";
import { actorKnows, buildPlayerWorldView } from "./knowledge.ts";
import type { WorldState } from "./state.ts";
import {applyQuestAction,questAction,rejectedQuest} from "./quests.ts";
import {visibleQuests} from "./quest-view.ts";
import {interactionConditionsMet} from "./action-view.ts";
import {worldClockLabel} from "./digest.ts";

/** 只在内存中结算；commit 返回独立快照，文件提交与并发校验由 M2 调用者负责。 */
export class WorldTransaction {
  private readonly base: WorldSnapshot;
  private working: WorldSnapshot;
  private readonly template?: WorldTemplate;
  private readonly access: WorldEngineCapability;
  private readonly receiptMap = new Map<string, WorldCommandReceipt>();
  private phase: "open" | "committed" | "discarded" = "open";
  private readonly questReceipts = new Map<string,WorldQuestResult>();
  private readonly initialQuestView?: string;
  private changedQuestView = false;

  constructor(state: WorldState, private readonly turn: number) {
    if (!Number.isSafeInteger(turn) || turn < 0) throw new WorldValidationError("回合数必须是非负安全整数");
    this.base = state.snapshot;
    this.working = structuredClone(this.base);
    this.template = state.template;
    this.access = state.capability;
    if(this.base.schemaVersion>=3)this.initialQuestView=JSON.stringify(visibleQuests(this.base,this.template,this.template?.initial.actorId??""));
  }

  get status(): "open" | "committed" | "discarded" { return this.phase; }
  get snapshot(): WorldSnapshot { return structuredClone(this.working); }
  get receipts(): WorldCommandReceipt[] { return structuredClone([...this.receiptMap.values()]); }
  get questViewsChanged(): boolean { return this.changedQuestView; }

  private replaceWorking(snapshot: WorldSnapshot): void {
    this.working=snapshot;
    // Observe mutations themselves: parallel tool callbacks can arrive after a
    // temporary authorization has already disappeared again.
    if(this.initialQuestView!==undefined && !this.changedQuestView)
      this.changedQuestView=JSON.stringify(visibleQuests(snapshot,this.template,this.template?.initial.actorId??""))!==this.initialQuestView;
  }

  /** Finish a private action copy before publishing any state or authorization changes. */
  private finishAction(candidate: WorldSnapshot, minutes: number, commandId: string, observedQuestChange = false): {time?:WorldActionTimeReceipt;summary:string} {
    let changed = observedQuestChange || (this.initialQuestView !== undefined &&
      JSON.stringify(visibleQuests(candidate,this.template,this.template!.initial.actorId)) !== this.initialQuestView);
    let changes: string[] = [];
    if (minutes > 0) {
      // Internal time is not another model command and never recursively incurs a fee.
      const advance = applyWorldCommand(candidate,this.template!,{commandId,type:"advance_time",minutes},this.turn,()=>{changed=true;});
      changes = advance.summary.split("\n").slice(1);
    }
    this.replaceWorking(candidate);
    this.changedQuestView ||= changed;
    return this.template?.actionTime ? {
      time:{elapsedMinutes:minutes,clockMinutes:candidate.clockMinutes,changes},
      summary:[`本次行动耗时 ${minutes} 分钟；当前世界时间 ${candidate.clockMinutes} 分钟。`,...changes].join("\n"),
    } : {summary:""};
  }

  /** Keep the stored receipt immutable; a replay observes the current transaction without executing. */
  private replayReceipt<T extends {summary:string;revision:number;time?:WorldActionTimeReceipt}>(original:T):T {
    const result=structuredClone(original);
    if(!this.template?.actionTime)return result;
    return {...result,
      summary:`此前已处理，本次未重新执行；本次新增耗时 0 分钟；当前世界时间 ${worldClockLabel(this.working.clockMinutes)}（累计 ${this.working.clockMinutes} 分钟）。原执行时间与版本见 replay 历史回执，不能作为当前状态。`,
      revision:this.working.revision,
      time:{elapsedMinutes:0,clockMinutes:this.working.clockMinutes,changes:[]},
      replay:{originalRevision:original.revision,...(original.time?{originalTime:structuredClone(original.time)}:{})},
    };
  }

  quest(input:unknown):WorldQuestResult {
    if(this.phase!=="open" || this.access.mode!=="enabled" || !this.template)return rejectedQuest(this.working);
    const action=questAction(input);if(!action)return rejectedQuest(this.working);
    const key=JSON.stringify(action),previous=this.questReceipts.get(key);
    if(previous){
      const result=this.replayReceipt(previous);
      result.quests=visibleQuests(this.working,this.template,this.template.initial.actorId);
      return result;
    }
    const applied=applyQuestAction(this.working,this.template,action,this.turn);
    // Failed conditions can be met by a later legitimate tool action in this turn.
    if(applied.result.status!=="rejected"){
      try {
        const duration = applied.result.status==="staged" && action.action==="advance" ? this.template.actionTime?.questAdvanceMinutes??0 : 0;
        const elapsed=this.finishAction(applied.snapshot,duration,randomUUID());
        applied.result.revision=this.working.revision;
        applied.result.quests=visibleQuests(this.working,this.template,this.template.initial.actorId);
        if(applied.result.status==="staged" && elapsed.time){applied.result.time=elapsed.time;applied.result.summary+="\n"+elapsed.summary;}
        this.questReceipts.set(key,structuredClone(applied.result));
      } catch(error) {if(error instanceof WorldRuleError)return rejectedQuest(this.working);throw error;}
    }
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
      if(previous.argsHash!==argsHash)return rejected("COMMAND_CONFLICT", "相同命令 ID 的参数不同");
      return previous.result.status==="staged" ? this.replayReceipt(previous.result) : structuredClone(previous.result);
    }
    let result: WorldCommandResult;
    if (this.access.mode !== "enabled" || !this.template) {
      result = rejected("READ_ONLY", this.access.reason ?? "当前世界不能执行命令");
    } else {
      const candidate = structuredClone(this.working);
      try {
        let observed=false;
        result = applyWorldCommand(candidate, this.template, command, this.turn, ()=>{observed=true;});
        const policy=this.template.actionTime;
        const duration = command.type==="advance_time" ? 0
          : command.type==="move_to" ? (this.working.actors[command.actorId].locationId===command.locationId?0:policy?.moveMinutes??0)
          : policy?.tradeMinutes??0;
        const elapsed=this.finishAction(candidate,duration,command.commandId,observed);
        result.revision=this.working.revision;
        if(command.type!=="advance_time" && elapsed.time){result.time=elapsed.time;result.summary+="\n"+elapsed.summary;}
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
    const snapshot = this.working, template = this.template;
    if (!interactionConditionsMet(snapshot,template,interaction)) return reject();
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
    try {
      const elapsed=this.finishAction(next,events.length?template.actionTime?.interactionMinutes??0:0,randomUUID());
      return {status:events.length?"staged":"unchanged",summary:events.length?"交互已暂存，整轮成功后提交；失败或停止会撤销。"+(elapsed.time?"\n"+elapsed.summary:""):"交互完成，没有新的知识变化。",revision:this.working.revision,knownFacts:buildPlayerWorldView(this.working,template).knownFacts,...(events.length && elapsed.time?{time:elapsed.time}:{})};
    }catch(error){if(error instanceof WorldRuleError)return reject();throw error;}
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
