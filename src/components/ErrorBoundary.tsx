import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time exceptions so a crash shows a readable message instead of
 * a blank (black) window, and logs the stack to the console for diagnosis.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaces in the renderer console (and main-process capture in dev).
    console.error("Renderer error:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
          <h2>Something went wrong.</h2>
          <p>The view crashed while rendering. Details:</p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              background: "rgba(127,127,127,0.15)",
              padding: 12,
              borderRadius: 6,
              maxHeight: "50vh",
              overflow: "auto",
            }}
          >
            {String(error.stack || error.message)}
          </pre>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
