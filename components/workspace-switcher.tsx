"use client";

/**
 * Workspace switcher
 *
 * Shows the active workspace and lets the user jump to another one or create a
 * new one. The choice lives in an httpOnly cookie set by /api/workspaces, so
 * after a change the server components re-render for the new workspace.
 */

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clearClientCache } from "@/lib/client-cache";
import { useI18n } from "@/lib/i18n/provider";
import type { WorkspaceSummary } from "@/lib/workspace";

interface WorkspaceSwitcherProps {
  workspaceId: string;
  workspaceName: string;
  workspaces: WorkspaceSummary[];
  /** Called after a switch, e.g. to close the mobile drawer. */
  onSwitched?: () => void;
}

const NAME_MAX_LENGTH = 60;

export default function WorkspaceSwitcher({
  workspaceId,
  workspaceName,
  workspaces,
  onSwitched,
}: WorkspaceSwitcherProps) {
  const { t, label } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startTransition] = useTransition();
  const disabled = busy || refreshing;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // The create form and any error start fresh every time the panel opens.
  function openPanel() {
    setCreating(false);
    setName("");
    setError(null);
    setOpen(true);
  }

  function close() {
    setOpen(false);
  }

  function showWorkspace() {
    clearClientCache();
    close();
    onSwitched?.();
    // A detail page (a campaign, say) belongs to the previous workspace, so go
    // back to the section's index before re-rendering.
    const section = `/${pathname.split("/")[1] || "dashboard"}`;
    startTransition(() => {
      if (pathname !== section) router.replace(section);
      router.refresh();
    });
  }

  async function post(url: string, body: unknown): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      return res.ok && payload?.success === true;
    } catch {
      return false;
    }
  }

  async function switchTo(id: string) {
    if (id === workspaceId) {
      close();
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await post("/api/workspaces/active", { workspaceId: id });
    setBusy(false);
    if (ok) showWorkspace();
    else setError(t("Could not switch workspace. Please try again."));
  }

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const ok = await post("/api/workspaces", { name: trimmed });
    setBusy(false);
    if (ok) showWorkspace();
    else setError(t("Could not create the workspace. Please try again."));
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : openPanel())}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${t("Switch workspace")}: ${workspaceName}`}
        disabled={refreshing}
        className="flex w-full items-center justify-between gap-2 rounded border border-border px-3 py-2 text-left transition-colors hover:bg-surface-hover disabled:opacity-60"
      >
        <span className="min-w-0">
          <span className="block text-xs text-muted">{t("Workspace")}</span>
          <span className="block truncate text-sm font-medium text-foreground">
            {workspaceName}
          </span>
        </span>
        <svg
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z" />
        </svg>
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute inset-x-0 top-full z-20 mt-1 rounded border border-border bg-surface p-1 shadow-lg"
        >
          <p className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            {t("Your workspaces")}
          </p>
          <ul className="max-h-64 overflow-y-auto">
            {workspaces.map((workspace) => {
              const active = workspace.id === workspaceId;
              return (
                <li key={workspace.id}>
                  <button
                    type="button"
                    onClick={() => switchTo(workspace.id)}
                    disabled={disabled}
                    aria-current={active ? "true" : undefined}
                    className={`flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm transition-colors hover:bg-surface-hover disabled:opacity-60 ${
                      active ? "font-medium text-foreground" : "text-muted hover:text-foreground"
                    }`}
                  >
                    <span className="min-w-0 truncate">{workspace.name}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {active ? "✓" : label(workspace.role)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-1 border-t border-border pt-1">
            {creating ? (
              <form onSubmit={createWorkspace} className="space-y-2 p-2">
                <label className="block text-xs text-muted" htmlFor={`${panelId}-name`}>
                  {t("Workspace name")}
                </label>
                <input
                  id={`${panelId}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={NAME_MAX_LENGTH}
                  autoFocus
                  required
                  className="w-full rounded border border-border bg-surface px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={disabled || !name.trim()}
                    className="flex-1 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                  >
                    {busy ? t("Creating…") : t("Create workspace")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setName("");
                      setError(null);
                    }}
                    className="rounded border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
                  >
                    {t("Cancel")}
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                disabled={disabled}
                className="w-full rounded px-2 py-2 text-left text-sm text-accent transition-colors hover:bg-surface-hover disabled:opacity-60"
              >
                + {t("New workspace")}
              </button>
            )}
          </div>

          {error && (
            <p role="alert" className="px-2 pb-2 text-xs text-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
