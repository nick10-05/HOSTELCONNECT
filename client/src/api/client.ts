// The one place the app talks to the server. Every endpoint function in src/api
// goes through apiFetch, so errors always arrive as an ApiError.

export class ApiError extends Error {
  constructor(
    // HTTP status, or 0 when the server could not be reached at all.
    readonly status: number,
    // The server's error code (design doc, section 5), e.g. "invalid_credentials".
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Options = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown };

// `body` is sent as JSON, or as it is when it is FormData (a file upload, day 8): the
// browser then writes the multipart Content-Type with its boundary itself.
export async function apiFetch<T>(path: string, { method = "GET", body }: Options = {}): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      // Same origin as the API, so the httpOnly session cookie goes along by itself.
      credentials: "same-origin",
      headers: body === undefined || isForm ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Cannot reach the server. Check your connection and try again.");
  }

  // Some answers have no JSON body (204, or an HTML error page from a proxy).
  const data: unknown = await res.json().catch(() => undefined);
  if (res.ok) return data as T;

  const error = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
  throw new ApiError(
    res.status,
    error?.code ?? `http_${res.status}`,
    error?.message ?? "Something went wrong. Please try again.",
  );
}
