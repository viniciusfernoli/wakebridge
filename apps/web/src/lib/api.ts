export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      typeof result.message === "string"
        ? result.message
        : "Não foi possível concluir. Tente novamente.",
      response.status,
    );
  return result;
}
