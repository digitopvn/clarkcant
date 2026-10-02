/*
 * TEST/DEV FIXTURE — NOT A REAL PROVIDER. Types for `fake-connector.mjs`, so a TypeScript test can drive it.
 */

export declare const FAKE_CLIENT_ID: string;
export declare const FAKE_SCOPES: string[];

export interface FakeTask {
  id: string;
  title: string;
  done: boolean;
}

export interface FakeConnectorMode {
  /** Scopes the consent screen grants; null grants every scope that was asked for. */
  grantScopes: string[] | null;
  accessTtlSeconds: number;
  issueRefresh: boolean;
  refreshFails: boolean;
  writeDelayMs: number;
  denyWith: string | null;
}

export interface FakeConnector {
  origin: string;
  adminOrigin: string;
  clientId: string;
  /** Every code and token issued so far. */
  secrets(): string[];
  stats(): { reads: number; writes: number; tasks: FakeTask[] };
  setMode(patch: Partial<FakeConnectorMode>): void;
  revokeAll(): void;
  close(): Promise<void>;
}

export declare function startFakeConnector(options?: { port?: number; adminPort?: number }): Promise<FakeConnector>;
