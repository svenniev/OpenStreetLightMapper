import type { ReactNode } from "react";
import { BackendStatus } from "./BackendStatus";
import type { BackendHealth } from "../hooks/useBackendHealth";

export interface HeaderProps {
  health: BackendHealth;
  /** Workspace menu (open/new/rename). */
  menu: ReactNode;
  /** Save state + Save now. */
  save: ReactNode;
  onOpenSettings: () => void;
}

export function Header({ health, menu, save, onOpenSettings }: HeaderProps) {
  return (
    <header className="app-header">
      <div className="app-title">
        <h1>OpenStreetLightMapper</h1>
        <p className="subtitle">AI-assisted public-lighting inventory</p>
      </div>
      <div className="header-workspace">{menu}</div>
      <div className="header-save">{save}</div>
      <div className="header-actions">
        <button type="button" className="toolbar-button" onClick={onOpenSettings}>
          Settings
        </button>
        <BackendStatus health={health} />
      </div>
    </header>
  );
}
