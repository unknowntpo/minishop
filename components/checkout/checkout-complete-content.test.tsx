import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CheckoutCompleteContent } from "@/components/checkout/checkout-complete-content";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe("CheckoutCompleteContent", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: () => "en",
        setItem: () => undefined,
      },
      configurable: true,
    });
  });

  it("shows command context for queued checkout intents", () => {
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

  it("shows payment actions while checkout is waiting for payment", () => {
    render(
      <CheckoutCompleteContent
        checkout={{
          cancellationReason: null,
          checkoutIntentId: "checkout-2",
          commandId: "command-2",
          commandStatus: "created",
          orderId: null,
          paymentId: "payment-1",
          rejectionReason: null,
          status: "pending_payment",
          updatedAt: "2026-04-20T13:05:00.000Z",
        }}
        initialLocale="en"
      />,
    );

    expect(
      screen.getByText(
        "Payment was requested and is now waiting for the provider result. Use the demo buttons here to simulate success or failure.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simulate payment success" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simulate payment failure" })).toBeInTheDocument();
  });
});
