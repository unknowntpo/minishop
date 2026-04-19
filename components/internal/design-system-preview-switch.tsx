"use client";

import { useState } from "react";

export function DesignSystemPreviewSwitch() {
  const [checked, setChecked] = useState(true);

  return (
    <button
      aria-checked={checked}
      className="design-preview design-preview-switch-row interactive"
      onClick={() => setChecked((current) => !current)}
      role="switch"
      type="button"
    >
      <span className="design-preview-switch-label">Reduced motion</span>
      <span className={`design-preview-switch${checked ? " on" : ""}`} aria-hidden="true">
        <span className="design-preview-switch-thumb" />
      </span>
    </button>
  );
}
