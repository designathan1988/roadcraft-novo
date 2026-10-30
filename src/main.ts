import { Game } from './game.ts';
import { Lifecycle } from './app/lifecycle.ts';
import { initLang, storedLang, t } from './shared/i18n/index.ts';
import { bootGame } from './ui/boot.ts';

async function boot(): Promise<void> {
  // ?lang=en forces English (photos and tests)
  const q = new URLSearchParams(location.search).get('lang');
  initLang(q === 'en' ? 'en' : q === 'pt' ? 'pt-BR' : storedLang());
  document.title = t('ui.title');
  document.getElementById('loading-text')!.textContent = t('map.loading');
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  // the lifecycle outlives a game that fails to start (the shell and the checks read it as the status)
  const life = new Lifecycle();
  await bootGame({
    isolated: crossOriginIsolated,
    create: () => new Game(canvas, life),
    show: (text) => { document.getElementById('loading-text')!.textContent = text; loading.classList.add('error'); loading.classList.remove('hidden'); },
    failed: () => life.loadFailed(),
  });
}

void boot();
