// Starting the game, and what the player reads when it cannot start: the page without cross-origin isolation (opened
// as a plain file, or from a server without its headers), a failure building the game (no graphics adapter, say)
// or a failure while it loads. Never a "Loading…" that stays forever.

import { t } from '../shared/i18n/index.ts';

export interface BootDeps {
  /** The page has cross-origin isolation (SharedArrayBuffer). */
  isolated: boolean;
  /** Builds the game (throws when it cannot). */
  create(): { start(): Promise<void> };
  /** Writes the line under the title of the loading screen. */
  show(text: string): void;
  /** The game did not start (for the automated photos and checks). */
  failed(): void;
}

export async function bootGame(d: BootDeps): Promise<void> {
  if (!d.isolated) { d.show(t('ui.error.isolation')); d.failed(); return; }
  try {
    await d.create().start();
  } catch (err) {
    console.error(err);
    d.failed();
    d.show(t('ui.error.start', { message: err instanceof Error ? err.message : String(err) }));
  }
}
