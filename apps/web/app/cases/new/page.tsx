import { redirect } from "next/navigation";

export default async function NewCasePage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source } = await searchParams;
  redirect(source ? `/?source=${encodeURIComponent(source)}` : "/");
}
