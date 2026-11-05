import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Volume2, X } from "lucide-react";
import { useUI } from "../../store/ui";
import { cx } from "../../lib/utils";
import { Modal } from "../../components/ui";
import { formatDuration, SCREENS, tutorialAsset, useTutorials, type Tutorial } from "./tutorials";

export function VideoModal() {
  const videoId = useUI((s) => s.videoId);
  const tutorials = useTutorials();
  if (!videoId || !tutorials) return null;
  const t = tutorials.find((x) => x.id === videoId);
  if (!t) return null;
  return <Player key={t.id} t={t} list={tutorials} />;
}

function Player({ t, list }: { t: Tutorial; list: Tutorial[] }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  // ブラウザが音声付きの自動再生を拒否したときだけ出す
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const close = () => useUI.setState({ videoId: null });
  const idx = list.findIndex((x) => x.id === t.id);
  const goto = (d: number) => {
    const n = list[idx + d];
    if (n) useUI.setState({ videoId: n.id });
  };
  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let alive = true;
    // ナレーション付きは音声ありで再生する。拒否されたら無音で再生し直し、ボタンで解除できるようにする。
    if (t.narration) {
      video.muted = false;
      video.play().catch(() => {
        if (!alive) return;
        video.muted = true;
        void video.play().catch(() => {});
        setNeedsUnmute(true);
      });
    } else {
      video.muted = true;
      void video.play().catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [t.narration]);
  const unmute = () => {
    const video = ref.current;
    if (!video) return;
    video.muted = false;
    setNeedsUnmute(false);
    if (video.paused) void video.play().catch(() => {});
  };
  const current = [...t.chapters].reverse().find((c) => c.t <= time + 0.05);
  return (
    <Modal onClose={close} width="min(1180px, 96vw)" className="video-modal" testId="video-modal" align="center">
      <div className="modal-head">
        <div>
          <div className="video-screen">{SCREENS[t.screen]}</div>
          <h2>{t.title}</h2>
        </div>
        <span className="spacer" />
        <button className="icon-btn" onClick={() => goto(-1)} disabled={idx <= 0} aria-label="前の動画">
          <ChevronLeft size={16} />
        </button>
        <span className="muted small">
          {idx + 1} / {list.length}
        </span>
        <button className="icon-btn" onClick={() => goto(1)} disabled={idx >= list.length - 1} aria-label="次の動画">
          <ChevronRight size={16} />
        </button>
        <button className="icon-btn" onClick={close} aria-label="閉じる">
          <X size={16} />
        </button>
      </div>
      <div className="video-layout">
        <div className="video-wrap">
          <video
            ref={ref}
            src={tutorialAsset(t.video)}
            poster={tutorialAsset(t.poster)}
            controls
            playsInline
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onVolumeChange={(e) => {
              if (!e.currentTarget.muted) setNeedsUnmute(false);
            }}
            data-testid="tutorial-video"
          />
          {needsUnmute && (
            <button type="button" className="video-unmute" onClick={unmute} data-testid="tutorial-unmute">
              <Volume2 size={16} />
              音声をオンにする
            </button>
          )}
        </div>
        <aside className="video-side">
          <p className="video-summary">{t.summary}</p>
          <div className="video-rate">
            再生速度
            {[1, 1.5, 2].map((r) => (
              <button key={r} className={cx("chip-btn", rate === r && "on")} onClick={() => setRate(r)}>
                {r}x
              </button>
            ))}
          </div>
          <div className="chapters">
            <div className="chapters-title">ステップ</div>
            {t.chapters.map((c, i) => (
              <button
                key={i}
                className={cx("chapter", current === c && "active")}
                onClick={() => {
                  if (!ref.current) return;
                  ref.current.currentTime = c.t;
                  ref.current.play();
                }}
              >
                <span className="chapter-num">{i + 1}</span>
                <span className="chapter-title">{c.title}</span>
                <span className="chapter-time">{formatDuration(c.t)}</span>
              </button>
            ))}
            <div className="chapters-title others">ほかの動画</div>
            {list
              .filter((x) => x.id !== t.id)
              .map((x) => (
                <button key={x.id} className="other-video" onClick={() => useUI.setState({ videoId: x.id })}>
                  <img src={tutorialAsset(x.poster)} alt="" loading="lazy" />
                  <span>
                    <b>{x.title}</b>
                    <span className="muted small">
                      {SCREENS[x.screen]}・{formatDuration(x.duration)}
                    </span>
                  </span>
                </button>
              ))}
          </div>
        </aside>
      </div>
    </Modal>
  );
}
