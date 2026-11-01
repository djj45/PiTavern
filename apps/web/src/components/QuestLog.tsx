import type {WorldQuestView} from "@pitavern/shared/world";
export function QuestLog({quests}:{quests:WorldQuestView[]}){
 return <section aria-label="玩家任务日志" className="min-w-0 space-y-2 rounded-lg border border-tavern-border p-3">
 <h3 className="text-sm font-medium">任务日志</h3><p className="text-xs text-tavern-dim">通过对话请求接取或推进，服务端检查实际状态。查看日志不会推进或领奖。</p>
 {quests.length?<ul className="space-y-3">{quests.map(q=><li key={q.id} className="min-w-0 space-y-1 rounded border border-tavern-border p-2"><div className="flex flex-wrap items-center gap-2"><h4 className="break-words text-sm">{q.name}</h4><span className="text-xs text-tavern-dim">{q.status==='available'?'可接取':q.status==='active'?'进行中':'已完成'}</span></div>
 {q.currentStage&&<p className="break-words text-sm">当前目标：{q.currentStage.objective}</p>}
 {q.completedStages.length>0&&<ol aria-label={`${q.name} 已完成阶段`} className="space-y-1 text-xs text-tavern-dim">{q.completedStages.map(s=><li className="break-words" key={s.id}>✓ {s.objective} · 第{s.turn}轮完成</li>)}</ol>}
 </li>)}</ul>:<p className="text-xs text-tavern-dim">当前没有可见任务。</p>}
 </section>;
}
