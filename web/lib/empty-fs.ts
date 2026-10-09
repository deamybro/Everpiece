// Stub for "fs/promises" in the web bundle: @taceo/merces-client only reads files for file: URLs (Node); in the
// browser its proving circuits load over HTTP, so this is never called. Throws loudly if it ever is.
export async function readFile(): Promise<never> {
  throw new Error("fs is not available in the browser");
}
export default { readFile };
