/** An error's message for the player's notices. */
export function errorText(err: unknown): string { return (err as Error)?.message ?? String(err); }
