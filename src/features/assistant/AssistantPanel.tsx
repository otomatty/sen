import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArrowUpRight, Play, Sparkles, X } from "lucide-react";
import { marked } from "marked";
import { ASSISTANT_MAX_QUESTION, type AssistantAction } from "../../../shared/assistant";
import { SCREENS, resolveScreenPath, screenForPath, type ScreenId } from "../../../shared/navigation";
import { useCurrentTeamId, useWsKey } from "../../app/hooks";
import { AutoTextarea } from "../../components/ui";
import { sanitizeHtml } from "../../lib/sanitize";
import { cx } from "../../lib/utils";
import {
  closeAssistant,
  openAssistant,
  resetAssistant,
  sendAssistantQuestion,
  stopAssistant,
  useAssistant,
  type AssistantChatMessage,
} from "../../store/assistant";
import { useData } from "../../store/data";
import { useUI } from "../../store/ui";
import { tutorialAsset, useTutorials, type Tutorial } from "../help/tutorials";

const SUGGESTIONS = ["課題を作るには？", "サイクルの使い方を教えて", "ボード表示に切り替えたい", "キーボードショートカットを知りたい"] as const;

/** 残り文字数を出し始める文字数。上限は ASSISTANT_MAX_QUESTION */
const COUNTER_AFTER = 800;

function renderMarkdown(src: string): string {
  try {
    return sanitizeHtml(marked.parse(src, { async: false, gfm: true, breaks: true }));
  } catch {
    return "";
  }
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function Typing() {
  return (
    <span className="assistant-typing" aria-label="入力中">
      <span />
      <span />
      <span />
    </span>
  );
}

function screenTitle(id: string): string | null {
  return SCREENS.find((screen) => screen.id === id)?.title ?? null;
}

const MessageView = memo(function MessageView({
  message,
  canAsk,
  tutorials,
  ws,
  teamKey,
  teamId,
  onAsk,
  onOpen,
}: {
  message: AssistantChatMessage;
  canAsk: boolean;
  tutorials: Tutorial[] | null;
  ws: string;
  teamKey?: string;
  teamId?: string;
  onAsk: (option: string) => void;
  onOpen: (screen: ScreenId) => void;
}) {
  const html = useMemo(() => (message.role === "assistant" && message.text ? renderMarkdown(message.text) : ""), [message.role, message.text]);
  if (message.role === "assistant" && !message.text && !message.error && !message.pending && message.actions.length === 0) return null;
  if (message.role === "user") {
    return (
      <div className="assistant-msg is-user" data-testid="assistant-message" data-role="user">
        <div className="assistant-user">{message.text}</div>
      </div>
    );
  }
  return (
    <div className="assistant-msg is-assistant" data-testid="assistant-message" data-role="assistant">
      {html ? <div className="prose assistant-md" dangerouslySetInnerHTML={{ __html: html }} /> : null}
      {message.pending && <Typing />}
      {message.error && (
        <p className="assistant-error" data-testid="assistant-error">
          {message.error}
        </p>
      )}
      {message.actions.length > 0 && (
        <div className="assistant-actions">
          {message.actions.map((action, index) => (
            <ActionView
              key={`${action.kind}-${index}`}
              action={action}
              canAsk={canAsk}
              tutorials={tutorials}
              ws={ws}
              teamKey={teamKey}
              teamId={teamId}
              onAsk={onAsk}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function ActionView({
  action,
  canAsk,
  tutorials,
  ws,
  teamKey,
  teamId,
  onAsk,
  onOpen,
}: {
  action: AssistantAction;
  canAsk: boolean;
  tutorials: Tutorial[] | null;
  ws: string;
  teamKey?: string;
  teamId?: string;
  onAsk: (option: string) => void;
  onOpen: (screen: ScreenId) => void;
}) {
  if (action.kind === "open_screen") {
    const title = screenTitle(action.screen);
    if (!title) return null;
    const path = resolveScreenPath(action.screen, { ws, teamKey, teamId });
    return (
      <button type="button" className="btn btn-secondary btn-sm assistant-open" data-testid="assistant-open-screen" disabled={!path} onClick={() => onOpen(action.screen)}>
        <ArrowUpRight size={14} />
        「{title}」を開く
      </button>
    );
  }
  if (action.kind === "play_tutorial") {
    const tutorial = tutorials?.find((item) => item.id === action.tutorial);
    const chapter = tutorial?.chapters[action.chapter - 1];
    if (!tutorial || !chapter) return null;
    return (
      <div className="assistant-tutorial" data-testid="assistant-tutorial">
        <img src={tutorialAsset(tutorial.poster)} alt="" loading="lazy" />
        <span className="assistant-tutorial-text">
          <b>{tutorial.title}</b>
          <span>
            ステップ {action.chapter}：{chapter.title}
          </span>
        </span>
        <button
          type="button"
          className="assistant-play"
          data-testid="assistant-tutorial-play"
          aria-label={`ステップ ${action.chapter} を再生`}
          onClick={() => useUI.setState({ videoId: tutorial.id, videoStart: chapter.t })}
        >
          <Play size={14} />
        </button>
      </div>
    );
  }
  return (
    <div className="assistant-ask">
      <p>{action.question}</p>
      <div className="assistant-ask-options">
        {action.options.map((option, index) => (
          <button key={`${option}-${index}`} type="button" className="chip-btn" data-testid="assistant-ask-option" disabled={!canAsk} onClick={() => onAsk(option)}>
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function AssistantPanelBody() {
  const navigate = useNavigate();
  const location = useLocation();
  const ws = useWsKey();
  const teamId = useCurrentTeamId();
  const teamKey = useData((s) => (teamId ? s.teams[teamId]?.key : undefined));
  const tutorials = useTutorials();
  const messages = useAssistant((s) => s.messages);
  const sending = useAssistant((s) => s.sending);
  const status = useAssistant((s) => s.status);
  const online = useOnline();
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const inputLocked = !online || sending || !status?.enabled || status.remaining <= 0;
  const latestAssistantId = [...messages].reverse().find((message) => message.role === "assistant")?.id ?? null;

  useEffect(() => {
    const input = inputRef.current;
    if (input && !input.disabled) input.focus();
    else panelRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const ask = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || inputLocked) return;
    setDraft("");
    stickRef.current = true;
    void sendAssistantQuestion(ws, trimmed, screenForPath(location.pathname));
  };

  const choose = (messageId: string, option: string) => {
    if (inputLocked) return;
    useAssistant.setState((s) => ({
      messages: s.messages.map((message) => (message.id === messageId ? { ...message, answered: true } : message)),
    }));
    ask(option);
  };

  const openScreen = (screen: ScreenId) => {
    const path = resolveScreenPath(screen, { ws, teamKey, teamId });
    if (!path) return;
    navigate(path);
    if (window.matchMedia("(max-width: 768px)").matches) closeAssistant();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(draft);
    }
  };

  return (
    <aside
      ref={panelRef}
      className="assistant-drawer"
      role="complementary"
      aria-label="AI アシスタント"
      data-testid="assistant-panel"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        closeAssistant();
      }}
    >
      <div className="assistant-head">
        <h2>AI アシスタント</h2>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          data-testid="assistant-reset"
          onClick={() => {
            resetAssistant();
            setDraft("");
            inputRef.current?.focus();
          }}
        >
          新しい会話
        </button>
        <button type="button" className="icon-btn" data-testid="assistant-close" aria-label="閉じる" onClick={() => closeAssistant()}>
          <X size={16} />
        </button>
      </div>
      <p className="assistant-note">Sen の使い方の質問に答えます。課題などワークスペースの内容は AI に送りません。</p>
      {status && (
        <p className="assistant-remaining" data-testid="assistant-remaining">
          今日はあと {status.remaining} 回
        </p>
      )}
      <div
        className="assistant-log"
        ref={logRef}
        onScroll={() => {
          const el = logRef.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {messages.length === 0 ? (
          <div className="assistant-empty">
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} type="button" className="assistant-suggestion" data-testid="assistant-suggestion" disabled={inputLocked} onClick={() => ask(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        ) : (
          <div className="assistant-thread" aria-live="polite">
            {messages.map((message) => (
              <MessageView
                key={message.id}
                message={message}
                canAsk={message.id === latestAssistantId && !message.answered && !inputLocked}
                tutorials={tutorials}
                ws={ws}
                teamKey={teamKey}
                teamId={teamId}
                onAsk={(option) => choose(message.id, option)}
                onOpen={openScreen}
              />
            ))}
          </div>
        )}
      </div>
      <div className="assistant-compose">
        {!online && (
          <p className="assistant-offline" data-testid="assistant-offline" role="status">
            オフラインのため使えません
          </p>
        )}
        {draft.length > COUNTER_AFTER && (
          <span className={cx("assistant-counter", ASSISTANT_MAX_QUESTION - draft.length === 0 && "text-danger")}>残り {ASSISTANT_MAX_QUESTION - draft.length} 文字</span>
        )}
        <div className="assistant-compose-box">
          <AutoTextarea
            ref={inputRef}
            className="assistant-input"
            data-testid="assistant-input"
            placeholder="Sen の使い方を質問…"
            value={draft}
            disabled={inputLocked}
            onChange={(e) => setDraft(e.target.value.slice(0, ASSISTANT_MAX_QUESTION))}
            onKeyDown={onKeyDown}
          />
          {sending ? (
            <button type="button" className="btn btn-secondary btn-sm" data-testid="assistant-stop" onClick={() => stopAssistant()}>
              停止
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" data-testid="assistant-send" disabled={inputLocked || !draft.trim()} onClick={() => ask(draft)}>
              送信
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function AssistantPanelGate() {
  const open = useAssistant((s) => s.open);
  if (!open) return null;
  return <AssistantPanelBody />;
}

export function AssistantPanel() {
  if (typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__) return null;
  return <AssistantPanelGate />;
}

function AssistantNavLive() {
  const enabled = useAssistant((s) => s.status?.enabled === true);
  const open = useAssistant((s) => s.open);
  if (!enabled) return null;
  return (
    <button
      type="button"
      className={cx("nav-item", open && "active")}
      data-testid="nav-assistant"
      aria-pressed={open}
      onClick={() => {
        useUI.setState({ sidebarOpen: false });
        if (useAssistant.getState().open) closeAssistant();
        else openAssistant();
      }}
    >
      <span className="nav-icon">
        <Sparkles size={15} />
      </span>
      <span className="nav-label">AI に質問</span>
    </button>
  );
}

export function AssistantNav() {
  if (typeof __SEN_DEMO__ !== "undefined" && __SEN_DEMO__) return null;
  return <AssistantNavLive />;
}
