/** Workspace preparation and native startup share this server deadline. */
export const ORDINARY_COMMAND_STARTUP_TIMEOUT_MS = 120_000;

/** Keep the receipt channel open through startup, including response delivery. */
export const ORDINARY_COMMAND_RECEIPT_TIMEOUT_MS = ORDINARY_COMMAND_STARTUP_TIMEOUT_MS + 15_000;
