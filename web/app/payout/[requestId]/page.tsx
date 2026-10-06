import { notFound } from "next/navigation";
import { PayoutPay } from "../../../components/PayoutPay";

export default async function PayoutPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) notFound(); // malformed links never reach the app logic
  return <PayoutPay requestId={requestId.toLowerCase() as `0x${string}`} />;
}
