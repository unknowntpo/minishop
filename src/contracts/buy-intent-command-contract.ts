import Ajv from "ajv";

import buyIntentCommandSchema from "@/contracts/buy-intent-command.schema.json";
import type { BuyIntentCommand } from "@/src/domain/checkout-command/buy-intent-command";

const ajv = new Ajv({
  allErrors: true,
  strict: true,
});

const validateBuyIntentCommandSchema = ajv.compile(buyIntentCommandSchema);

export function isBuyIntentCommandContract(value: unknown): value is BuyIntentCommand {
  return validateBuyIntentCommandSchema(value) as boolean;
}

export function assertValidBuyIntentCommandContract(
  value: unknown,
): asserts value is BuyIntentCommand {
  if (validateBuyIntentCommandSchema(value)) {
    return;
  }

  throw new Error(
    `Invalid BuyIntentCommand contract: ${ajv.errorsText(validateBuyIntentCommandSchema.errors, {
      separator: "; ",
    })}`,
  );
}

export function parseBuyIntentCommandContract(value: unknown): BuyIntentCommand {
  assertValidBuyIntentCommandContract(value);
  return value;
}
