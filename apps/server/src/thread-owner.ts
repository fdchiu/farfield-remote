export function resolveOwnerClientId(
  threadOwnerById: Map<string, string>,
  threadId: string,
  override?: string
): string {
  if (override && override.trim()) {
    return override.trim();
  }

  const mapped = threadOwnerById.get(threadId);
  if (!mapped) {
    throw new Error(
      "No owner client id is known for this thread yet. Open the thread in the desktop app first."
    );
  }

  return mapped;
}
