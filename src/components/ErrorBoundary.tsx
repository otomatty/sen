import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/** 一部の画面でエラーが起きても、アプリ全体が真っ白にならないようにする */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: (error: Error, reset: () => void) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("画面の描画中にエラーが発生しました", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="page">
        <div className="empty-state">
          <div className="empty-icon">
            <AlertTriangle size={26} />
          </div>
          <div className="empty-title">この画面を表示できませんでした</div>
          <div className="empty-desc">
            一時的な問題の可能性があります。データは保存されています。
            <br />
            <code className="muted small">{error.message}</code>
          </div>
          <div className="empty-action">
            <button className="btn btn-primary btn-md" onClick={() => window.location.reload()}>
              再読み込み
            </button>
          </div>
        </div>
      </div>
    );
  }
}
