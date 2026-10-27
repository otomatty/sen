import { Keyboard, PlayCircle, Zap, Workflow } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { updateSettings } from "../../store/actions";
import { useUI } from "../../store/ui";
import { Button, Kbd, Modal } from "../../components/ui";
import { Logo } from "../../components/icons";

export function WelcomeModal() {
  const open = useUI((s) => s.welcomeOpen);
  const navigate = useNavigate();
  const { ws } = useParams();
  if (!open) return null;
  const close = (dismiss = true) => {
    useUI.setState({ welcomeOpen: false });
    if (dismiss) updateSettings({ welcomeDismissed: true });
  };
  return (
    <Modal onClose={() => close()} width={560} className="welcome-modal" testId="welcome-modal" align="center">
      <div className="welcome">
        <Logo size={40} />
        <h2>Sen へようこそ</h2>
        <p className="muted">チームの仕事を、もっと速く、もっと静かに。</p>
        <div className="welcome-points">
          <div>
            <Zap size={18} />
            <div>
              <b>待ち時間のない操作</b>
              <span>すべての画面は手元のデータから即座に表示され、変更は裏で同期されます。</span>
            </div>
          </div>
          <div>
            <Keyboard size={18} />
            <div>
              <b>キーボードで完結</b>
              <span>
                <Kbd combo="mod+k" /> でコマンドパレット、<Kbd combo="c" /> で課題作成、<Kbd combo="?" /> で一覧。
              </span>
            </div>
          </div>
          <div>
            <Workflow size={18} />
            <div>
              <b>迷わないワークフロー</b>
              <span>バックログ → 未着手 → 進行中 → 完了。プロジェクトとサイクルでリズムを作ります。</span>
            </div>
          </div>
        </div>
        <div className="welcome-actions">
          <Button
            variant="primary"
            icon={<PlayCircle size={15} />}
            onClick={() => {
              close();
              navigate(`/${ws}/help`);
            }}
          >
            使い方動画を見る
          </Button>
          <Button onClick={() => close()} data-testid="welcome-start">
            はじめる
          </Button>
        </div>
      </div>
    </Modal>
  );
}
