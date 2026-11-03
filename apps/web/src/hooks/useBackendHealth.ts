import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHealth } from "../lib/api";

export type BackendConnection = "checking" | "connected" | "unavailable";

export interface BackendHealth {
  connection: BackendConnection;
  /** Server-side Mapillary search token present (configured, not verified). Null while unknown. */
  searchConfigured: boolean | null;
  /** Server-side SAM key present (configured, not verified). Null while unknown. */
  samConfigured: boolean | null;
  /** SAM model name reported by the server (default sam-3.1). */
  samModel: string;
  retry: () => void;
}

/**
 * Shared backend health state: the header indicator and the search workflow
 * both derive from one poller instead of fetching independently.
 */
export function useBackendHealth(pollMs = 30_000): BackendHealth {
  const [connection, setConnection] = useState<BackendConnection>("checking");
  const [searchConfigured, setSearchConfigured] = useState<boolean | null>(null);
  const [samConfigured, setSamConfigured] = useState<boolean | null>(null);
  const [samModel, setSamModel] = useState("sam-3.1");
  const abortRef = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setConnection("checking");
    try {
      const health = await fetchHealth(controller.signal);
      if (controller.signal.aborted) return;
      setConnection(health.status === "ok" ? "connected" : "unavailable");
      const configured = health.providers?.mapillarySearch?.configured;
      setSearchConfigured(typeof configured === "boolean" ? configured : null);
      const sam = health.providers?.samDetection;
      setSamConfigured(typeof sam?.configured === "boolean" ? sam.configured : null);
      setSamModel(typeof sam?.model === "string" && sam.model.length > 0 ? sam.model : "sam-3.1");
    } catch {
      if (controller.signal.aborted) return;
      setConnection("unavailable");
      setSearchConfigured(null);
      setSamConfigured(null);
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = window.setInterval(() => {
      void check();
    }, pollMs);
    return () => {
      window.clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [check, pollMs]);

  const retry = useCallback(() => {
    void check();
  }, [check]);

  return { connection, searchConfigured, samConfigured, samModel, retry };
}
