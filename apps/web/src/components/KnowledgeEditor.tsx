import {QuestLog} from "./QuestLog.tsx";
import {useRef,useState} from "react";
import type {WorldTemplate,WorldInteractionCondition,WorldModelSnapshot} from "@pitavern/shared/world";
import {api} from "../api.ts";
import {buttonClass,fieldClass} from "./libraryStyles.ts";
const nextId=(prefix:string,rows:Array<{id:string}>)=>{let i=1;while(rows.some(r=>r.id===prefix+i))i++;return prefix+i};
export function KnowledgeEditor({template,change,busy}:{template:WorldTemplate;change:(fn:(draft:WorldTemplate)=>void)=>void;busy:boolean}) {
  const [perspective,setPerspective]=useState('player'),[result,setResult]=useState<{key:string;view:WorldModelSnapshot}|null>(null),[error,setError]=useState('');
  const previewKey=JSON.stringify([template,perspective]),latestPreviewKey=useRef(previewKey);latestPreviewKey.current=previewKey;
  const preview=result?.key===previewKey?result.view:null;
  const facts=template.facts ?? [], interactions=template.interactions ?? [];
  const condition=(type:WorldInteractionCondition['type']):WorldInteractionCondition=>{
    if(type==='at_location')return {type,locationId:template.initial.locationId};
    if(type==='npc_present')return {type,actorId:template.actors.find(a=>a.id!==template.initial.actorId)?.id ?? ''};
    if(type==='has_item')return {type,itemId:template.items[0]?.id ?? '',quantity:1};
    return {type,actorId:template.initial.actorId,factId:facts[0]?.id ?? ''};
  };
  const update=(fn:(draft:WorldTemplate)=>void)=>{setResult(null);change(fn)};
  return <section aria-label="知识与秘密规则" className="min-w-0 space-y-4 rounded-lg border border-tavern-border p-3">
    <h3 className="font-medium">知识与秘密（作者管理）</h3>
    <p className="text-xs text-tavern-dim">这里只保护结构化事实。不要把秘密写进公共名称、角色卡、世界书或普通正文。JSONL、模板导出及备份包含全部秘密；不是分享脱敏格式。</p>
    {template.schemaVersion===1 ? <><p className="text-xs">当前为 v1，读取不会自动升级。启用并发布 v2 后，已有聊天须预览、备份并显式迁移。</p><button type="button" className={buttonClass} disabled={busy} onClick={()=>update(d=>{d.schemaVersion=2;d.facts=[];d.interactions=[];d.initial.knowledge=[]})}>启用知识规则（v2）</button></> : <>
      <section aria-label="事实与秘密" className="space-y-2">
        <div className="flex flex-wrap items-center gap-2"><h4>事实与秘密</h4><button type="button" disabled={busy || facts.length>=256} className={buttonClass} onClick={()=>update(d=>{d.facts!.push({id:nextId('fact-',facts),text:'新事实',visibility:'restricted'})})}>添加事实</button></div>
        {facts.map((fact,i)=><div key={i} className="grid min-w-0 gap-2 rounded border border-tavern-border p-2 sm:grid-cols-2">
          <label className="min-w-0 text-xs">稳定事实 ID<input aria-label={`事实 ${i+1} ID`} className={fieldClass} disabled={busy} value={fact.id} onChange={e=>update(d=>{d.facts![i].id=e.target.value})}/></label>
          <label className="text-xs">可见属性<select aria-label={`事实 ${i+1} 可见性`} className={fieldClass} disabled={busy} value={fact.visibility} onChange={e=>update(d=>{d.facts![i].visibility=e.target.value as 'public'|'restricted'})}><option value="restricted">受限（仅已知角色）</option><option value="public">公共（所有角色）</option></select></label>
          <label className="min-w-0 text-xs sm:col-span-2">确定事实正文<textarea aria-label={`事实 ${i+1} 正文`} className={fieldClass} rows={2} maxLength={2000} disabled={busy} value={fact.text} onChange={e=>update(d=>{d.facts![i].text=e.target.value})}/></label>
          <label className="min-w-0 text-xs sm:col-span-2">内部备注（不会发送给玩家模型）<textarea aria-label={`事实 ${i+1} 内部备注`} className={fieldClass} rows={2} maxLength={2000} disabled={busy} value={fact.description ?? ''} onChange={e=>update(d=>{d.facts![i].description=e.target.value})}/></label>
          <button type="button" disabled={busy} className={buttonClass} onClick={()=>update(d=>{d.facts!.splice(i,1)})}>删除事实 {i+1}</button>
        </div>)}
      </section>
      <section aria-label="初始知情角色" className="space-y-2"><h4>初始知情角色</h4><p className="text-xs text-tavern-dim">只影响新聊天，迁移不为旧分支补发知识。公共事实本就对所有人可见。</p>
        {template.actors.map(actor=><fieldset key={actor.id} className="min-w-0 rounded border border-tavern-border p-2"><legend className="text-xs">{actor.name}（{actor.id}）</legend><div className="flex flex-wrap gap-3">{facts.map(fact=><label key={fact.id} className="break-all text-xs"><input type="checkbox" disabled={busy} checked={template.initial.knowledge?.some(k=>k.actorId===actor.id && k.factId===fact.id) ?? false} onChange={e=>update(d=>{d.initial.knowledge=d.initial.knowledge!.filter(k=>!(k.actorId===actor.id && k.factId===fact.id));if(e.target.checked)d.initial.knowledge.push({actorId:actor.id,factId:fact.id})})}/>{fact.id}</label>)}</div></fieldset>)}
        <ul aria-label="无效初始知情关系" className="space-y-1 text-xs">{template.initial.knowledge?.flatMap((k,index)=>template.actors.some(a=>a.id===k.actorId)&&facts.some(f=>f.id===k.factId)?[]:[<li key={index} className="break-all">未声明引用：{k.actorId} / {k.factId} <button type="button" className={buttonClass} disabled={busy} onClick={()=>update(d=>{d.initial.knowledge!.splice(index,1)})}>移除无效知情关系</button></li>])}</ul>
      </section>
      <section aria-label="揭示交互" className="space-y-2"><div className="flex flex-wrap items-center gap-2"><h4>揭示交互</h4><button type="button" disabled={busy || interactions.length>=128 || !facts.length} className={buttonClass} onClick={()=>update(d=>{d.interactions!.push({id:nextId('interact-',interactions),name:'新交互',conditions:[],effects:[{type:'learn',actorId:d.initial.actorId,factId:facts[0]?.id ?? ''}]})})}>添加揭示交互</button></div>
        <p className="text-xs text-tavern-dim">目录只公开交互 ID 与名称。条件全部满足才执行；条件、效果和内部备注不会发送给玩家模型。</p>
        {interactions.map((interaction,i)=><fieldset key={i} className="min-w-0 space-y-2 rounded border border-tavern-border p-2"><legend className="text-xs">交互 {i+1}</legend>
          <div className="grid gap-2 sm:grid-cols-2"><label className="min-w-0 text-xs">公共交互 ID<input className={fieldClass} aria-label={`交互 ${i+1} ID`} disabled={busy} value={interaction.id} onChange={e=>update(d=>{d.interactions![i].id=e.target.value})}/></label><label className="min-w-0 text-xs">公共名称<input className={fieldClass} aria-label={`交互 ${i+1} 名称`} disabled={busy} maxLength={100} value={interaction.name} onChange={e=>update(d=>{d.interactions![i].name=e.target.value})}/></label></div>
          <label className="block text-xs">内部备注<textarea className={fieldClass} aria-label={`交互 ${i+1} 内部备注`} disabled={busy} maxLength={2000} value={interaction.description ?? ''} onChange={e=>update(d=>{d.interactions![i].description=e.target.value})}/></label>
          <div className="space-y-2"><p className="text-xs">AND 条件</p>{interaction.conditions.map((c,j)=><div key={j} className="flex min-w-0 flex-wrap gap-2">
            <select className={fieldClass} aria-label={`交互 ${i+1} 条件 ${j+1} 类型`} disabled={busy} value={c.type} onChange={e=>update(d=>{d.interactions![i].conditions[j]=condition(e.target.value as WorldInteractionCondition['type'])})}><option value="at_location">玩家位于地点</option><option value="npc_present">NPC 在场可交互</option><option value="has_item">玩家持有物品</option><option value="knows_fact">角色已知事实</option></select>
            {'locationId' in c && <select className={fieldClass} aria-label={`交互 ${i+1} 条件 ${j+1} 地点`} disabled={busy} value={c.locationId} onChange={e=>update(d=>{d.interactions![i].conditions[j]={...c,locationId:e.target.value}})}>{template.locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select>}
            {'actorId' in c && <select className={fieldClass} aria-label={`交互 ${i+1} 条件 ${j+1} 角色`} disabled={busy} value={c.actorId} onChange={e=>update(d=>{d.interactions![i].conditions[j]={...c,actorId:e.target.value}})}>{template.actors.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>}
            {'itemId' in c && <><select className={fieldClass} aria-label={`交互 ${i+1} 条件 ${j+1} 物品`} disabled={busy} value={c.itemId} onChange={e=>update(d=>{d.interactions![i].conditions[j]={...c,itemId:e.target.value}})}>{template.items.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select><input className={fieldClass} aria-label={`交互 ${i+1} 条件 ${j+1} 数量`} type="number" min={1} max={1000000} disabled={busy} value={c.quantity} onChange={e=>update(d=>{d.interactions![i].conditions[j]={...c,quantity:Number(e.target.value)}})}/></>}
            {'factId' in c && <select className={fieldClass} aria-label={`交互 ${i+1} 条件 ${j+1} 事实`} disabled={busy} value={c.factId} onChange={e=>update(d=>{d.interactions![i].conditions[j]={...c,factId:e.target.value}})}>{facts.map(f=><option key={f.id} value={f.id}>{f.id}</option>)}</select>}
            <button type="button" disabled={busy} className={buttonClass} onClick={()=>update(d=>{d.interactions![i].conditions.splice(j,1)})}>删除条件 {j+1}</button>
          </div>)}<button type="button" className={buttonClass} disabled={busy || interaction.conditions.length>=16} onClick={()=>update(d=>{d.interactions![i].conditions.push(condition('at_location'))})}>添加条件</button></div>
          <p className="text-xs">效果（获知不会自动传播）</p>{interaction.effects.map((e,j)=><div key={j} className="grid min-w-0 gap-2 sm:grid-cols-2">
            <select className={fieldClass} aria-label={`交互 ${i+1} 效果 ${j+1} 类型`} disabled={busy} value={e.type} onChange={event=>update(d=>{d.interactions![i].effects[j]=event.target.value==='publish'?{type:'publish',factId:e.factId}:{type:'learn',factId:e.factId,actorId:d.initial.actorId}})}><option value="learn">指定角色获知</option><option value="publish">公开事实</option></select>
            <select className={fieldClass} aria-label={`交互 ${i+1} 效果 ${j+1} 事实`} disabled={busy} value={e.factId} onChange={event=>update(d=>{d.interactions![i].effects[j]={...e,factId:event.target.value}})}>{facts.map(f=><option key={f.id} value={f.id}>{f.id}</option>)}</select>
            {e.type==='learn' && <><select className={fieldClass} aria-label={`交互 ${i+1} 效果 ${j+1} 知情角色`} disabled={busy} value={e.actorId} onChange={event=>update(d=>{d.interactions![i].effects[j]={...e,actorId:event.target.value}})}>{template.actors.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select><select className={fieldClass} aria-label={`交互 ${i+1} 效果 ${j+1} 来源角色`} disabled={busy} value={e.fromActorId ?? ''} onChange={event=>update(d=>{const {fromActorId:_,...base}=e;d.interactions![i].effects[j]=event.target.value?{...base,fromActorId:event.target.value}:base})}><option value="">发现（无传播来源）</option>{template.actors.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></>}
            <button type="button" disabled={busy} className={buttonClass} onClick={()=>update(d=>{d.interactions![i].effects.splice(j,1)})}>删除效果 {j+1}</button>
          </div>)}
          <button type="button" className={buttonClass} disabled={busy || interaction.effects.length>=16 || !facts.length} onClick={()=>update(d=>{d.interactions![i].effects.push({type:'learn',actorId:d.initial.actorId,factId:facts[0].id})})}>添加效果</button>
          <button type="button" disabled={busy} className={buttonClass} onClick={()=>update(d=>{d.interactions!.splice(i,1)})}>删除交互 {i+1}</button>
        </fieldset>)}
      </section>
      <section aria-label="知识视角预览" className="space-y-2"><h4>以玩家／指定角色查看（服务端预览）</h4><select className={fieldClass} aria-label="知识预览视角" value={perspective} onChange={e=>{setPerspective(e.target.value);setResult(null);setError('')}}><option value="player">玩家</option>{template.actors.map(a=><option key={a.id} value={'actor:'+a.id}>{a.name}</option>)}</select><button type="button" disabled={busy} className={buttonClass} onClick={()=>{setError('');const key=previewKey;void api.previewWorldKnowledge(template,perspective==='player'?undefined:perspective.slice(6)).then(view=>{if(latestPreviewKey.current===key)setResult({key,view})}).catch((e:Error)=>{if(latestPreviewKey.current===key)setError(e.message)})}}>刷新视角预览</button>{error && <p role="alert" className="text-xs text-red-300">{error}</p>}{preview && <ul aria-label="预览已知事实" className="space-y-1 text-xs">{preview.knownFacts.map(f=><li key={f.id} className="break-words">{f.text} · 来源 {f.source.type}</li>)}</ul>}{preview?.quests&&<QuestLog quests={preview.quests}/>}</section>
    </>}
  </section>;
}
