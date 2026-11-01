import {useRef,useState} from "react";
import type {WorldTemplate,WorldSchedulePreviewDto} from "@pitavern/shared/world";
import {api} from "../api.ts";
import {buttonClass,fieldClass} from "./libraryStyles.ts";

type Props = {template:WorldTemplate;change:(fn:(t:WorldTemplate)=>void)=>void;busy:boolean};
const clock=(minutes:number)=>`第${Math.floor(minutes/1440)+1}天 ${String(Math.floor(minutes%1440/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
const time=(minutes:number)=>`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;

export function ScheduleEditor({template,change,busy}:Props) {
  const [from,setFrom]=useState(0),[minutes,setMinutes]=useState(30),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [result,setResult]=useState<{key:string;value:WorldSchedulePreviewDto}|null>(null);
  const key=JSON.stringify([template,from,minutes]),latest=useRef(key);latest.current=key;
  const preview=result?.key===key?result.value:undefined;
  const schedules=template.schedules??[];
  const npcs=template.actors.filter(a=>a.id!==template.initial.actorId);
  const unused=npcs.filter(a=>!schedules.some(s=>s.actorId===a.id));
  const name=(id:string)=>template.actors.find(a=>a.id===id)?.name??id;
  const place=(id:string)=>template.locations.find(l=>l.id===id)?.name??id;
  const update=(fn:(t:WorldTemplate)=>void)=>{setResult(null);setError('');change(fn);};
  const simulate=async()=>{
    setLoading(true);setError('');setResult(null);const requested=key;
    try {const value=await api.previewWorldSchedules(template,from,minutes);if(latest.current===requested)setResult({key:requested,value});}
    catch(cause){if(latest.current===requested)setError((cause as Error).message);}
    finally{setLoading(false);}
  };
  return <section aria-label="NPC日程规则" className="min-w-0 space-y-3 rounded-lg border border-tavern-border p-3">
    <h3 className="font-medium">NPC 每日日程（作者管理）</h3>
    <p className="text-xs text-tavern-dim">每个NPC最多一份日程、16个每日到达点。只在推进世界时间时移动，不自动接取任务或传播知识。时间表和内部备注不发送给玩家。已有日程修改会阻断旧聊天迁移。</p>
    {template.schemaVersion<4 ? <>
      <p className="text-xs">启用后保存并发布；已有聊天需预览、备份并显式迁移，只处理当前时刻之后的日程。</p>
      <button type="button" className={buttonClass} disabled={busy} onClick={()=>update(t=>{t.schemaVersion=4;t.facts??=[];t.interactions??=[];t.quests??=[];t.initial.knowledge??=[];t.initial.actorMoney??=[];t.schedules=[];})}>启用日程规则（v4）</button>
    </> : <>
      <button type="button" className={buttonClass} disabled={busy||schedules.length>=64||!unused.length} onClick={()=>update(t=>{
        let n=1;while(schedules.some(s=>s.id===`schedule-${n}`))n++;
        t.schedules!.push({id:`schedule-${n}`,actorId:unused[0].id,points:[{minuteOfDay:10,locationId:t.initial.locationId}]});
      })}>添加NPC日程</button>
      {schedules.map((schedule,i)=><fieldset key={i} className="min-w-0 space-y-2 rounded border border-tavern-border p-3">
        <legend>日程 {i+1}</legend>
        <label className="block text-xs">稳定ID<input aria-label={`日程 ${i+1} ID`} className={fieldClass} maxLength={128} disabled={busy} value={schedule.id} onChange={e=>update(t=>{t.schedules![i].id=e.target.value;})}/></label>
        <label className="block text-xs">NPC<select aria-label={`日程 ${i+1} NPC`} className={fieldClass} disabled={busy} value={schedule.actorId} onChange={e=>update(t=>{t.schedules![i].actorId=e.target.value;})}>
          <option value="">请选择NPC</option>{npcs.filter(a=>a.id===schedule.actorId||!schedules.some(s=>s.actorId===a.id)).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
        </select></label>
        <label className="block text-xs">内部备注<textarea aria-label={`日程 ${i+1} 内部备注`} className={fieldClass} maxLength={2000} disabled={busy} value={schedule.description??''} onChange={e=>update(t=>{t.schedules![i].description=e.target.value;})}/></label>
        {schedule.points.map((point,j)=><div key={j} className="grid min-w-0 gap-2 rounded border border-tavern-border p-2 sm:grid-cols-3">
          <label className="min-w-0 text-xs">每日到达时间<input aria-label={`日程 ${i+1} 时间点 ${j+1} 时间`} type="time" step={60} className={fieldClass} disabled={busy} value={time(point.minuteOfDay)} onChange={e=>{if(!e.target.value)return;const [h,m]=e.target.value.split(':').map(Number);update(t=>{t.schedules![i].points[j].minuteOfDay=h*60+m;});}}/></label>
          <label className="min-w-0 text-xs">目的地<select aria-label={`日程 ${i+1} 时间点 ${j+1} 地点`} className={fieldClass} disabled={busy} value={point.locationId} onChange={e=>update(t=>{t.schedules![i].points[j].locationId=e.target.value;})}>{template.locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <button type="button" className={buttonClass} disabled={busy||schedule.points.length<=1} onClick={()=>update(t=>{t.schedules![i].points.splice(j,1);})}>删除日程 {i+1} 时间点 {j+1}</button>
        </div>)}
        <button type="button" className={buttonClass} disabled={busy||schedule.points.length>=16} onClick={()=>update(t=>{
          let minute=0;while(schedule.points.some(p=>p.minuteOfDay===minute))minute++;
          t.schedules![i].points.push({minuteOfDay:minute,locationId:t.initial.locationId});
        })}>添加日程 {i+1} 时间点</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={()=>update(t=>{t.schedules!.splice(i,1);})}>删除日程 {i+1}</button>
      </fieldset>)}
      <section aria-label="作者日程模拟" className="min-w-0 space-y-2 rounded border border-tavern-border p-3">
        <h4>作者模拟预览</h4>
        <p className="text-xs text-tavern-dim">以初始位置为起点，从指定累计分钟启用日程，只模拟之后的时间点。不会改动聊天或保存草稿。单次最多处理256个触发点。</p>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          <label className="text-xs">起始累计分钟<input aria-label="模拟起始分钟" className={fieldClass} type="number" min={0} max={525600000} disabled={busy||loading} value={from} onChange={e=>{setFrom(Number(e.target.value));setError('');}}/></label>
          <label className="text-xs">推进分钟数<input aria-label="模拟推进分钟" className={fieldClass} type="number" min={1} max={525600000} disabled={busy||loading} value={minutes} onChange={e=>{setMinutes(Number(e.target.value));setError('');}}/></label>
        </div>
        <button type="button" className={buttonClass} disabled={busy||loading} onClick={()=>void simulate()}>{loading?'正在模拟…':'模拟日程推进'}</button>
        {error&&<p role="alert" className="break-words text-xs text-red-300">{error}</p>}
        {preview&&<div aria-label="日程模拟结果" className="space-y-2 text-xs">
          <p>{clock(preview.snapshot.clockMinutes)} · 已消费 {preview.events.length} 个时间点</p>
          <ul className="max-h-64 space-y-1 overflow-y-auto">{preview.events.map((event,i)=><li key={i} className="break-words">{clock(event.worldTimeMinutes)} · {name(event.actorId!)} · {event.type==='schedule_move'?`${place(event.fromLocationId!)} → ${place(event.locationId!)}`:`跳过（${event.skipReason==='already_there'?'已在目的地':event.skipReason==='dead'?'已死亡':'已停用'}）`}</li>)}</ul>
          <p className="break-words">最终位置：{npcs.map(a=>`${a.name}·${place(preview.snapshot.actors[a.id].locationId)}`).join('、')}</p>
        </div>}
      </section>
    </>}
  </section>;
}
