import { Bot, PlayCircle } from "lucide-react";
import { useUI } from "../../store/ui";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState, Kbd, Spinner } from "../../components/ui";
import { formatDuration, SCREENS, tutorialAsset, useTutorials } from "./tutorials";
import { SHORTCUT_GROUPS } from "./shortcuts";
import { useDocumentTitle } from "../../app/hooks";

export function HelpPage() {
  const tutorials = useTutorials();
  useDocumentTitle("使い方動画");
  const recordedAt = tutorials?.map((t) => t.recordedAt).filter(Boolean).sort().at(-1);
  return (
    <div className="page help-page" data-testid="help-page">
      <PageHeader title={<span className="page-title-text">使い方動画</span>} />
      <div className="page-body scroll">
        <div className="help-inner">
          <div className="help-hero">
            <div>
              <h1>動画で覚える Sen</h1>
              <p>
                各画面の操作を、短い動画で確認できます。気になる画面では、右上の <span className="inline-chip"><PlayCircle size={12} /> 使い方</span>{" "}
                からいつでも開けます。
              </p>
            </div>
            <div className="help-badge">
              <Bot size={16} />
              <div>
                <b>AI が実際に操作して収録</b>
                <span>
                  動画はヘッドレスブラウザで AI が本物の画面を操作し、自動で撮影しています。画面が変わったら再収録するだけで最新になります。
                  {recordedAt && `（最終収録：${new Date(recordedAt).toLocaleDateString("ja-JP")}）`}
                </span>
              </div>
            </div>
          </div>

          {!tutorials ? (
            <div className="center-pad">
              <Spinner />
            </div>
          ) : tutorials.length === 0 ? (
            <EmptyState
              icon={<PlayCircle size={28} />}
              title="まだ動画がありません"
              description={
                <>
                  ターミナルで <code>npm run tutorials</code> を実行すると、全画面の説明動画が自動で収録されます。
                </>
              }
            />
          ) : (
            <div className="tutorial-grid">
              {tutorials.map((t, i) => (
                <button key={t.id} className="tutorial-card" onClick={() => useUI.setState({ videoId: t.id })} data-testid="tutorial-card">
                  <div className="tutorial-thumb">
                    <img src={tutorialAsset(t.poster)} alt="" loading="lazy" />
                    <span className="tutorial-play">
                      <PlayCircle size={34} strokeWidth={1.5} />
                    </span>
                    <span className="tutorial-duration">{formatDuration(t.duration)}</span>
                  </div>
                  <div className="tutorial-meta">
                    <span className="tutorial-screen">
                      {String(i + 1).padStart(2, "0")}・{SCREENS[t.screen]}
                    </span>
                    <b>{t.title}</b>
                    <span className="muted">{t.summary}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          <h2 className="help-h2">キーボードショートカット</h2>
          <div className="shortcuts-grid inline">
            {SHORTCUT_GROUPS.map((g) => (
              <section key={g.title}>
                <h3>{g.title}</h3>
                {g.items.map(([combo, label]) => (
                  <div key={combo + label} className="shortcut-row">
                    <span>{label}</span>
                    <Kbd combo={combo} />
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
