/** Request compact session snapshots without changing fetch response/error semantics. */
export function compactSessionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Explicit init headers replace Request headers, matching fetch's precedence.
  let headers: Headers;
  try {
    headers = new Headers(init?.headers !== undefined
      ? init.headers
      : typeof input === "object" && input !== null && "headers" in input ? input.headers : undefined);
    headers.set("X-Wand-Tool-Projection", "compact");
  } catch (error) {
    // Native fetch rejects invalid headers instead of throwing before returning.
    return Promise.reject(error);
  }
  return fetch(input, { ...init, headers });
}
