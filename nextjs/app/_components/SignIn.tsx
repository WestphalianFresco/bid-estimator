"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The sign-in control.
 *
 * There is no account system behind this yet, and the button says so rather
 * than pretending otherwise. A sign-in box that accepts an address and then
 * silently does nothing is worse than no sign-in box: someone types a real
 * password into it eventually.
 *
 * What it does do is hold the place — the topbar slot, the popover, the
 * keyboard and outside-click behaviour are all real, so wiring an auth provider
 * in later is a matter of replacing the panel body, not rebuilding the control.
 */
export function SignIn() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  // Close on Escape or on a click anywhere outside the popover.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div className="signin" ref={wrap}>
      <button
        type="button"
        className="signin-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        Sign in
      </button>

      {open && (
        <div className="signin-panel" role="dialog" aria-label="Sign in">
          <p className="signin-title">Accounts aren&rsquo;t enabled yet</p>
          <p className="signin-body">
            This build runs entirely in your browser session. Estimates are not stored on a
            server, so there is nothing to sign in to and nothing to sign out of — closing the
            tab discards the work.
          </p>
          <p className="signin-body">
            Turning this on means adding an auth provider and somewhere to keep estimate
            snapshots. Until then, use <strong>Print / PDF</strong> or <strong>Markdown</strong>
            {" "}to keep a copy.
          </p>
          <button type="button" className="link-btn signin-ok" onClick={() => setOpen(false)}>
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
