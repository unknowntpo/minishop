import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readStatus = vi.fn();

vi.mock("@/src/infrastructure/checkout-command", () => ({
  postgresBuyIntentCommandGateway: {
    readStatus,
  },
}));

describe("GET /api/buy-intent-commands/:commandId", () => {
  beforeEach(() => {
    readStatus.mockReset();
  });

  it("returns the command status projection", async () => {
    readStatus.mockResolvedValue({
      commandId: "11111111-1111-4111-8111-111111111111",
      correlationId: "22222222-2222-4222-8222-222222222222",
      status: "created",
      checkoutIntentId: "33333333-3333-4333-8333-333333333333",
      eventId: "44444444-4444-4444-8444-444444444444",
      isDuplicate: false,
      failureCode: null,
      failureMessage: null,
      createdAt: new Date("2026-04-20T03:00:00.000Z"),
      updatedAt: new Date("2026-04-20T03:00:10.000Z"),
    });

    const { GET } = await import("./route");

    const request = new NextRequest(
      "http://localhost:3000/api/buy-intent-commands/11111111-1111-4111-8111-111111111111",
      {
        headers: {
          "x-request-id": "req_1",
          "x-trace-id": "trace_1",
        },
      },
    );

    const response = await GET(request, {
      params: Promise.resolve({
        commandId: "11111111-1111-4111-8111-111111111111",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      commandId: "11111111-1111-4111-8111-111111111111",
      correlationId: "22222222-2222-4222-8222-222222222222",
      status: "created",
      checkoutIntentId: "33333333-3333-4333-8333-333333333333",
      eventId: "44444444-4444-4444-8444-444444444444",
      isDuplicate: false,
      failureCode: null,
      failureMessage: null,
      createdAt: "2026-04-20T03:00:00.000Z",
      updatedAt: "2026-04-20T03:00:10.000Z",
    });
  });

  it("returns 404 when command status is missing", async () => {
    readStatus.mockResolvedValue(null);

    const { GET } = await import("./route");

    const request = new NextRequest(
      "http://localhost:3000/api/buy-intent-commands/11111111-1111-4111-8111-111111111111",
    );

    const response = await GET(request, {
      params: Promise.resolve({
        commandId: "11111111-1111-4111-8111-111111111111",
      }),
    });

    expect(response.status).toBe(404);
  });
});
