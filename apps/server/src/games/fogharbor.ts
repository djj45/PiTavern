import fs from "node:fs";
import path from "node:path";
import { defaultConfig, seedDataDirs } from "../config.ts";
import { CharacterStore } from "../stdata/characters.ts";
import { ChatStore } from "../stdata/chats.ts";
import { SessionManager } from "../session/manager.ts";
import { buildModels } from "../providers/models.ts";
import { createWorldTemplateRecord } from "../world/state.ts";

export const fogharborAssets = new URL("../../../../games/fogharbor/", import.meta.url);

/** Only creates a new isolated library. Never reads or copies the user's configuration. */
export function prepareFogharbor(output: string) {
  const directory = path.resolve(output);
  const read = (name: string) => fs.readFileSync(new URL(name, fogharborAssets), "utf8");
  const cardText = read("character.json"), worldText = read("worldbook.json");
  const card = JSON.parse(cardText), envelope = JSON.parse(read("template.json"));
  createWorldTemplateRecord(envelope.template, envelope);
  // Exclusive directory creation also refuses existing empty directories and symlinks.
  fs.mkdirSync(directory);
  const config = defaultConfig();
  config.stDataDir = path.join(directory, "st");
  config.persona = { name: "调查员", description: "受雾港公所委托的外港调查员。" };
  config.contextMode = "takeover";
  seedDataDirs(config.stDataDir);
  fs.writeFileSync(path.join(config.stDataDir, "characters", card.data.name + ".json"), cardText, { flag: "wx" });
  // Available for export/editing, but inactive: the card already embeds this book.
  fs.writeFileSync(path.join(config.stDataDir, "worlds", "雾港最后一盏灯.json"), worldText, { flag: "wx" });
  const characters = new CharacterStore(path.join(config.stDataDir, "characters"));
  const chats = new ChatStore(config.stDataDir);
  const sessions = new SessionManager(config, () => buildModels(config), characters, chats, config.stDataDir);
  const draft = sessions.worldTemplateLibrary.importTemplate(envelope);
  const published = sessions.worldTemplateLibrary.publish(draft.id, draft.draftRevision);
  const chat = chats.createChat(card.data.name, {
    name: card.data.name, is_user: false, is_system: false, mes: card.data.first_mes,
  }, config.persona.name);
  sessions.initializeChatWorldByHash(chat.id, published.publishedHash!, chats.revisionId(chat.id), false);
  const configFile = path.join(directory, "config.json");
  // Write the usable configuration last. Failures leave a diagnostic directory, never remove user files.
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  return { directory, configFile, chatId: chat.id, templateHash: published.publishedHash! };
}
