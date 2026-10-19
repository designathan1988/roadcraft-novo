// The About box: version, the game's own credits, and the licences of the asset packs shipped with it (people
// and their animations). The licence files are read from the build when the box opens, so a pack that is not in
// this build is simply not listed; their legal texts are shown as written, in a fold.

import { el } from './dom.ts';
import { fmtInt, t, onLanguageChange } from './i18n.ts';
import { steamName } from '../steam.ts';

declare const __BUILD__: string;

/** An asset pack: its name, licence and author (dictionary keys), and the files that hold its licence. */
interface Pack { name: string; licence: string; author: string; text?: string; list?: string }

const PACKS: readonly Pack[] = [
  { name: 'ui.about.pack.makehuman', licence: 'CC0 1.0', author: 'ui.about.author.makehuman', text: 'models/people/LICENSE-MakeHuman-CC0.txt', list: 'models/people/LICENSES.json' },
  { name: 'ui.about.pack.rocketbox', licence: 'MIT', author: 'ui.about.author.rocketbox', text: 'models/citizens/LICENSE-MICROSOFT.txt' },
  { name: 'ui.about.pack.quaternius', licence: 'CC0 1.0', author: 'ui.about.author.quaternius', text: 'models/citizens/LICENSE-ANIMATIONS.txt' },
  { name: 'ui.about.pack.proxies', licence: 'CC0 1.0', author: 'ui.about.author.proxies', list: 'models/people/proxies/index.json' },
];

/** A file of the build, or null when it is not there. */
async function read(path: string): Promise<string | null> {
  try {
    const r = await fetch(path);
    if (!r.ok) return null;
    const text = await r.text();
    // a missing file can come back as the page itself (a dev server's fallback)
    return text.trimStart().startsWith('<!doctype') || text.trimStart().startsWith('<html') ? null : text;
  } catch { return null; }
}

interface AssetEntry { licence?: string; license?: string; author?: string; name?: string; path?: string; source?: string }

/** The entries of a licence list, whatever its shape ({assets: [...]}, {items: [...]} or a plain array). */
function entries(json: unknown): AssetEntry[] {
  if (Array.isArray(json)) return json as AssetEntry[];
  const o = json as { assets?: unknown; items?: unknown; files?: unknown };
  for (const v of [o?.assets, o?.items, o?.files]) if (Array.isArray(v)) return v as AssetEntry[];
  return [];
}

export class AboutBox {
  readonly root: HTMLElement;
  private packs: HTMLElement;
  private loaded = false;
  /** Who plays, when the game runs through Steam (empty otherwise). */
  private steam = el('p', 'v2-muted');

  constructor() {
    this.root = el('div', 'v2-dialog-back');
    this.root.hidden = true;
    this.packs = el('div', 'about-packs');
    this.build();
    // another language: written again; the licences are read again when it is next opened (or now, if it is open)
    onLanguageChange(() => { this.build(); this.loaded = false; if (this.isOpen) this.open(); });
    this.root.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === this.root) this.close(); });
    this.root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  private build(): void {
    const d = el('div', 'v2-dialog about');
    const close = el('button', 'v2-btn primary', t('about.close'));
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    const foot = el('div', 'opt-buttons');
    foot.append(close);
    d.append(
      el('h2', '', t('ui.about.title')),
      el('p', 'v2-muted', `${t('about.build')}: ${typeof __BUILD__ === 'string' ? __BUILD__ : ''}`),
      this.steam,
      el('p', '', t('ui.about.credits')),
      el('h3', '', t('ui.about.assets')),
      this.packs,
      foot,
    );
    this.root.replaceChildren(d);
  }

  get isOpen(): boolean { return !this.root.hidden; }
  close(): void { this.root.hidden = true; }

  open(): void {
    this.root.hidden = false;
    if (!this.loaded) {
      this.loaded = true;
      void this.fill();
      void steamName().then((name) => { this.steam.textContent = name ? t('ui.about.steam', { name }) : ''; this.steam.hidden = !name; });
    }
  }

  /** Reads each pack's licence files once; packs without any file in this build are left out. */
  private async fill(): Promise<void> {
    this.packs.replaceChildren(el('p', 'v2-muted', t('map.loading')));
    const shown: HTMLElement[] = [];
    for (const p of PACKS) {
      const [text, list] = await Promise.all([p.text ? read(p.text) : null, p.list ? read(p.list) : null]);
      if (text === null && list === null) continue;
      const box = el('section', 'about-pack');
      const head = el('div', 'about-pack-head');
      head.append(el('strong', '', t(p.name)));
      if (p.licence) head.append(el('span', 'about-licence', p.licence));
      box.append(head);
      if (p.author) box.append(el('div', 'v2-muted', t(p.author)));
      if (list !== null) {
        let rows: AssetEntry[] = [];
        try { rows = entries(JSON.parse(list)); } catch { rows = []; }
        // one line per licence and author, with how many files
        const groups = new Map<string, number>();
        for (const r of rows) {
          const key = `${r.licence ?? r.license ?? '?'}|${r.author ?? (p.author ? t(p.author) : '?')}`;
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        const ul = el('ul', 'about-list');
        for (const [key, n] of [...groups].sort((a, b) => b[1] - a[1])) {
          const [lic, author] = key.split('|');
          ul.append(el('li', '', t('ui.about.files', { n: fmtInt(n), licence: lic, author })));
        }
        if (rows.length) box.append(ul);
      }
      if (text !== null) {
        const fold = el('details', 'about-text');
        fold.append(el('summary', '', t('ui.about.showLicence')), el('pre', '', text));
        box.append(fold);
      }
      shown.push(box);
    }
    this.packs.replaceChildren(...(shown.length ? shown : [el('p', 'v2-muted', t('ui.about.noAssets'))]));
  }
}
