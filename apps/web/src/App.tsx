import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessageDto, ChatSummaryDto, CharacterDto, ConnectionDto, ServerEvent } from "@pitavern/shared";
import { api } from "./api.ts";
import { useTavernSocket } from "./socket.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";

interface ActiveChat {
  id: string;
  character: string;
  messages: ChatMessageDto[];
}

export function App() {
  const [connection, setConnection] = useState<ConnectionDto | null>(null);
  const [characters, setCharacters] = useState<CharacterDto[]>([]);
  const [chats, setChats] = useState<ChatSummaryDto[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<ActiveChat | null>(null);
  const [streaming, setStreaming] = useState<{ chatId: string; text: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChat?.id ?? null;

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 4000);
  }, []);

  const refreshConnection = useCallback(() => {
    api.connection().then(setConnection).catch((e: Error) => showNotice(`读取连接设置失败: ${e.message}`));
  }, [showNotice]);

  const refreshCharacters = useCallback(() => {
    api.characters().then(setCharacters).catch(() => setCharacters([]));
  }, []);

  const refreshChats = useCallback(() => {
    api
      .chats(selectedCharacter ?? undefined)
      .then(setChats)
      .catch(() => setChats([]));
  }, [selectedCharacter]);

  useEffect(() => {
    refreshConnection();
    refreshCharacters();
  }, [refreshConnection, refreshCharacters]);

  useEffect(() => {
    refreshChats();
  }, [refreshChats]);

  const onEvent = useCallback(
    (event: ServerEvent) => {
      const isActive = "chatId" in event && event.chatId === activeChatIdRef.current;
      switch (event.type) {
        case "chat.started":
          if (isActive) setStreaming({ chatId: event.chatId, text: "" });
          break;
        case "chat.delta":
          if (isActive) setStreaming((s) => (s ? { ...s, text: s.text + event.delta } : s));
          break;
        case "chat.done":
          if (isActive) {
            setStreaming(null);
            setActiveChat((chat) =>
              chat ? { ...chat, messages: [...chat.messages, event.message] } : chat,
            );
          }
          refreshChats();
          break;
        case "chat.error":
          if (isActive) setStreaming(null);
          showNotice(`生成失败: ${event.message}`);
          break;
        default:
          break;
      }
    },
    [refreshChats, showNotice],
  );

  const socket = useTavernSocket(onEvent);

  const openChat = useCallback(async (chatId: string) => {
    try {
      const chat = await api.chat(chatId);
      setActiveChat({ id: chat.id, character: chat.character, messages: chat.messages });
    } catch (e) {
      showNotice(`打开聊天失败: ${(e as Error).message}`);
    }
  }, [showNotice]);

  const newChat = useCallback(async () => {
    const name = selectedCharacter ?? characters[0]?.name;
    if (!name) {
      showNotice("数据目录里还没有角色卡，请先把 PNG 角色卡放入 characters/ 目录");
      return;
    }
    try {
      const { id } = await api.createChat(name);
      await refreshChats();
      await openChat(id);
    } catch (e) {
      showNotice(`新建聊天失败: ${(e as Error).message}`);
    }
  }, [selectedCharacter, characters, refreshChats, openChat, showNotice]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!activeChat || streaming) return;
      setActiveChat((chat) =>
        chat
          ? {
              ...chat,
              messages: [
                ...chat.messages,
                {
                  id: `local-user-${Date.now()}`,
                  role: "user",
                  name: connection?.persona.name ?? "你",
                  text,
                  sendDate: new Date().toISOString(),
                },
              ],
            }
          : chat,
      );
      setStreaming({ chatId: activeChat.id, text: "" });
      socket.send({ type: "chat.send", chatId: activeChat.id, text });
    },
    [activeChat, streaming, socket, connection],
  );

  const stopGeneration = useCallback(() => {
    if (activeChat) socket.send({ type: "chat.abort", chatId: activeChat.id });
  }, [activeChat, socket]);

  const changeModel = useCallback(
    async (providerId: string, modelId: string) => {
      try {
        await api.saveConnection({ defaultProvider: providerId, defaultModel: modelId });
        refreshConnection();
      } catch (e) {
        showNotice(`切换模型失败: ${(e as Error).message}`);
      }
    },
    [refreshConnection, showNotice],
  );

  const deleteChat = useCallback(
    async (chatId: string) => {
      try {
        await api.deleteChat(chatId);
        if (activeChatIdRef.current === chatId) setActiveChat(null);
        refreshChats();
      } catch (e) {
        showNotice(`删除失败: ${(e as Error).message}`);
      }
    },
    [refreshChats, showNotice],
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar
        connection={connection}
        wsConnected={socket.connected}
        onModelChange={changeModel}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          characters={characters}
          selectedCharacter={selectedCharacter}
          onSelectCharacter={setSelectedCharacter}
          chats={chats}
          activeChatId={activeChat?.id ?? null}
          onOpenChat={openChat}
          onNewChat={newChat}
          onDeleteChat={deleteChat}
        />
        <ChatView
          chat={activeChat}
          personaName={connection?.persona.name ?? "你"}
          streamingText={streaming?.text ?? null}
          onSend={sendMessage}
          onStop={stopGeneration}
          disabled={!connection?.defaultModel}
        />
      </div>
      {notice && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-tavern-border bg-tavern-raised px-4 py-2 text-sm text-tavern-text shadow-xl">
          {notice}
        </div>
      )}
      {settingsOpen && (
        <SettingsDialog
          connection={connection}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            refreshConnection();
            showNotice("设置已保存");
          }}
          onError={showNotice}
        />
      )}
    </div>
  );
}
