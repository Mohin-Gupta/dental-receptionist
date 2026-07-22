import { redirect } from 'next/navigation';

interface LegacyBillingReturnProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Compatibility return path for existing Stripe success/cancel URLs.
 * Keep this route until every configured Stripe Price uses /dashboard/billing.
 */
export default async function LegacyBillingReturn({ searchParams }: LegacyBillingReturnProps) {
  const values = await searchParams;
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) {
      value.forEach(item => query.append(key, item));
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  redirect(`/dashboard/billing${suffix}`);
}
