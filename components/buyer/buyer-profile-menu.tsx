"use client";

import { useEffect, useRef, useState } from "react";

import { BuyerLocaleSwitcher } from "@/components/buyer/buyer-locale-switcher";

import { useBuyerLocale } from "./buyer-locale-provider";

export function BuyerProfileMenu() {
  const { messages } = useBuyerLocale();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [renderPanel, setRenderPanel] = useState(false);

  useEffect(() => {
    if (open) {
      setRenderPanel(true);
      return;
    }

    const timeout = window.setTimeout(() => {
      setRenderPanel(false);
    }, 220);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="buyer-profile-menu" ref={menuRef}>
      <button
        aria-expanded={open}
        aria-label={messages.profile.triggerLabel}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="buyer-profile-avatar" aria-hidden="true">
          U
        </span>
      </button>
      {renderPanel ? (
        <div className={`buyer-profile-panel${open ? " visible" : ""}`}>
          <p className="buyer-profile-title">{messages.profile.panelTitle}</p>
          <BuyerLocaleSwitcher />
        </div>
      ) : null}
    </div>
  );
}
