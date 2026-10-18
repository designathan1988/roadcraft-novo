import { Game, status } from './game.ts';
import { currentLang, startTranslation } from './ui/i18n.ts';

async function boot(): Promise<void> {
  // ?lang=en força o inglês (fotos e testes)
  const q = new URLSearchParams(location.search).get('lang');
  startTranslation(q === 'en' || q === 'pt' ? q : currentLang());
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  if (!crossOriginIsolated) {
    document.getElementById('loading-text')!.textContent =
      'A página precisa de isolamento de origem (COOP/COEP). Abra pelo servidor do jogo (npm start) ou pelo executável.';
    return;
  }
  const game = new Game(canvas);
  try {
    await game.start();
  } catch (err) {
    console.error(err);
    status.value = 'falhou';
    game.hud.fatal(`Não foi possível iniciar: ${err instanceof Error ? err.message : String(err)}`);
  }
}

void boot();
