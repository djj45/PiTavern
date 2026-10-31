import type {
  WorldCommandErrorCode, WorldCommandReceipt, WorldCommandRejected, WorldCommandResult, WorldEngineCapability, WorldSnapshot, WorldTemplate,
} from "@pitavern/shared/world";
import { worldContentHash } from "./hash.ts";
import { applyWorldCommand, WorldRuleError } from "./rules.ts";
import { parseWorldCommand, WorldValidationError } from "./schema.ts";
import type { WorldState } from "./state.ts";

/** 只在内存中结算；commit 返回独立快照，文件提交与并发校验由 M2 调用者负责。 */
export class WorldTransaction {
  private readonly base: WorldSnapshot;
  private working: WorldSnapshot;
  private readonly template?: WorldTemplate;
  private readonly access: WorldEngineCapability;
  private readonly receiptMap = new Map<string, WorldCommandReceipt>();
  private phase: "open" | "committed" | "discarded" = "open";

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

  commit(): WorldSnapshot {
    if (this.phase !== "open") throw new WorldValidationError("世界事务已结束");
    this.phase = "committed";
    return this.snapshot;
  }

  discard(): void {
    if (this.phase !== "open") throw new WorldValidationError("世界事务已结束");
    this.working = structuredClone(this.base);
    this.receiptMap.clear();
    this.phase = "discarded";
  }
}
