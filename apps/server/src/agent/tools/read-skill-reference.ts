import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "./context.ts";

const MAX_READ = 8192;

function buildParameters() {
  return Type.Object({
    name: Type.String({ description: "Skill 名称（skills/ 下的目录名）" }),
    path: Type.String({ description: "Skill 内的相对路径，例如 references/dialogue.md；传目录则列出内容" }),
  });
}

function text(t: string): AgentToolResult["content"] {
  return [{ type: "text", text: t }];
}

/**
 * tavern_read_skill_reference —— 读 data/st/skills/<name>/ 下的参考文档。
 * 路径限制在 skill 目录内，防穿越。
 */
export function createReadSkillReferenceTool(ctx: ToolContext): AgentTool<ReturnType<typeof buildParameters>> {
  const parameters = buildParameters();
  return {
    name: "tavern_read_skill_reference",
    label: "Skill 参考",
    description:
      "按需读取当前卡可用 Skill 内的 references/*.md 参考文档。先浏览 skill 目录确定入口，再按入口指引读取相关参考文件。",
    parameters,
    execute: async (_id, params) => {
      const skillRoot = path.resolve(ctx.skillsDir, params.name);
      const target = path.resolve(skillRoot, params.path);
      // 防目录穿越：目标必须仍在该 skill 目录内
      if (target !== skillRoot && !target.startsWith(skillRoot + path.sep)) {
        return { content: text("非法路径。"), details: { summary: "非法路径" }, isError: true };
      }
      if (!fs.existsSync(target)) {
        const available = fs.existsSync(ctx.skillsDir) ? fs.readdirSync(ctx.skillsDir).join("、") : "（无）";
        return {
          content: text(`路径不存在。可用 skills：${available}`),
          details: { summary: `不存在 ${params.name}/${params.path}` },
          isError: true,
        };
      }
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(target);
        return {
          content: text(`${params.name}/${params.path} 是目录：\n${files.join("\n")}`),
          details: { summary: `列目录 ${params.name}/${params.path}` },
        };
      }
      const content = fs.readFileSync(target, "utf8").slice(0, MAX_READ);
      return {
        content: text(content),
        details: { summary: `读取 ${params.name}/${params.path}（${Math.min(stat.size, MAX_READ)}/${stat.size} 字）` },
      };
    },
  };
}
