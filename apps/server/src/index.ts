import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpApp } from "./api/http.ts";
import { attachWebSocket } from "./api/ws.ts";
import { loadConfig, saveConfig, seedDataDirs, resolveDataPath, CONFIG_PATH } from "./config.ts";
import { buildModels } from "./providers/models.ts";
import { CharacterStore } from "./stdata/characters.ts";
import { ChatStore } from "./stdata/chats.ts";
import { SessionManager } from "./session/manager.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(here, "../../../web/dist");
const config = loadConfig();
const configPath = resolveDataPath(CONFIG_PATH);
if (!fs.existsSync(configPath)) {
  saveConfig(config);
}
const stDataDir = resolveDataPath(config.stDataDir);
seedDataDirs(stDataDir);

const modelsRef = { current: buildModels(config) };
const characters = new CharacterStore(path.join(stDataDir, "characters"));
const chats = new ChatStore(stDataDir);
const sessions = new SessionManager(config, () => modelsRef.current, characters, chats, stDataDir);

const app = createHttpApp({
  config,
  modelsRef,
  characters,
  chats,
  sessions,
  webDistDir: fs.existsSync(webDistDir) ? webDistDir : null,
  stDataDir,
});

const server = http.createServer(app);
attachWebSocket(server, sessions);

const port = Number(process.env.PORT ?? config.port);
server.listen(port, () => {
  console.log(`PiTavern 服务已启动`);
  console.log(`  HTTP/WS  http://127.0.0.1:${port}`);
  console.log(`  数据目录  ${stDataDir}`);
  console.log(`  前端托管  ${fs.existsSync(webDistDir) ? "web/dist（已构建）" : "未构建（dev 模式走 vite 5173）"}`);
});
