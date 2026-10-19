// Photos of the interface with the GPU, in the generated 10 km city: each scene opens panels with real clicks on
// the buttons (the same the player clicks) and is photographed. Runs over dist/ (npm run build first).
// Use: node tools/fotos-interface.mjs <out-dir> [scene ...]   (no scene: all of them)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'interface'));
fs.mkdirSync(out, { recursive: true });

// helpers that run in the page
const H = `const W=(ms)=>new Promise(r=>setTimeout(r,ms));const Q=(s)=>document.querySelector(s);const QA=(s)=>[...document.querySelectorAll(s)];
const click=(s)=>{const e=typeof s==='string'?Q(s):s;if(!e)throw new Error('sem '+s);e.click();};
const byText=(sel,re)=>QA(sel).find(e=>new RegExp(re).test(e.textContent||e.title||e.dataset.tip||''));
const esc=()=>window.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',key:'Escape',bubbles:true}));
const g=window.__cidade.game;const reset=async()=>{esc();esc();esc();const hp=Q('.health:not(.hidden)');if(hp)hp.classList.add('hidden');QA('.v2-dialog-back').forEach(e=>{e.classList.add('hidden');e.hidden=true;});g.hudActions.tool('camera');await W(200);};`;
const scene = (body) => `(async()=>{${H}await reset();${body};await W(600);})().catch(e=>console.log('script: '+e.message))`;

export const SCENES = {
  'barra-dock': scene(''),
  'vias': scene(`click('[data-cat=roads]')`),
  'vias-quarteiroes': scene(`click('[data-cat=roads]');await W(200);click(byText('.v2-choice','Quarteir|Blocks'))`),
  'zonas': scene(`click('[data-cat=zones]')`),
  'lotes': scene(`click('[data-cat=zones]');await W(200);click(byText('.v2-tab','Lotes|Lots'));await W(200);click(byText('.v2-card','Dividir|Split'))`),
  'construir': scene(`click('[data-cat=build]')`),
  'paisagem': scene(`click('[data-cat=landscape]')`),
  'paisagem-natureza': scene(`click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','Natureza|Nature'))`),
  'paisagem-ceu': scene(`click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','Céu|Sky'));await W(200);click(byText('.v2-card','Clima|Weather'))`),
  'paisagem-rua': scene(`click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','^Rua|^Street'))`),
  'transporte': scene(`click('[data-cat=transit]')`),
  'demolir': scene(`click('[data-cat=demolish]');await W(200);click(byText('.v2-tab','Bomba|Bomb'))`),
  'menu': scene(`click('[data-pop=menu]')`),
  'camadas': scene(`click('[data-pop=layers]')`),
  'simulacao': scene(`click('[data-pop=sim]')`),
  'camera': scene(`click('[data-pop=camera]')`),
  'ajuda': scene(`click('[data-cat=roads]');await W(200);click('[data-pop=help]')`),
  'saude': scene(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'F9',key:'F9',bubbles:true}))`),
  'opcoes': scene(`click('[data-pop=menu]');await W(200);click(byText('.v2-row','Opções gráficas|Graphics options'))`),
  'sobre': scene(`click('[data-pop=menu]');await W(200);click(byText('.v2-row','^Sobre|^About'))`),
  'inspetor-via': scene(`click('[data-cat=info]');await W(200);const n=g.world.roads;const s=n.nearestSeg(g.rig.target.x,g.rig.target.z,400);g.inspector.pick(...(()=>{const c=n.nodes.cols,a=n.segs.cols.a[s[0]],b=n.segs.cols.b[s[0]];return [(c.x[a]+c.x[b])/2,(c.z[a]+c.z[b])/2];})());await W(1500)`),
  'inspetor-cruzamento': scene(`click('[data-cat=info]');await W(200);const n=g.world.roads,c=n.nodes.cols;let best=-1,bd=1e9;for(let i=0;i<n.nodes.alive.length;i++){if(!n.nodes.alive[i]||c.deg[i]<3)continue;const d=Math.hypot(c.x[i]-g.rig.target.x,c.z[i]-g.rig.target.z);if(d<bd){bd=d;best=i;}}g.inspector.pick(c.x[best],c.z[best]);await W(1500)`),
  'editor-secao': scene(`click('[data-cat=roads]');await W(300);click('.rc-card.on .rc-custom.edit');await W(300);Q('.section-canvas').dispatchEvent(new MouseEvent('click',{clientX:Q('.section-canvas').getBoundingClientRect().left+Q('.section-canvas').getBoundingClientRect().width*0.5,clientY:Q('.section-canvas').getBoundingClientRect().top+40,bubbles:true}))`),
  'construir-predio': scene(`click('[data-cat=build]');await W(200);const b=g.world.buildings,c=b.cols;let best=-1,bd=1e9;for(let i=0;i<b.alive.length;i++){if(!b.alive[i]||c.floors[i]<3)continue;const d=Math.hypot(c.x[i]-g.rig.target.x,c.z[i]-g.rig.target.z);if(d<bd){bd=d;best=i;}}g.select(best)`),
  'teclas': scene(`const key=(c)=>window.dispatchEvent(new KeyboardEvent('keydown',{code:c,key:c,bubbles:true}));key('KeyT');await W(200);key('F1');await W(200);click('[data-pop=menu]');await W(200);key('Escape');await W(200);key('F1')`),
  'inicio': '(async()=>{await new Promise(r=>setTimeout(r,1500));})()',
  'sobre-licencas': scene(`click('[data-pop=menu]');await W(200);click(byText('.v2-row','^Sobre|^About'));await W(1500);const d=Q('.about-text');if(d)d.open=true;console.log('about aberto: '+!Q('.about').parentElement.hidden)`),
  'acoes-lotes': scene(`const A=g.hudActions;console.log('acoes reais: '+['lotLine','lotCurve','renovate','decayOf','addressOf'].map(k=>k+'='+typeof A[k]).join(' '));click('[data-cat=zones]');await W(200);click(byText('.v2-tab','Lotes|Lots'));await W(200);click(byText('.v2-card','Dividir|Split'));await W(200);click(byText('.v2-choice','Por linha|line'))`),
  'acoes-predio': scene(`const A=g.hudActions;console.log('acoes reais: '+['lotLine','lotCurve','renovate','decayOf','addressOf'].map(k=>k+'='+typeof A[k]).join(' '));click('[data-cat=build]');await W(200);const b=g.world.buildings,c=b.cols;let best=-1,bd=1e9;for(let i=0;i<b.alive.length;i++){if(!b.alive[i]||c.floors[i]<3)continue;const d=Math.hypot(c.x[i]-g.rig.target.x,c.z[i]-g.rig.target.z);if(d<bd){bd=d;best=i;}}g.select(best)`),
  'criador-pessoas': scene(`const net=g.world.roads,nc=net.nodes.cols;const sg=net.nearestSeg(300,300,800);const na=net.segs.cols.a[sg[0]];await g.view(nc.x[na],nc.z[na],35,30,34,11);await W(1500);click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','Pessoas|People'));await W(400);console.log('catalogo pessoas: '+!!(g.hudActions.peopleCatalog&&g.hudActions.peopleCatalog()));click(byText('.v2-card','Em roda|In a ring'));await W(150);const c=g.canvas,r=c.getBoundingClientRect();const o={clientX:r.left+r.width*0.5,clientY:r.top+r.height*0.5,button:0,buttons:1,pointerId:1,pointerType:'mouse',bubbles:true,isPrimary:true};c.dispatchEvent(new PointerEvent('pointermove',{...o,buttons:0}));c.dispatchEvent(new PointerEvent('pointerdown',o));c.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}));await W(400);console.log('grupos: '+g.commands.canUndo);esc();await W(1500)`),
  'remover-postes': scene(`click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','^Rua|^Street'));await W(200);click(byText('.v2-card','Remover postes|Remove poles'));await W(300);click('[data-pop=camera]')`),
  'ingles': scene(`click('[data-cat=roads]')`),
  'nos-impossiveis': scene(`g.world.unlimited=true;const x=g.rig.target.x+40,z=g.rig.target.z+40;g.api.road(x-200,z-400,x,z-400);g.api.road(x,z-400,x+200,z-400);g.api.road(x,z-400,x+200,z-345);await W(1200);click('.v2-warn');await W(1500)`),
  'avisos': scene(`g.hud.toast('Mapa reparado: 1 ponta solta dentro de outra via virou cruzamento.');g.hud.toast('Cidade carregada.');await W(100)`),
  'transporte-linha': scene(`const n=g.world.roads,sc=n.segs.cols,nc=n.nodes.cols;const s=n.nearestSeg(g.rig.target.x,g.rig.target.z,600)[0];const xa=nc.x[sc.a[s]],za=nc.z[sc.a[s]],xb=nc.x[sc.b[s]],zb=nc.z[sc.b[s]];g.api.line(0,[xa*0.7+xb*0.3,za*0.7+zb*0.3,xa*0.3+xb*0.7,za*0.3+zb*0.7],3);click('[data-cat=transit]');await W(400)`),
};

const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(SCENES);
const [first, ...rest] = names;
const lang = names.includes('ingles') && names.length === 1 ? '&lang=en' : '';
const env = {
  ...process.env, CIDADE_W: '1920', CIDADE_H: '1080', CIDADE_SETTLE: '2',
  CIDADE_SEQ: JSON.stringify(rest.map((n) => [path.join(out, `${n}.png`), SCENES[n]])),
};
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), path.join(out, `${first}.png`), first === 'inicio' ? '?mapa=10&limpo&hora=11' : `?cidade&mapa=10&limpo&hora=11&cam=0,0,35,32,260${lang}`, SCENES[first]],
  { cwd: root, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code ?? 0));
