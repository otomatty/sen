import type { ReactNode } from "react";
import { Menu as MenuIcon, PlayCircle } from "lucide-react";
import { useUI } from "../store/ui";
import { useTutorials, type ScreenKey } from "../features/help/tutorials";
import { Tooltip } from "./ui";

export function HelpVideoButton({ screen }: { screen: ScreenKey }) {
  const tutorials = useTutorials();
  const t = tutorials?.find((x) => x.screen === screen);
  if (!t) return null;
  return (
    <Tooltip label="この画面の使い方を動画で見る">
      <button className="toolbar-btn help-video-btn" onClick={() => useUI.setState({ videoId: t.id })} data-testid="help-video-button">
        <PlayCircle size={14} />
        <span>使い方</span>
      </button>
    </Tooltip>
  );
}

export function PageHeader({
  title,
  children,
  actions,
  screen,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  screen?: ScreenKey;
}) {
  return (
    <header className="page-header">
      <button className="icon-btn mobile-only" aria-label="メニュー" onClick={() => useUI.setState({ sidebarOpen: true })}>
        <MenuIcon size={16} />
      </button>
      <div className="page-title">{title}</div>
      {children}
      <div className="spacer" />
      <div className="page-actions">
        {actions}
        {screen && <HelpVideoButton screen={screen} />}
      </div>
    </header>
  );
}
