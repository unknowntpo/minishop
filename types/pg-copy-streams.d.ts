declare module "pg-copy-streams" {
  import type { Duplex, Writable } from "node:stream";

  export function from(sql: string): Writable;
  export function to(sql: string): Duplex;
  export function both(sql: string): Duplex;
}
