import { Game, status } from './game.ts';
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
  await bootGame({
    isolated: crossOriginIsolated,
    create: () => new Game(canvas),
    show: (text) => { document.getElementById('loading-text')!.textContent = text; loading.classList.add('error'); loading.classList.remove('hidden'); },
    failed: () => { status.value = 'falhou'; },
  });
}

void boot();
