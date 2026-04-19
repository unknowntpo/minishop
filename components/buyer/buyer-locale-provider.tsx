"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import {
  type BuyerLocale,
  buyerLocaleCookieName,
  buyerLocaleStorageKey,
  buyerLocaleToHtmlLang,
  getBuyerMessages,
  normalizeBuyerLocale,
} from "@/src/presentation/i18n/buyer-localization";

type BuyerLocaleContextValue = {
  locale: BuyerLocale;
  setLocale: (locale: BuyerLocale) => void;
};

const BuyerLocaleContext = createContext<BuyerLocaleContextValue | null>(null);

export function BuyerLocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: BuyerLocale;
}) {
  const [locale, setLocaleState] = useState<BuyerLocale>(normalizeBuyerLocale(initialLocale));

  useEffect(() => {
    const storedLocale = normalizeBuyerLocale(window.localStorage.getItem(buyerLocaleStorageKey));

    setLocaleState((current) => (current === storedLocale ? current : storedLocale));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(buyerLocaleStorageKey, locale);
    void window.cookieStore?.set({
      name: buyerLocaleCookieName,
      value: locale,
      path: "/",
      sameSite: "lax",
      expires: Date.now() + 31536000000,
    });
    document.documentElement.lang = buyerLocaleToHtmlLang(locale);
  }, [locale]);

  const value = useMemo<BuyerLocaleContextValue>(
    () => ({
      locale,
      setLocale: (nextLocale) => setLocaleState(normalizeBuyerLocale(nextLocale)),
    }),
    [locale],
  );

  return <BuyerLocaleContext.Provider value={value}>{children}</BuyerLocaleContext.Provider>;
}

export function useBuyerLocale() {
  const context = useContext(BuyerLocaleContext);

  if (!context) {
    return {
      locale: "zh-TW" as BuyerLocale,
      setLocale: () => undefined,
      messages: getBuyerMessages("zh-TW"),
    };
  }

  return {
    ...context,
    messages: getBuyerMessages(context.locale),
  };
}
