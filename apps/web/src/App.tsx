import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ChatSummaryDto, CharacterDto, ClientMessage, ConnectionDto, ReasoningLevel, ServerEvent } from "@pitavern/shared";
import { api } from "./api.ts";
import { useTavernSocket } from "./socket.ts";
import { isToolItem } from "./chatItems.ts";
import { chatReducer, EMPTY_USAGE } from "./chatState.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { ActivityPanel } from "./components/ActivityPanel.tsx";
import { readCustomColors, THEME_KEYS, THEME_PALETTES, THEME_VARS, validHex, type ThemeKey, type ThemePalette } from "./theme.ts";
const LibraryDialog = lazy(() => import("./components/LibraryDialog.tsx"));

export function App() {
  const [connection, setConnection] = useState<ConnectionDto | null>(null);
  const [characters, setCharacters] = useState<CharacterDto[]>([]);
  const [chats, setChats] = useState<ChatSummaryDto[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatStates, dispatch] = useReducer(chatReducer, {});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [maintenance, setMaintenance] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("pitavern-theme") ?? "night";
    return Object.hasOwn(THEME_PALETTES, saved) ? saved : "night";
  });
  const [customColors, setCustomColors] = useState<Partial<ThemePalette>>(() => readCustomColors(localStorage.getItem("pitavern-colors")));
  const activeChat = activeChatId ? chatStates[activeChatId] ?? null : null;
  const activeChatRef = useRef(activeChat);
  activeChatRef.current = activeChat;
  const [loadingHistoryFor, setLoadingHistoryFor] = useState<string | null>(null);
  const historyRequests = useRef(new Set<string>());
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;
  const sendRef = useRef<(message: ClientMessage) => boolean>(() => false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listRequest = useRef(0);

  const showNotice = useCallback((text: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const refreshConnection = useCallback(() =>
    api.connection().then(setConnection).catch((e: Error) => showNotice(`读取连接设置失败: ${e.message}`)), [showNotice]);
  const refreshCharacters = useCallback(() =>
    api.characters().then(setCharacters).catch((e: Error) => showNotice(`读取角色失败: ${e.message}`)), [showNotice]);
  const refreshChats = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const list = await api.chats(selectedCharacter ?? undefined);
      if (request === listRequest.current) setChats(list);
    } catch (e) {
      if (request === listRequest.current) showNotice(`读取聊天列表失败: ${(e as Error).message}`);
    }
  }, [selectedCharacter, showNotice]);

  useEffect(() => { void refreshConnection(); void refreshCharacters(); }, [refreshConnection, refreshCharacters]);
  useEffect(() => { void refreshChats(); }, [refreshChats]);

  const onEvent = useCallback((event: ServerEvent) => {
    dispatch(event);
    if (event.type === "maintenance") {
      setMaintenance(event.message);
      if (!event.message && activeChatIdRef.current) sendRef.current({ type: "chat.sync", chatId: activeChatIdRef.current });
    } else if (event.type === "library.changed") {
      void refreshCharacters();
      void refreshChats();
      if (activeChatIdRef.current) sendRef.current({ type: "chat.sync", chatId: activeChatIdRef.current });
    } else if (event.type === "hello") {
      setMaintenance(event.maintenance ?? "");
      const chatId = activeChatIdRef.current;
      if (!event.maintenance) {
        if (chatId) sendRef.current({ type: "chat.sync", chatId });
        void refreshChats();
      }
    } else if (event.type === "chat.finished" || event.type === "chat.snapshot") {
      void refreshChats();
    } else if (event.type === "chat.error") {
      showNotice(`聊天失败: ${event.message}`);
    }
  }, [refreshCharacters, refreshChats, showNotice]);
  const socket = useTavernSocket(onEvent);
  sendRef.current = socket.send;
  useEffect(() => { if (!socket.connected) dispatch({ type: "disconnected" }); }, [socket.connected]);

  const selectTheme = useCallback((next: string) => {
    if (!Object.hasOwn(THEME_PALETTES, next)) return;
    setTheme(next);
    setCustomColors({});
    localStorage.setItem("pitavern-theme", next);
    localStorage.removeItem("pitavern-colors");
  }, []);
  const changeThemeColor = useCallback((key: ThemeKey, value: string) => {
    if (!validHex(value)) return;
    setCustomColors((current) => {
      const next = { ...current, [key]: value };
      localStorage.setItem("pitavern-colors", JSON.stringify(next));
      return next;
    });
  }, []);
  const resetThemeColors = useCallback(() => {
    setCustomColors({});
    localStorage.removeItem("pitavern-colors");
  }, []);
  useEffect(() => {
    document.body.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    for (const key of THEME_KEYS) {
      const value = customColors[key];
      if (value && validHex(value)) document.body.style.setProperty(THEME_VARS[key], value);
      else document.body.style.removeProperty(THEME_VARS[key]);
    }
  }, [customColors]);

  const openChat = useCallback((chatId: string) => {
    activeChatIdRef.current = chatId;
    setActiveChatId(chatId);
    if (!socket.send({ type: "chat.sync", chatId })) showNotice("服务未连接，重连后将同步聊天");
  }, [socket.send, showNotice]);

  const newChat = useCallback(async () => {
    const name = selectedCharacter ?? characters[0]?.name;
    if (!name) { showNotice("数据目录里还没有角色卡，请先把 PNG 角色卡放入 characters/ 目录"); return; }
    try {
      const { id } = await api.createChat(name);
      openChat(id);
      setNavOpen(false);
      await refreshChats();
    } catch (e) { showNotice(`新建聊天失败: ${(e as Error).message}`); }
  }, [selectedCharacter, characters, refreshChats, openChat, showNotice]);

  const selectGreeting = useCallback(async (selected: number): Promise<void> => {
    const chat = activeChatRef.current;
    if (!chat?.greetingChoices || !chat.page || chat.pending || chat.streamingText !== null) return;
    try { await api.selectGreeting(chat.id, selected, chat.page.revision); }
    catch (error) {
      showNotice("切换开场白失败: " + (error as Error).message);
      sendRef.current({ type: "chat.sync", chatId: chat.id });
    }
  }, [showNotice]);

  const sendMessage = useCallback((text: string, speakers?: string[]): boolean => {
    if (!activeChat || activeChat.pending || activeChat.streamingText !== null) return false;
    if (text.startsWith("/")) {
      if (!activeChat.page?.revision) { showNotice("请等待聊天同步后再执行脚本"); return false; }
      dispatch({ type: "pending", chatId: activeChat.id });
      void api.runScript(activeChat.id, text, activeChat.page.revision).then((result) => {
        showNotice(result.notices.join("；") || result.pipe || "脚本执行完成（" + result.steps + " 步）");
      }).catch((error: Error) => showNotice("脚本失败: " + error.message)).finally(() => {
        dispatch({ type: "chat.finished", chatId: activeChat.id }); socket.send({ type: "chat.sync", chatId: activeChat.id });
      });
      return true;
    }
    if (!socket.send({ type: "chat.send", chatId: activeChat.id, text, speakers })) {
      showNotice("消息未发送：服务未连接，请重连后重试");
      return false;
    }
    // 等服务端确认落库后再显示用户消息，避免出现实际未发送的聊天记录。
    dispatch({ type: "pending", chatId: activeChat.id });
    return true;
  }, [activeChat, socket.send, showNotice]);

  const editMessage = useCallback(async (messageId: string, text: string, expectedText: string): Promise<boolean> => {
    const activeChat = activeChatRef.current;
    if (!activeChat || activeChat.pending || activeChat.streamingText !== null) return false;
    try {
      await api.editMessage(activeChat.id, messageId, text, expectedText);
      showNotice("消息已保存，原存档已备份");
      return true;
    } catch (error) { showNotice("修改失败: " + (error as Error).message); return false; }
  }, [showNotice]);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const chat = activeChatRef.current;
    if (!chat?.page || chat.page.before === null || chat.pending || chat.streamingText !== null || historyRequests.current.has(chat.id)) return false;
    const { before, revision } = chat.page;
    historyRequests.current.add(chat.id); setLoadingHistoryFor(chat.id);
    try {
      const page = await api.history(chat.id, before, revision);
      const current = activeChatRef.current;
      if (current?.id !== chat.id || current.page?.revision !== revision || current.page.before !== before) return false;
      dispatch({ type: "history.page", chatId: chat.id, page, before });
      return true;
    } catch (error) {
      showNotice("加载历史失败: " + (error as Error).message);
      sendRef.current({ type: "chat.sync", chatId: chat.id });
      return false;
    } finally {
      historyRequests.current.delete(chat.id);
      setLoadingHistoryFor((id) => id === chat.id ? null : id);
    }
  }, [showNotice]);

  /** 切换任意历史回合的候选分支；服务端会保留/恢复该分支之后的剧情。 */
  const selectBranch = useCallback(async (userMessageId: string, selected: number): Promise<boolean> => {
    const chat = activeChatRef.current;
    if (!chat?.page || chat.pending || chat.streamingText !== null) return false;
    try {
      await api.selectReply(chat.id, userMessageId, selected, chat.page.revision);
      showNotice("已切换剧情分支");
      return true;
    } catch (error) {
      showNotice("切换分支失败: " + (error as Error).message);
      sendRef.current({ type: "chat.sync", chatId: chat.id });
      return false;
    }
  }, [showNotice]);

  const restored = useCallback(() => showNotice("备份已恢复，恢复前的存档也已备份"), [showNotice]);

  const regenerate = useCallback((instruction?: string) => {
    if (!activeChat || activeChat.pending || activeChat.streamingText !== null) return;
    const latest = activeChat.items.filter((item) => !isToolItem(item)).at(-1);
    if (!latest || isToolItem(latest)) return;
    const note = instruction?.trim();
    if (socket.send({ type: "chat.regenerate", chatId: activeChat.id, messageId: latest.id, expectedText: latest.text,
      ...(note ? { instruction: note } : {}) })) {
      dispatch({ type: "pending", chatId: activeChat.id });
    } else showNotice("服务未连接，请重连后重试");
  }, [activeChat, socket.send, showNotice]);

  const stopGeneration = useCallback(() => {
    if (activeChatId && !socket.send({ type: "chat.abort", chatId: activeChatId })) showNotice("服务未连接，暂时无法停止生成");
  }, [activeChatId, socket.send, showNotice]);

  const changeModel = useCallback(async (providerId: string, modelId: string) => {
    try {
      await api.saveConnection({ defaultProvider: providerId, defaultModel: modelId });
      await refreshConnection();
    } catch (e) { showNotice(`切换模型失败: ${(e as Error).message}`); }
  }, [refreshConnection, showNotice]);

  const changeThinkingLevel = useCallback(async (level: ReasoningLevel) => {
    const providerId = connection?.defaultProvider, modelId = connection?.defaultModel;
    if (!providerId || !modelId) return;
    try {
      await api.setModelThinkingLevel(providerId, modelId, level);
      await refreshConnection();
    } catch (e) { showNotice(`切换推理等级失败: ${(e as Error).message}`); }
  }, [connection?.defaultProvider, connection?.defaultModel, refreshConnection, showNotice]);

  const deleteChat = useCallback(async (chatId: string) => {
    try {
      await api.deleteChat(chatId);
      dispatch({ type: "remove", chatId });
      if (activeChatIdRef.current === chatId) {
        activeChatIdRef.current = null;
        setActiveChatId(null);
      }
      await refreshChats();
    } catch (e) { showNotice(`删除失败: ${(e as Error).message}`); }
  }, [refreshChats, showNotice]);

  const modelOptions = connection?.providers.flatMap((provider) => provider.models.map((model) => ({
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    modelName: model.name,
    reasoning: model.reasoning,
    thinkingLevel: model.thinkingLevel,
  }))) ?? [];
  const currentModel = connection && modelOptions.some((model) => model.providerId === connection.defaultProvider && model.modelId === connection.defaultModel)
    ? `${connection.defaultProvider}::${connection.defaultModel}`
    : "";

  return (
    <div className="flex h-full flex-col">
      <TopBar wsConnected={socket.connected}
        onOpenLibrary={() => setLibraryOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)} panelOpen={panelOpen} onTogglePanel={() => { setPanelOpen((v) => !v); setNavOpen(false); }}
        theme={theme} customColors={customColors} onSelectTheme={selectTheme} onColorChange={changeThemeColor} onResetColors={resetThemeColors}
        onToggleNav={() => { setNavOpen((v) => !v); setPanelOpen(false); }} />
      {maintenance && <p role="status" className="shrink-0 border-b border-tavern-border bg-tavern-raised px-4 py-2 text-sm text-tavern-accent">{maintenance}</p>}
      <div className="relative flex min-h-0 flex-1">
        <Sidebar characters={characters} selectedCharacter={selectedCharacter} onSelectCharacter={setSelectedCharacter}
          chats={chats} activeChatId={activeChatId} onOpenChat={openChat} onNewChat={newChat} onNewGroup={async (name, members) => {
            try { const { id } = await api.createGroup(name, members); setSelectedCharacter(null); openChat(id); await refreshChats(); return true; }
            catch (error) { showNotice("创建群聊失败: " + (error as Error).message); return false; }
          }} onDeleteChat={deleteChat} onChatsChanged={() => { void refreshChats(); }}
          onCharactersChanged={() => { void refreshCharacters(); void refreshChats(); }} onNotice={showNotice} mobileOpen={navOpen} onClose={() => setNavOpen(false)} />
        <ChatView chat={activeChat} personaName={connection?.persona.name ?? "你"}
          models={modelOptions} currentModel={currentModel} onModelChange={changeModel}
          thinkingLevel={connection?.thinkingLevel ?? "off"} onThinkingLevelChange={changeThinkingLevel}
          appearance={connection?.appearance}
          streamingText={activeChat?.pending ? "" : activeChat?.streamingText ?? null}
          onSelectBranch={selectBranch} onSelectGreeting={selectGreeting} onLoadOlder={loadOlder} loadingOlder={loadingHistoryFor === activeChatId} onRestored={restored}
          onSend={sendMessage} onStop={stopGeneration} onEdit={editMessage} onRegenerate={regenerate} disabled={!connection?.defaultModel} maintenance={!!maintenance} connected={socket.connected} />
        {panelOpen && (
          <ActivityPanel
            chatId={activeChat?.id}
            activity={activeChat?.activity}
            activityError={activeChat?.activityError}
            items={activeChat?.items ?? []}
            usage={activeChat?.usage ?? EMPTY_USAGE}
            projection={activeChat?.projection}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
      {notice && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-tavern-border bg-tavern-raised px-4 py-2 text-sm text-tavern-text shadow-xl">{notice}</div>}
      {settingsOpen && <SettingsDialog connection={connection} onClose={() => setSettingsOpen(false)}
        onSaved={(restartRequired, silent) => {
          void refreshConnection();
          if (activeChatIdRef.current) sendRef.current({ type: "chat.sync", chatId: activeChatIdRef.current });
          if (!silent) showNotice(restartRequired ? "设置已保存，数据目录将在重启服务后生效" : "设置已保存");
        }} onError={showNotice} onNotice={showNotice} />}
      {libraryOpen && <Suspense fallback={<p role="status" className="fixed bottom-4 right-4 rounded bg-tavern-panel p-3">正在打开资料库…</p>}>
        <LibraryDialog scope={connection?.stDataDir ?? ""} onClose={() => setLibraryOpen(false)} />
      </Suspense>}
    </div>
  );
}
