import { Game, status } from './game.ts';
import { initLang, storedLang, t } from './ui/i18n.ts';

async function boot(): Promise<void> {
  // ?lang=en forces English (photos and tests)
  const q = new URLSearchParams(location.search).get('lang');
  initLang(q === 'en' ? 'en' : q === 'pt' ? 'pt-BR' : storedLang());
  document.title = t('ui.title');
  document.getElementById('loading-text')!.textContent = t('map.loading');
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  if (!crossOriginIsolated) {
    document.getElementById('loading-text')!.textContent = t('ui.error.isolation');
    return;
  }
  const game = new Game(canvas);
  try {
    await game.start();
  } catch (err) {
    console.error(err);
    status.value = 'falhou';
    game.hud.fatal(t('ui.error.start', { message: err instanceof Error ? err.message : String(err) }));
  }
}

void boot();
