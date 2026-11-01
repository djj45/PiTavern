import {useState} from 'react';
export function RewriteDialog({busy,onRewrite,onStop,onClose}:{busy:boolean;onRewrite:(instruction:string)=>Promise<boolean>;onStop:()=>void;onClose:()=>void}){
 const [instruction,setInstruction]=useState('');
 return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3">
  <div role="dialog" aria-modal="true" aria-labelledby="rewrite-title" className="w-full max-w-lg space-y-3 rounded-xl border border-tavern-border bg-tavern-panel p-4">
   <h2 id="rewrite-title">只重写正文</h2>
   <p className="text-sm text-tavern-dim">保持当前世界、知识、变量与时间，不执行工具。旧正文保留，新正文成为文字候选。重新购买或改变行动请使用“重新生成”。</p>
   <label className="block text-sm">本次写作要求<textarea autoFocus aria-label="本次写作要求" maxLength={4000} value={instruction} disabled={busy} onChange={e=>setInstruction(e.target.value)} placeholder="例如：缩短叙述、增加对白" rows={4} className="mt-2 w-full rounded border border-tavern-border bg-tavern-bg p-2" /></label>
   <div className="flex flex-wrap justify-end gap-2 text-sm"><button onClick={onClose} className="rounded border border-tavern-border px-3 py-2">关闭</button>{busy?<button onClick={onStop} className="rounded border border-tavern-border px-3 py-2">停止</button>:<button onClick={async()=>{if(await onRewrite(instruction.trim()))onClose();}} className="rounded bg-tavern-accent px-3 py-2 text-tavern-bg">新增文字候选</button>}</div>
  </div>
 </div>;
}
