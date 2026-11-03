import { BackendStatus } from "./BackendStatus";
import type { BackendHealth } from "../hooks/useBackendHealth";

export function Header({ health }: { health: BackendHealth }) {
  return (
    <header className="app-header">
      <div className="app-title">
        <h1>OpenStreetLightMapper</h1>
        <p className="subtitle">AI-assisted public-lighting inventory</p>
      </div>
      <BackendStatus health={health} />
    </header>
  );
}
