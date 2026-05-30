import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

interface Props {
  /** Where to send a label when reporting (just a console tag, free-form). */
  label?: string;
  /** UI to show when the boundary trips. Receives the error + a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Minimal React error boundary. Keeps a tree alive even when one branch
 * crashes during render — used at the sidebar root so the Phaser canvas
 * never dies because a React component had an off-day.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ""}]`, error, info);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        this.props.fallback?.(this.state.error, this.reset) ?? (
          <div className="error-boundary-default">
            <p>{t("errorboundary.something")}</p>
            <button onClick={this.reset}>{t("errorboundary.try_again")}</button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
