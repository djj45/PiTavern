import {randomUUID} from "node:crypto";
import {WORLD_MAX_MONEY,WORLD_MAX_ITEM_QUANTITY,type WorldQuestResult,type WorldSnapshot,type WorldTemplate} from "@pitavern/shared/world";
import {actorPresent,worldConditionsMet} from "./conditions.ts";
import {visibleQuests} from "./quest-view.ts";
import {applyWorldCommand,WorldRuleError} from "./rules.ts";

export interface QuestAction {questId:string;action:"accept"|"advance"}
export function questAction(input:unknown): QuestAction | undefined {
  if(!input || typeof input!=="object" || Array.isArray(input)) return;
  const o=input as Record<string,unknown>;
  if(Object.keys(o).length!==2 || typeof o.questId!=="string" || !o.questId.length || o.questId.length>128 || (o.action!=="accept" && o.action!=="advance"))return;
  return {questId:o.questId,action:o.action};
}
export function rejectedQuest(snapshot:WorldSnapshot):WorldQuestResult {
  return {status:"rejected",summary:"当前无法执行该任务操作，世界状态没有变化。",revision:snapshot.revision};
}

/** Pure atomic rule: never mutates its inputs, including any rejection after a transfer check. */
export function applyQuestAction(snapshot:WorldSnapshot,template:WorldTemplate,input:unknown,turn:number):{snapshot:WorldSnapshot;result:WorldQuestResult} {
  const reject=()=>({snapshot:structuredClone(snapshot),result:rejectedQuest(snapshot)});
  const action=questAction(input),player=template.initial.actorId;
  if(!action || snapshot.schemaVersion<3 || template.schemaVersion<3 || !Number.isSafeInteger(turn) || turn<0 || !actorPresent(snapshot,player,player))return reject();
  const q=template.quests!.find(q=>q.id===action.questId),old=snapshot.questStates!.find(s=>s.questId===action.questId);
  if(!q || (!old && !worldConditionsMet(snapshot,template,q.openConditions)))return reject();
  const unchanged=()=>({snapshot:structuredClone(snapshot),result:{status:"unchanged" as const,summary:"任务没有新的进度变化。",revision:snapshot.revision,quests:visibleQuests(snapshot,template,player)}});
  if(action.action==="accept" && old || old?.status==="completed")return unchanged();
  if(action.action==="advance" && !old)return reject();
  if(old && turn<(old.completedStages.at(-1)?.turn??old.acceptedTurn))return reject();
  if(snapshot.revision===Number.MAX_SAFE_INTEGER)return reject();
  const next=structuredClone(snapshot);
  let stageId:string|undefined;
  if(action.action==="accept")next.questStates!.push({questId:q.id,status:"active",acceptedTurn:turn,completedStages:[]});
  else {
    const state=next.questStates!.find(s=>s.questId===q.id)!,stage=q.stages[state.completedStages.length];
    if(!stage || !worldConditionsMet(snapshot,template,stage.conditions))return reject();
    stageId=stage.id;
    if(state.completedStages.length===q.stages.length-1){
      const r=q.reward,payer=r.fromActorId,d=stage.delivery;
      // Check reward against the original inventory, before receiving the delivery.
      if(!actorPresent(snapshot,player,payer) || payer===player || snapshot.money[payer]<r.money || r.money>WORLD_MAX_MONEY-snapshot.money[player])return reject();
      for(const item of r.items){
        const held=snapshot.inventory.find(i=>i.ownerId===payer&&i.itemId===item.itemId)?.quantity??0;
        const owned=snapshot.inventory.find(i=>i.ownerId===player&&i.itemId===item.itemId)?.quantity??0;
        const afterDelivery=owned-(d?.itemId===item.itemId?d.quantity:0);
        if(held<item.quantity || item.quantity>WORLD_MAX_ITEM_QUANTITY-afterDelivery)return reject();
      }
      if(d && (d.toActorId===player || !actorPresent(snapshot,player,d.toActorId)))return reject();
      try {
        if(d)applyWorldCommand(next,template,{commandId:randomUUID(),type:"transfer_item",fromId:player,toId:d.toActorId,itemId:d.itemId,quantity:d.quantity},turn);
        for(const item of r.items)applyWorldCommand(next,template,{commandId:randomUUID(),type:"transfer_item",fromId:payer,toId:player,...item},turn);
      }catch(e){if(e instanceof WorldRuleError)return reject();throw e;}
      next.money[payer]-=r.money;next.money[player]+=r.money;
      state.status="completed";state.completedTurn=turn;
    }
    state.completedStages.push({stageId:stage.id,turn});
  }
  if(next.revision===Number.MAX_SAFE_INTEGER)return reject();
  next.revision++;
  const completed=next.questStates!.find(s=>s.questId===q.id)!.status==="completed";
  next.recentEvents=[...next.recentEvents,{id:randomUUID(),commandId:randomUUID(),turn,type:action.action==="accept"?"quest_accept" as const:completed?"quest_complete" as const:"quest_advance" as const,
    actorId:player,questId:q.id,...(stageId?{stageId}:{}),worldTimeMinutes:next.clockMinutes,summary:"任务进度已结算"}].slice(-100);
  return {snapshot:next,result:{status:"staged",summary:"任务操作已暂存，整轮成功后提交；失败或停止会撤销。",revision:next.revision,quests:visibleQuests(next,template,player)}};
}
