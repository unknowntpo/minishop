import http from "k6/http";
import { check } from "k6";

const target = __ENV.TARGET_URL || "http://benchmark-go-backend:3000";
const requests = Number(__ENV.K6_REQUESTS || "10000");
const vus = Number(__ENV.K6_VUS || "300");
const skuId = __ENV.K6_SKU_ID || "sku_hot_001";

export const options = {
  scenarios: {
    seckill: {
      executor: "shared-iterations",
      vus,
      iterations: requests,
      maxDuration: __ENV.K6_MAX_DURATION || "60s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  const index = `${__VU}-${__ITER}`;
  const payload = JSON.stringify({
    buyerId: `k6_buyer_${index}`,
    items: [
      {
        skuId,
        quantity: 1,
        unitPriceAmountMinor: 1200,
        currency: "TWD",
      },
    ],
  });

  const response = http.post(`${target}/api/buy-intents`, payload, {
    headers: {
      "content-type": "application/json",
      "idempotency-key": `k6-${__ENV.K6_RUN_ID || "local"}-${index}`,
      "x-request-id": `k6-request-${index}`,
      "x-trace-id": `k6-trace-${index}`,
    },
  });

  check(response, {
    "accepted": (res) => res.status === 202,
  });
}
