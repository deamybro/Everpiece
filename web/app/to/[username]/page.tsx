import { PayMe } from "../../../components/PayMe";

export default async function ToPage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <PayMe username={decodeURIComponent(username)} />;
}
