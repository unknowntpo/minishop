"use client";

import { useBuyerLocale } from "./buyer-locale-provider";

export function BuyerLocaleSwitcher() {
  const { locale, messages, setLocale } = useBuyerLocale();
  const isEnglish = locale === "en";

  return (
    <button
      aria-checked={isEnglish}
      aria-label={messages.localeLabel}
      className={`buyer-locale-switcher${isEnglish ? " is-en" : " is-zh"}`}
      onClick={() => setLocale(isEnglish ? "zh-TW" : "en")}
      role="switch"
      type="button"
    >
      <span className="buyer-locale-thumb" aria-hidden="true" />
      <span className="buyer-locale-option zh">{messages.localeOption["zh-TW"]}</span>
      <span className="buyer-locale-option en">{messages.localeOption.en}</span>
    </button>
  );
}
