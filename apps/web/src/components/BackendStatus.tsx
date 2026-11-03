import type { BackendHealth } from "../hooks/useBackendHealth";

export function BackendStatus({ health }: { health: BackendHealth }) {
  const state = health.connection;
  return (
    <span className="backend-status" role="status" aria-live="polite">
      <span className={`backend-dot backend-dot--${state}`} aria-hidden="true" />
      {state === "connected" && "Backend: connected"}
      {state === "checking" && "Backend: checking…"}
      {state === "unavailable" && (
        <>
          Backend: unavailable{" "}
          <button type="button" className="link-button" onClick={health.retry}>
            Retry
          </button>
        </>
      )}
    </span>
  );
}
