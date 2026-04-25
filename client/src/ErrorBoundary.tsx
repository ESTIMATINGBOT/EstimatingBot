import { Component, ReactNode } from "react";

interface Props { children: ReactNode; }
interface State { hasError: boolean; error?: Error; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: any) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ background: "#0a0a0a", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <div style={{ textAlign: "center", color: "#fff", maxWidth: 400 }}>
            <img src="/logoheader.jpg" alt="RCP" style={{ maxWidth: 200, marginBottom: 24 }} />
            <h2 style={{ color: "#C8D400", marginBottom: 12 }}>Something went wrong</h2>
            <p style={{ color: "#aaa", marginBottom: 24 }}>We hit an unexpected error. Your order may still have been placed — check your email or call us to confirm.</p>
            <p style={{ color: "#C8D400", fontWeight: "bold", fontSize: 20, marginBottom: 8 }}>469-631-7730</p>
            <p style={{ color: "#aaa", fontSize: 13, marginBottom: 24 }}>Mon–Fri 6:00 AM – 3:00 PM CST</p>
            <button
              onClick={() => { this.setState({ hasError: false }); window.location.hash = "#/"; }}
              style={{ background: "#C8D400", color: "#000", border: "none", padding: "12px 28px", borderRadius: 8, fontWeight: "bold", cursor: "pointer", fontSize: 15 }}
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
