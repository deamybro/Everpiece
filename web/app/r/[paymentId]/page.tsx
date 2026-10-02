import { notFound } from "next/navigation";
import { ReceiptView } from "../../../components/ReceiptView";

export default async function ReceiptPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(paymentId)) notFound();
  return <ReceiptView paymentId={paymentId.toLowerCase() as `0x${string}`} />;
}
