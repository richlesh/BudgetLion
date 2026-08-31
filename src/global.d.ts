import type { LedgerApi } from "./shared/ipc";

declare global {
  interface Window {
    ledger: LedgerApi;
  }
}

export {};
