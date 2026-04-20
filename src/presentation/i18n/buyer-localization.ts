import type { Product } from "@/src/domain/catalog/product";

export const buyerLocaleStorageKey = "minishop-buyer-locale";
export const buyerLocaleCookieName = "minishop-buyer-locale";

export const buyerLocales = ["zh-TW", "en"] as const;

export type BuyerLocale = (typeof buyerLocales)[number];

type ProductCopy = {
  name: string;
  summary: string;
  checkoutNote: string;
  imageAlt: string;
};

type BuyerMessages = {
  localeLabel: string;
  localeOption: Record<BuyerLocale, string>;
  navProducts: string;
  profile: {
    triggerLabel: string;
    panelTitle: string;
  };
  catalogEyebrow: string;
  catalogTitle: string;
  catalogDescription: string;
  catalogAvailable: (available: number) => string;
  productEyebrow: string;
  productInventoryAvailable: (available: number) => string;
  productInventoryState: {
    inStock: string;
    soldOut: string;
    projection: string;
  };
  quantityLabel: string;
  quantityHint: {
    none: string;
    max: (maxQuantity: number) => string;
  };
  actions: {
    addToCart: string;
    buyNow: string;
    soldOut: string;
    working: string;
    viewCart: string;
    remove: string;
    open: string;
    hide: string;
    checkoutCart: (totalAmount: string) => string;
  };
  finePrint: string;
  cart: {
    summary: string;
    emptyTitle: string;
    emptyBody: string;
    populatedBody: (units: number, skuCount: number) => string;
    drawerEyebrow: string;
    reviewTitle: string;
    itemMeta: (skuCode: string, subtotal: string) => string;
    emptyDrawerTitle: string;
    emptyDrawerBody: string;
    toastTitle: string;
    toastMessage: (productName: string, quantity: number) => string;
  };
  checkout: {
    submitting: string;
    accepted: string;
    completing: string;
    failed: string;
    queued: (checkoutIntentId: string) => string;
    rejected: string;
    cancelled: string;
    status: (checkoutIntentId: string, status: string) => string;
  };
  completion: {
    eyebrow: string;
    completeTitle: string;
    receivedTitle: string;
    subtitle: (checkoutIntentId: string, status: string) => string;
    queuedHelp: (commandStatus: string | null) => string;
    pendingPaymentHelp: string;
    paymentActionUnavailable: string;
    paymentActionFailed: string;
    actions: {
      payNow: string;
      failPayment: string;
    };
    metrics: {
      status: string;
      command: string;
      commandStatus: string;
      order: string;
      payment: string;
      updated: string;
    };
    notAvailable: string;
  };
};

const buyerMessages: Record<BuyerLocale, BuyerMessages> = {
  "zh-TW": {
    localeLabel: "語言",
    localeOption: {
      "zh-TW": "繁中",
      en: "EN",
    },
    navProducts: "商品列表",
    profile: {
      triggerLabel: "買家偏好設定",
      panelTitle: "個人設定",
    },
    catalogEyebrow: "商品",
    catalogTitle: "瀏覽可直接結帳的 SKU。",
    catalogDescription:
      "先挑選商品，再啟動 event-sourced buy flow。購物車結帳可以把多個商品一起送進同一筆 checkout intent，不把單一商品當成庫存邊界。",
    catalogAvailable: (available) => `可購買 ${formatBuyerNumber(available, "zh-TW")} 件`,
    productEyebrow: "直接購買",
    productInventoryAvailable: (available) =>
      `目前可購買：${formatBuyerNumber(available, "zh-TW")}`,
    productInventoryState: {
      inStock: "是否保留成功會在 checkout processing 後確認。",
      soldOut: "目前 projection 顯示這個 SKU 已售完。",
      projection: "projection",
    },
    quantityLabel: "數量",
    quantityHint: {
      none: "目前 projection 沒有可購買數量。",
      max: (maxQuantity) => `最多 ${formatBuyerNumber(maxQuantity, "zh-TW")} 件`,
    },
    actions: {
      addToCart: "加入購物車",
      buyNow: "立即購買",
      soldOut: "已售完",
      working: "處理中",
      viewCart: "查看購物車",
      remove: "移除",
      open: "展開",
      hide: "收合",
      checkoutCart: (totalAmount) => `結帳購物車 · ${totalAmount}`,
    },
    finePrint:
      "立即購買會立刻建立 checkout intent。購物車結帳會把多個 SKU 與數量合併成同一筆 intent。",
    cart: {
      summary: "購物車",
      emptyTitle: "購物車是空的",
      emptyBody: "先把商品加入購物車，再從這裡送出結帳。",
      populatedBody: (units, skuCount) =>
        `${formatBuyerNumber(units, "zh-TW")} 件商品 · ${formatBuyerNumber(skuCount, "zh-TW")} 個 SKU`,
      drawerEyebrow: "購物車結帳",
      reviewTitle: "檢查商品",
      itemMeta: (skuCode, subtotal) => `SKU ${skuCode} · ${subtotal}`,
      emptyDrawerTitle: "購物車還沒有商品。",
      emptyDrawerBody:
        "在任一商品頁按下「加入購物車」，再回到這裡一次送出包含多個 SKU 的 checkout intent。",
      toastTitle: "已加入購物車",
      toastMessage: (productName, quantity) =>
        `${productName} · 已加入 ${formatBuyerNumber(quantity, "zh-TW")} 件。`,
    },
    checkout: {
      submitting: "正在送出 checkout intent。",
      accepted: "已接受 checkout，正在刷新 projections。",
      completing: "正在完成結帳。",
      failed: "目前無法接受這筆 checkout，請稍後再試。",
      queued: (checkoutIntentId) =>
        `Checkout ${checkoutIntentId} 已排入佇列，接下來會進行 reservation processing。`,
      rejected: "這筆 checkout 已被拒絕。",
      cancelled: "這筆 checkout 已取消。",
      status: (checkoutIntentId, status) => `Checkout ${checkoutIntentId} 目前狀態：${status}。`,
    },
    completion: {
      eyebrow: "結帳結果",
      completeTitle: "結帳完成",
      receivedTitle: "已收到結帳",
      subtitle: (checkoutIntentId, status) => `Intent ${checkoutIntentId} 目前為 ${status}。`,
      queuedHelp: (commandStatus) =>
        `這表示 checkout intent 已經建立，後續 reservation 或 payment 流程尚未啟動。指令狀態：${commandStatus ?? "無資料"}。`,
      pendingPaymentHelp: "付款已建立，現在等待第三方付款結果。這裡可用 demo 按鈕模擬成功或失敗。",
      paymentActionUnavailable: "目前沒有可用的指令 ID，無法送出付款模擬。",
      paymentActionFailed: "付款模擬失敗，請稍後再試。",
      actions: {
        payNow: "模擬付款成功",
        failPayment: "模擬付款失敗",
      },
      metrics: {
        status: "狀態",
        command: "指令",
        commandStatus: "指令狀態",
        order: "訂單",
        payment: "付款",
        updated: "更新時間",
      },
      notAvailable: "無資料",
    },
  },
  en: {
    localeLabel: "Language",
    localeOption: {
      "zh-TW": "繁中",
      en: "EN",
    },
    navProducts: "Products",
    profile: {
      triggerLabel: "Buyer preferences",
      panelTitle: "Profile",
    },
    catalogEyebrow: "Products",
    catalogTitle: "Browse checkout-ready SKUs.",
    catalogDescription:
      "Select a product, then start the event-sourced buy flow. Cart checkout can reserve SKUs across multiple products without treating product as the inventory boundary.",
    catalogAvailable: (available) => `Available ${formatBuyerNumber(available, "en")}`,
    productEyebrow: "Direct buy",
    productInventoryAvailable: (available) =>
      `Available now: ${formatBuyerNumber(available, "en")}`,
    productInventoryState: {
      inStock: "Reservation is confirmed after checkout processing.",
      soldOut: "This SKU is sold out in the current projection.",
      projection: "projection",
    },
    quantityLabel: "Quantity",
    quantityHint: {
      none: "No units available in the current projection.",
      max: (maxQuantity) => `Max ${formatBuyerNumber(maxQuantity, "en")} units`,
    },
    actions: {
      addToCart: "Add to cart",
      buyNow: "Buy now",
      soldOut: "Sold out",
      working: "Working",
      viewCart: "View cart",
      remove: "Remove",
      open: "Open",
      hide: "Hide",
      checkoutCart: (totalAmount) => `Checkout cart · ${totalAmount}`,
    },
    finePrint:
      "Buy now creates a checkout intent immediately. Cart checkout combines multiple SKUs and quantities into one intent.",
    cart: {
      summary: "Cart",
      emptyTitle: "Cart is empty",
      emptyBody: "Add products here before checkout.",
      populatedBody: (units, skuCount) =>
        `${formatBuyerNumber(units, "en")} items · ${formatBuyerNumber(skuCount, "en")} SKUs`,
      drawerEyebrow: "Cart checkout",
      reviewTitle: "Review items",
      itemMeta: (skuCode, subtotal) => `SKU ${skuCode} · ${subtotal}`,
      emptyDrawerTitle: "No products in cart yet.",
      emptyDrawerBody:
        "Use Add to cart on any product page, then return here to submit one checkout intent with multiple SKUs.",
      toastTitle: "Added to cart",
      toastMessage: (productName, quantity) =>
        `${productName} · ${formatBuyerNumber(quantity, "en")} unit${quantity > 1 ? "s" : ""} added to cart.`,
    },
    checkout: {
      submitting: "Submitting checkout intent.",
      accepted: "Checkout accepted. Refreshing projections.",
      completing: "Completing checkout.",
      failed: "Checkout request could not be accepted. Please try again.",
      queued: (checkoutIntentId) =>
        `Checkout ${checkoutIntentId} is queued. Reservation processing is next.`,
      rejected: "Checkout was rejected.",
      cancelled: "Checkout was cancelled.",
      status: (checkoutIntentId, status) => `Checkout ${checkoutIntentId} status: ${status}.`,
    },
    completion: {
      eyebrow: "Checkout result",
      completeTitle: "Checkout complete",
      receivedTitle: "Checkout received",
      subtitle: (checkoutIntentId, status) => `Intent ${checkoutIntentId} is ${status}.`,
      queuedHelp: (commandStatus) =>
        `This means the checkout intent was created, but downstream reservation or payment work has not started yet. Command status: ${commandStatus ?? "n/a"}.`,
      pendingPaymentHelp: "Payment was requested and is now waiting for the provider result. Use the demo buttons here to simulate success or failure.",
      paymentActionUnavailable: "No command ID is available for the demo payment action.",
      paymentActionFailed: "Demo payment action failed. Please try again.",
      actions: {
        payNow: "Simulate payment success",
        failPayment: "Simulate payment failure",
      },
      metrics: {
        status: "Status",
        command: "Command",
        commandStatus: "Command status",
        order: "Order",
        payment: "Payment",
        updated: "Updated",
      },
      notAvailable: "n/a",
    },
  },
};

const localizedProducts: Record<BuyerLocale, Record<string, ProductCopy>> = {
  "zh-TW": {
    "limited-runner": {
      name: "限量跑鞋",
      summary: "高併發直接購買壓力測試用的熱門 SKU。",
      checkoutNote: "熱門單品 · event-sourced checkout",
      imageAlt: "限量跑鞋",
    },
    "everyday-tee": {
      name: "日常 T 恤",
      summary: "穩定販售的目錄商品，用來驗證 mixed-cart checkout 行為。",
      checkoutNote: "目錄商品 · 支援多 SKU 購物車",
      imageAlt: "日常 T 恤",
    },
    "travel-cap": {
      name: "旅行帽",
      summary: "適合作為購物車加購品的小型 SKU，用來觀察 reservation progress。",
      checkoutNote: "加購商品 · projection-backed inventory",
      imageAlt: "旅行帽",
    },
  },
  en: {},
};

export function normalizeBuyerLocale(locale: string | null | undefined): BuyerLocale {
  return locale === "en" || locale === "zh-TW" ? locale : "zh-TW";
}

export function buyerLocaleToHtmlLang(locale: BuyerLocale) {
  return locale === "zh-TW" ? "zh-Hant-TW" : "en";
}

export function getBuyerMessages(locale: BuyerLocale) {
  return buyerMessages[locale];
}

export function getLocalizedProduct(product: Product, locale: BuyerLocale): Product {
  const copy = localizedProducts[locale][product.slug];

  if (!copy) {
    return product;
  }

  return {
    ...product,
    name: copy.name,
    summary: copy.summary,
    checkoutNote: copy.checkoutNote,
    image: {
      ...product.image,
      alt: copy.imageAlt,
    },
  };
}

export function formatBuyerNumber(value: number, locale: BuyerLocale) {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatBuyerMoney(amountMinor: number, currency: string, locale: BuyerLocale) {
  const majorUnits = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);

  return `${currency} ${majorUnits}`;
}

export function formatBuyerDateTime(value: Date | string, locale: BuyerLocale) {
  const date = value instanceof Date ? value : new Date(value);

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
