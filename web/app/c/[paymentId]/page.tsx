import { notFound } from "next/navigation";
import { ClaimFlow } from "../../../components/ClaimFlow";

export default async function ClaimPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(paymentId)) notFound();
  return <ClaimFlow paymentId={paymentId.toLowerCase() as `0x${string}`} />;
}
