import type { HistoryItem } from "./history";

export type ActivityFilter = "All" | "Received" | "Sent" | "Awaiting claim" | "Claimed" | "Returned";
export const activityFilters: ActivityFilter[] = ["All", "Received", "Sent", "Awaiting claim", "Claimed", "Returned"];
export const isReturned = (item: HistoryItem) => item.state === "refunded" || item.state === "cancelled";
export function matchesActivity(item: HistoryItem, filter: ActivityFilter): boolean {
  switch (filter) {
    case "Received": return item.direction === "received";
    case "Sent": return item.direction === "sent";
    case "Awaiting claim": return item.state === "protected";
    case "Claimed": return item.state === "claimed";
    case "Returned": return isReturned(item);
    default: return true;
  }
}
export function activityLabel(item: HistoryItem): string {
  if (item.direction === "received" && (item.state === "paid" || item.state === "claimed")) return "Received";
  if (item.state === "protected") return "Awaiting claim";
  if (item.state === "expired") return "Expired · return available";
  if (item.state === "refunded") return "Refunded";
  if (item.state === "cancelled") return "Cancelled · returned";
  if (item.state === "claimed") return "Claimed";
  return item.direction === "received" ? "Received" : "Sent";
}
export function activityTitle(item: HistoryItem): string {
  if (item.counterparty === "yourself (converted to Dollars)") return "Converted to Dollars";
  return `${isReturned(item) ? "Returned payment to" : item.direction === "received" ? "Received from" : "Sent to"} ${item.counterparty}`;
}
