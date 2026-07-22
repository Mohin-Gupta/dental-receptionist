import type { AuthContext } from '../auth/types';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** Exact bytes received from webhook providers, captured before JSON parsing. */
      rawBody?: Buffer;
      /** Authentication method established by a machine-to-machine verifier. */
      machineAuth?: {
        provider: string;
        method: 'hmac' | 'bearer' | 'development';
      };
    }
  }
}

export {};
