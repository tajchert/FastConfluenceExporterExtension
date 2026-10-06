export interface MockRequest {
  method: string;
  path: string;
  host?: string;
  cookie: boolean;
  at: number;
}

export interface MockConfluence {
  flavour: 'cloud' | 'server';
  port: number;
  origin: string;
  baseUrl: string;
  contextPath: string;
  url(path: string): string;
  log: MockRequest[];
  config: {
    delayMs: number;
    imageDelayMs: number;
    /** Public site: anonymous access without the session cookie. */
    publicAccess: boolean;
    /** Destroy the connection of the next `dropCount` requests whose path contains `dropPath`. */
    dropPath: string;
    dropCount: number;
  };
  reset(): void;
  close(): Promise<void>;
}

export function startMockConfluence(o?: {
  flavour?: 'cloud' | 'server';
  port?: number;
  host?: string;
  publicHost?: string;
}): Promise<MockConfluence>;

export function makePng(width?: number, height?: number): Uint8Array;
