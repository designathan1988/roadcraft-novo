// The people creator in Landscape > People (the people front's creator, src/render/people/creator.ts): who
// (sex, age), what they wear (an outfit card, top, bottom and hair colours), how tall, how many (1 to 20), what
// they do (stand, walk, a group in a ring) and what they hold. A click on the map places them (one undo step).
// Until the cooked people load, the engine's simple creator (colour, height, standing or walking, how many).

import type { DrawerHost, DrawerParts } from './drawers.ts';
import { section } from './drawers.ts';
import { card, choices, el, orow, range, select } from './dom.ts';
import { svg } from './icons.ts';
import { fmtDec, t } from './i18n.ts';

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

export function renderPeople(h: DrawerHost, p: DrawerParts, simpleColours: readonly string[]): void {
  const s = h.s, a = h.a;
  const cat = a.peopleCatalog?.() ?? null;
  if (!cat) {
    const ps = s.person, send = (): void => a.personSpec({ ...ps });
    const sw = el('div', 'v2-swatches');
    simpleColours.forEach((c, i) => {
      const b = el('button', `v2-swatch${ps.color === i ? ' on' : ''}`);
      b.type = 'button';
      b.style.setProperty('--c', c);
      b.title = t('ui.person.clothes');
      b.addEventListener('click', (e) => { e.stopPropagation(); ps.color = i; send(); h.render(); });
      sw.append(b);
    });
    p.options.append(orow(t('ui.person.clothes'), sw),
      range(t('ui.person.height'), 0, 15, 1, ps.height, (v) => `${fmtDec((0.86 + v * 0.02) * 1.75, 2)} m`, (v) => { ps.height = v; send(); }),
      orow(t('ui.person.behaviour'), choices([
        { label: t('ui.person.stand'), on: !ps.walk, run: () => { ps.walk = false; send(); h.render(); } },
        { label: t('ui.person.walk'), on: ps.walk, run: () => { ps.walk = true; send(); h.render(); } },
      ])),
      orow(t('ui.person.count'), choices([1, 2, 5, 10, 20].map((n) => ({ label: String(n), on: ps.count === n, run: () => { ps.count = n; send(); h.render(); } })))));
    p.strip.append(el('p', 'v2-note', t('hint.tool.person')));
    return;
  }
  const o = s.people;
  const send = (): void => a.personOptions?.({ ...o });
  const pick = (patch: Partial<typeof o>): void => { Object.assign(o, patch); send(); h.render(); };
  // the creator takes the screen's choices from the first time the panel shows
  send();
  // the outfits that fit the chosen sex and age, as cards
  const fits = cat.outfits.filter((f) => (o.sex === 'any' || f.sexes.includes(o.sex)) && (o.band === 'any' || f.bands.includes(o.band)));
  const outfits = section(p.strip, t('ui.people.outfit'));
  outfits.append(card(t('ui.people.any'), o.outfit === 'any', () => pick({ outfit: 'any' }), svg('crowd', 30)));
  for (const f of fits) outfits.append(card(outfitName(f.name, o.sex === 'any'), o.outfit === f.name, () => pick({ outfit: f.name }), svg('people', 30)));
  const modes = section(p.strip, t('ui.person.behaviour'));
  for (const [m, icon] of [['stand', 'people'], ['walk', 'player'], ['group', 'crowd']] as const) {
    modes.append(card(t(`ui.people.mode.${m}`), o.mode === m, () => pick(m === 'group' ? { mode: m, count: Math.max(o.count, 6) } : { mode: m }), svg(icon, 30)));
  }
  p.options.append(
    orow(t('ui.people.sex'), choices((['any', 'female', 'male'] as const).map((x) => ({ label: t(`ui.people.sex.${x}`), on: o.sex === x, run: () => pick({ sex: x, outfit: 'any' }) })))),
    orow(t('ui.people.age'), choices((['any', 'child', 'young', 'adult', 'senior'] as const).map((x) => ({ label: t(`ui.people.age.${x}`), on: o.band === x, run: () => pick({ band: x, outfit: 'any' }) })))),
    orow(t('ui.people.top'), swatches(cat.palettes.clothes, o.top, (i) => pick({ top: i }))),
    orow(t('ui.people.bottom'), swatches(cat.palettes.clothes, o.bottom, (i) => pick({ bottom: i }))),
    orow(t('ui.people.hair'), swatches(cat.palettes.hair, o.hair, (i) => pick({ hair: i }))),
    range(t('ui.person.height'), 85, 115, 1, Math.round(o.height * 100), (v) => `${v}%`, (v) => { o.height = v / 100; send(); }),
    range(t('ui.person.count'), 1, cat.maxCount, 1, o.count, (v) => String(v), (v) => { o.count = v; send(); }),
    orow(t('ui.people.hold'), select(t('ui.people.hold'), cat.holds.map((x) => [x, t(`ui.people.hold.${x}`)] as const), o.hold, (v) => pick({ hold: v as typeof o.hold }))),
    orow(t('ui.people.mixed'), choices([{ label: t('ui.people.mixed.on'), on: o.mixed, run: () => pick({ mixed: !o.mixed }) }])),
  );
}

/** A cooked outfit's name for the player ("male_casualsuit03" → "Casual 3"). */
export function outfitName(name: string, withSex = false): string {
  const m = /^(male|female)_([a-z]+?)(?:suit)?0*(\d+)$/.exec(name);
  if (!m) return name;
  const base = `${t(`ui.people.outfit.${m[2]}`)} ${m[3]}`;
  return withSex ? `${base} · ${t(`ui.people.sex.${m[1]}`)}` : base;
}

/** Colour swatches, "as it comes" first (−1). */
function swatches(colours: readonly number[], on: number, pickIt: (i: number) => void): HTMLElement {
  const w = el('div', 'v2-swatches');
  const any = el('button', `v2-swatch any${on < 0 ? ' on' : ''}`);
  any.type = 'button';
  any.title = t('ui.people.asItComes');
  any.addEventListener('click', (e) => { e.stopPropagation(); pickIt(-1); });
  w.append(any);
  colours.forEach((c, i) => {
    const b = el('button', `v2-swatch${on === i ? ' on' : ''}`);
    b.type = 'button';
    b.style.setProperty('--c', hex(c));
    b.addEventListener('click', (e) => { e.stopPropagation(); pickIt(i); });
    w.append(b);
  });
  return w;
}
