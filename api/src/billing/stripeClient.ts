import { getStripeRuntimeConfig } from './config';

export type StripeFormValue = string | number | boolean;

export interface StripeRequestOptions {
  form?: Array<readonly [string, StripeFormValue]>;
  query?: Array<readonly [string, StripeFormValue]>;
  idempotencyKey?: string;
}

interface StripeErrorBody {
  error?: {
    message?: string;
    code?: string;
    type?: string;
    param?: string;
  };
}

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly stripeCode?: string,
    readonly stripeType?: string,
    readonly requestId?: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

function retryableStatus(status: number): boolean {
  return status === 409 || status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  }
  return Math.min(200 * 2 ** attempt + Math.floor(Math.random() * 100), 2_000);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StripeApiError(
      'Stripe returned an invalid response',
      response.status,
      undefined,
      undefined,
      response.headers.get('request-id') ?? undefined,
      response.status >= 500
    );
  }
}

export async function stripeRequest<T extends object>(
  method: 'GET' | 'POST',
  path: string,
  options: StripeRequestOptions = {}
): Promise<T> {
  if (!path.startsWith('/v1/')) throw new Error('Stripe API path must start with /v1/');
  if (options.idempotencyKey && options.idempotencyKey.length > 255) {
    throw new Error('Stripe idempotency key exceeds 255 characters');
  }

  const config = getStripeRuntimeConfig();
  const url = new URL(`${config.apiBaseUrl}${path}`);
  for (const [key, value] of options.query ?? []) url.searchParams.append(key, String(value));

  const mayRetry = method === 'GET' || Boolean(options.idempotencyKey);
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.secretKey}`,
        Accept: 'application/json',
      };
      if (config.apiVersion) headers['Stripe-Version'] = config.apiVersion;
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

      let body: URLSearchParams | undefined;
      if (method === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams();
        for (const [key, value] of options.form ?? []) body.append(key, String(value));
      }

      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const parsed = await responseJson(response);

      if (response.ok) return parsed as T;

      const stripeError = parsed as StripeErrorBody;
      const retryable = retryableStatus(response.status);
      const error = new StripeApiError(
        stripeError.error?.message || 'Stripe rejected the request',
        response.status,
        stripeError.error?.code,
        stripeError.error?.type,
        response.headers.get('request-id') ?? undefined,
        retryable
      );

      if (!retryable || !mayRetry || attempt === config.maxRetries) throw error;
      lastError = error;
      await wait(retryDelayMs(attempt, response));
    } catch (error) {
      if (error instanceof StripeApiError && !error.retryable) throw error;
      lastError = error;
      if (!mayRetry || attempt === config.maxRetries) {
        if (error instanceof StripeApiError) throw error;
        const timedOut = error instanceof Error && error.name === 'AbortError';
        throw new StripeApiError(
          timedOut ? 'Stripe request timed out' : 'Stripe is temporarily unavailable',
          0,
          undefined,
          undefined,
          undefined,
          true
        );
      }
      await wait(retryDelayMs(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Stripe request failed');
}

export function stripePathId(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error('Invalid Stripe resource ID');
  return encodeURIComponent(value);
}
