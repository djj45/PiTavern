import type { ChatDisplayDto } from "@pitavern/shared";

interface Job {
  text: string; placement: number; depth: number; display: ChatDisplayDto;
  resolve: (text: string) => void; reject: (error: Error) => void;
  signal?: AbortSignal; abort: () => void;
}
let worker: Worker | undefined;
let current: Job | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const queue: Job[] = [];

function finish(error?: Error, text?: string) {
  const job = current; if (!job) return;
  clearTimeout(timer); current = undefined;
  job.signal?.removeEventListener("abort", job.abort);
  if (error) { worker?.terminate(); worker = undefined; job.reject(error); }
  else job.resolve(text ?? job.text);
  pump();
}
function pump() {
  if (current || !queue.length) return;
  const job = queue.shift()!; current = job;
  try {
    worker ??= new Worker(new URL("./regexPreview.worker.ts", import.meta.url), { type: "module" });
    const activeWorker = worker;
    activeWorker.onmessage = (event: MessageEvent<{ text?: string; error?: string }>) => {
      if (current !== job || worker !== activeWorker) return;
      finish(event.data.error ? new Error(event.data.error) : undefined, event.data.text);
    };
    activeWorker.onerror = (event) => {
      event.preventDefault();
      if (current === job && worker === activeWorker) finish(new Error("显示正则执行失败，已显示原文"));
    };
    timer = setTimeout(() => finish(new Error("显示正则超时，已显示原文；请简化表达式")), 1500);
    worker.postMessage({ text: job.text, scripts: job.display.scripts, context: { placement: job.placement, depth: job.depth,
      layer: "display", env: { ...job.display, readOnly: true } } });
  } catch { finish(new Error("无法启动显示正则线程，已显示原文")); }
}

/** Only the worker executes user regex. Cancelling a stream update also terminates a stuck task. */
export function displayMessageIsolated(text: string, placement: number, depth: number, display?: ChatDisplayDto, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new Error("显示任务已取消"));
  if (!text || !display?.scripts.length) return Promise.resolve(text);
  if (queue.length >= 128) return Promise.reject(new Error("显示正则任务过多，已显示原文"));
  return new Promise((resolve, reject) => {
    const job: Job = { text, placement, depth, display, signal, resolve, reject, abort: () => {
      if (current === job) finish(new Error("显示任务已取消"));
      else { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); signal?.removeEventListener("abort", job.abort); reject(new Error("显示任务已取消")); }
    } };
    signal?.addEventListener("abort", job.abort, { once: true });
    queue.push(job); pump();
  });
}
