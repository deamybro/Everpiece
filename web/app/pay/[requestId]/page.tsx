import { notFound } from "next/navigation";
import { PayRequest } from "../../../components/PayRequest";

export default async function PayPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) notFound(); // malformed links never reach the app logic
  return <PayRequest requestId={requestId.toLowerCase() as `0x${string}`} />;
}
