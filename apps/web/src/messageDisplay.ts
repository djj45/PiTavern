import type { ChatDisplayDto } from "@pitavern/shared";
import { applyRegex } from "@pitavern/shared/regex";

export function displayMessage(text: string, placement: number, depth: number, display?: ChatDisplayDto): string {
  if (!display?.scripts.length) return text;
  return applyRegex(text, display.scripts, { layer: "display", placement, depth, env: { ...display, readOnly: true } });
}
