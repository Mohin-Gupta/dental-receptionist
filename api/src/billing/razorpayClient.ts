import crypto from 'node:crypto';
import { getRazorpayRuntimeConfig } from './config';

export type RazorpayRequestValue = string | number | boolean;
export type RazorpayHttpMethod = 'GET' | 'POST' | 'PATCH';

export interface RazorpayRequestOptions {
  query?: Array<readonly [string, RazorpayRequestValue]>;
  body?: unknown;
}

export type RazorpayNotes = Record<string, string> | [];

export interface RazorpayPlanEntity {
  id: string;
  entity: 'plan';
  interval: number;
  period: 'daily' | 'weekly' | 'monthly' | 'yearly';
  item: {
    id: string;
    active: boolean;
    name: string;
    description: string | null;
    amount: number;
    unit_amount?: number;
    currency: string;
    type?: string;
    unit?: string | null;
  };
  notes: RazorpayNotes;
  created_at: number;
}

export type RazorpaySubscriptionStatus =
  | 'created'
  | 'authenticated'
  | 'active'
  | 'pending'
  | 'halted'
  | 'cancelled'
  | 'completed'
  | 'expired'
  | 'paused';

export interface RazorpaySubscriptionEntity {
  id: string;
  entity: 'subscription';
  plan_id: string;
  customer_id: string | null;
  status: RazorpaySubscriptionStatus;
  current_start: number | null;
  current_end: number | null;
  ended_at: number | null;
  quantity: number;
  notes: RazorpayNotes;
  charge_at: number | null;
  start_at: number | null;
  end_at: number | null;
  auth_attempts: number;
  total_count: number;
  paid_count: number;
  customer_notify: boolean;
  created_at: number;
  expire_by: number | null;
  short_url: string | null;
  has_scheduled_changes: boolean;
  change_scheduled_at?: number | null;
  schedule_change_at?: 'now' | 'cycle_end' | null;
  source?: string;
  offer_id?: string | null;
  remaining_count?: number;
  payment_method?: string;
  pause_initiated_by?: string | null;
  cancel_initiated_by?: string | null;
}

interface RazorpayErrorBody {
  error?: {
    code?: string;
    description?: string;
    source?: string;
    step?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
    field?: string;
  };
}

export class RazorpayApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly razorpayCode?: string,
    readonly source?: string,
    readonly step?: string,
    readonly reason?: string,
    readonly field?: string,
    readonly requestId?: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'RazorpayApiError';
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 ||
    status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, 5_000);
    }
  }
  return Math.min(200 * 2 ** attempt + Math.floor(Math.random() * 100), 2_000);
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestId(response: Response): string | undefined {
  return response.headers.get('x-razorpay-request-id') ??
    response.headers.get('x-request-id') ??
    response.headers.get('request-id') ??
    undefined;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RazorpayApiError(
      'Razorpay returned an invalid response',
      response.status,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      requestId(response),
      response.ok || retryableStatus(response.status)
    );
  }
}

function errorFromResponse(response: Response, parsed: unknown): RazorpayApiError {
  const body = parsed && typeof parsed === 'object'
    ? parsed as RazorpayErrorBody
    : {};
  const providerError = body.error;
  return new RazorpayApiError(
    providerError?.description || 'Razorpay rejected the request',
    response.status,
    providerError?.code,
    providerError?.source,
    providerError?.step,
    providerError?.reason,
    providerError?.field,
    requestId(response),
    retryableStatus(response.status)
  );
}

export async function razorpayRequest<T extends object>(
  method: RazorpayHttpMethod,
  path: string,
  options: RazorpayRequestOptions = {}
): Promise<T> {
  if (!path.startsWith('/v1/') || path.includes('?') || path.includes('#')) {
    throw new Error('Razorpay API path must be an absolute /v1/ path without a query string');
  }
  if (method === 'GET' && options.body !== undefined) {
    throw new Error('Razorpay GET requests cannot include a body');
  }

  const config = getRazorpayRuntimeConfig();
  const url = new URL(`${config.apiBaseUrl}${path}`);
  for (const [key, value] of options.query ?? []) {
    url.searchParams.append(key, String(value));
  }

  const maxRetries = method === 'GET' ? config.maxGetRetries : 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const headers: Record<string, string> = {
        Authorization: `Basic ${Buffer.from(
          `${config.keyId}:${config.keySecret}`,
          'utf8'
        ).toString('base64')}`,
        Accept: 'application/json',
      };
      let body: string | undefined;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }

      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const parsed = await responseJson(response);
      if (response.ok) return parsed as T;

      const error = errorFromResponse(response, parsed);
      if (!error.retryable || attempt === maxRetries) throw error;
      lastError = error;
      await wait(retryDelayMs(attempt, response));
    } catch (error) {
      if (error instanceof RazorpayApiError) {
        if (!error.retryable || method !== 'GET' || attempt === maxRetries) throw error;
        lastError = error;
      } else {
        lastError = error;
        if (method !== 'GET' || attempt === maxRetries) {
          const timedOut = error instanceof Error && error.name === 'AbortError';
          throw new RazorpayApiError(
            timedOut ? 'Razorpay request timed out' : 'Razorpay is temporarily unavailable',
            0,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true
          );
        }
      }
      await wait(retryDelayMs(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Razorpay request failed');
}

export function razorpayPathId(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error('Invalid Razorpay resource ID');
  }
  return encodeURIComponent(value);
}

function normalizedProviderMessage(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Razorpay uses the generic `has_scheduled_changes` flag both for a
 * cancellation at cycle end and for a pending PATCH update. This endpoint is
 * specifically documented to return a pending PATCH update, so a successful
 * response means the generic flag cannot be treated as proof of cancellation.
 *
 * The documented 400 "No Pending update for this subscription" response is
 * the only negative response that is converted to `false`; every other error
 * remains fail-closed.
 */
export async function razorpayHasPendingSubscriptionUpdate(
  subscriptionId: string
): Promise<boolean> {
  try {
    await razorpayRequest<RazorpaySubscriptionEntity>(
      'GET',
      `/v1/subscriptions/${razorpayPathId(subscriptionId)}/retrieve_scheduled_changes`
    );
    return true;
  } catch (error) {
    if (
      error instanceof RazorpayApiError &&
      error.statusCode === 400 &&
      normalizedProviderMessage(error.message) ===
        'no pending update for this subscription'
    ) {
      return false;
    }
    throw error;
  }
}

export interface RazorpayCheckoutSignatureInput {
  paymentId: string;
  /**
   * This must come from the server-side checkout intent, never from the browser
   * callback's razorpay_subscription_id field.
   */
  expectedSubscriptionId: string;
  signature: string;
}

export function verifyRazorpayCheckoutSignature(
  input: RazorpayCheckoutSignatureInput
): boolean {
  if (
    !/^pay_[A-Za-z0-9]+$/.test(input.paymentId) ||
    !/^sub_[A-Za-z0-9]+$/.test(input.expectedSubscriptionId) ||
    !/^[a-fA-F0-9]{64}$/.test(input.signature)
  ) {
    return false;
  }

  const { keySecret } = getRazorpayRuntimeConfig();
  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${input.paymentId}|${input.expectedSubscriptionId}`, 'utf8')
    .digest();
  const supplied = Buffer.from(input.signature, 'hex');
  return supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);
}
