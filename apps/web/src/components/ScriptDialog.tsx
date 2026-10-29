import { useState } from 'react';
import { api } from '../api.ts';
export function ScriptDialog({ chatId, revision, onClose, onStop }: { chatId: string; revision: string; onClose: () => void; onStop: () => void }) {
  const [source, setSource] = useState('/setvar key=score 0 |\n/times 3 {: /incvar score :} |\n/echo 当前分数：{{getvar::score}}');
  const [result, setResult] = useState(''), [error, setError] = useState(''), [running, setRunning] = useState(false);
  const execute = async () => {
    if (running) return; setRunning(true); setError(''); setResult('');
    try { const value = await api.runScript(chatId, source, revision); setResult((value.notices.length ? value.notices.join('\n') + '\n' : '') + '管道结果：' + value.pipe + '\n执行 ' + value.steps + ' 步'); }
    catch (cause) { setError((cause as Error).message); }
    finally { setRunning(false); }
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3">
    <section role="dialog" aria-modal="true" aria-label="STscript 编辑器" className="flex max-h-[90dvh] w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-xl border border-tavern-border bg-tavern-panel p-4">
      <div className="flex items-center justify-between"><h2 className="font-medium">STscript 编辑器</h2><button type="button" onClick={onClose} disabled={running} className="rounded border border-tavern-border px-3 py-1 disabled:opacity-40">关闭脚本</button></div>
      <p className="text-xs leading-5 text-tavern-dim">支持核心管道、闭包、变量、条件循环及消息命令。/gen、/genraw、/trigger 会调用当前模型；其余命令无需模型。全局变量、扩展命令和任意 JS 暂不支持。失败或停止时整次撤回。</p>
      <textarea aria-label="STscript 源码" value={source} onChange={(e) => setSource(e.target.value)} disabled={running} rows={12} spellCheck={false} className="min-h-48 w-full resize-y rounded border border-tavern-border bg-tavern-bg p-3 font-mono text-sm" />
      <div className="flex gap-2">{running ? <button type="button" onClick={onStop} className="rounded border border-red-400 px-3 py-2 text-red-400">停止脚本</button> : <button type="button" onClick={() => void execute()} disabled={!source.trim()} className="rounded bg-tavern-accent px-3 py-2 text-tavern-bg disabled:opacity-40">执行脚本</button>}</div>
      {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-red-400">{error}</p>}
      {result && <pre role="status" className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-tavern-bg p-3 text-xs">{result}</pre>}
    </section>
  </div>;
}
