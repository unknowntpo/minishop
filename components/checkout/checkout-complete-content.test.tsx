import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CheckoutCompleteContent } from "@/components/checkout/checkout-complete-content";

describe("CheckoutCompleteContent", () => {
  it("shows command context for queued checkout intents", () => {
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: () => "en",
        setItem: () => undefined,
      },
      configurable: true,
    });

    render(
      <CheckoutCompleteContent
        checkout={{
          cancellationReason: null,
          checkoutIntentId: "checkout-1",
          commandId: "command-1",
          commandStatus: "created",
          orderId: null,
          paymentId: null,
          rejectionReason: null,
          status: "queued",
          updatedAt: "2026-04-20T13:00:00.000Z",
        }}
        initialLocale="en"
      />,
    );

    expect(screen.getByText("This means the checkout intent was created, but downstream reservation or payment work has not started yet. Command status: created.")).toBeInTheDocument();
    expect(screen.getByText("command-1")).toBeInTheDocument();
    expect(screen.getByText("created")).toBeInTheDocument();
  });
});
