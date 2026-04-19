"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const devLinks = [
  {
    href: "/internal/design-system",
    label: "Design System",
  },
  {
    href: "/internal/benchmarks",
    label: "Benchmarks",
  },
  {
    href: "/internal/admin",
    label: "Admin",
  },
] as const;

export function BuyerDevMenu() {
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

  if (process.env.NODE_ENV === "production") {
    return null;
  }

  return (
    <div className="buyer-dev-menu" ref={menuRef}>
      <button
        aria-expanded={open}
        aria-label="Open developer menu"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        Dev
      </button>
      {renderPanel ? (
        <div className={`buyer-dev-panel${open ? " visible" : ""}`}>
          <p className="buyer-dev-title">Developer</p>
          <nav className="buyer-dev-links" aria-label="Developer shortcuts">
            {devLinks.map((link) => (
              <Link key={link.href} href={link.href} onClick={() => setOpen(false)}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}
    </div>
  );
}
