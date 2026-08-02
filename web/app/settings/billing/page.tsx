import { redirect } from 'next/navigation';

interface BillingReturnProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Compatibility path for old billing bookmarks.
 */
export default async function BillingReturn({ searchParams }: BillingReturnProps) {
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
