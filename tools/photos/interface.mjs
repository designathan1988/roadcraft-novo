// The interface photo scenes (tools/photos/run.mjs interface [scene...]): each opens panels with real clicks on the
// buttons (the same the player clicks) in the generated 10 km city. The interface text the clicks look for is the
// player's (either language); the scene names and messages are code.
// helpers that run in the page
const H = `const W=(ms)=>new Promise(r=>setTimeout(r,ms));const Q=(s)=>document.querySelector(s);const QA=(s)=>[...document.querySelectorAll(s)];
const click=(s)=>{const e=typeof s==='string'?Q(s):s;if(!e)throw new Error('missing '+s);e.click();};
const byText=(sel,re)=>QA(sel).find(e=>new RegExp(re).test(e.textContent||e.title||e.dataset.tip||''));
const esc=()=>window.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',key:'Escape',bubbles:true}));
const R=window.__roadcraft;const reset=async()=>{esc();esc();esc();const hp=Q('.health:not(.hidden)');if(hp)hp.classList.add('hidden');R.ui.tool('camera');await W(200);};`;
const scene = (body) => `(async()=>{${H}await reset();${body};await W(600);})().catch(e=>console.log('script: '+e.message))`;

export const SCENES = {
  'dock-bar': scene(''),
  'roads': scene(`click('[data-cat=roads]')`),
  'roads-blocks': scene(`click('[data-cat=roads]');await W(200);click(byText('.v2-choice','Quarteir|Blocks'))`),
  'zones': scene(`click('[data-cat=zones]')`),
  'lots': scene(`click('[data-cat=zones]');await W(200);click(byText('.v2-tab','Lotes|Lots'));await W(200);click(byText('.v2-card','Dividir|Split'))`),
  'build': scene(`click('[data-cat=build]')`),
  'landscape': scene(`click('[data-cat=landscape]')`),
  'landscape-nature': scene(`click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','Natureza|Nature'))`),
  'landscape-sky': scene(`click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','Céu|Sky'));await W(200);click(byText('.v2-card','Clima|Weather'))`),
  'landscape-street': scene(`click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','^Rua|^Street'))`),
  'transit': scene(`click('[data-cat=transit]')`),
  'demolish': scene(`click('[data-cat=demolish]');await W(200);click(byText('.v2-tab','Bomba|Bomb'))`),
  'menu': scene(`click('[data-pop=menu]')`),
  'layers': scene(`click('[data-pop=layers]')`),
  'simulation': scene(`click('[data-pop=sim]')`),
  'camera': scene(`click('[data-pop=camera]')`),
  'help': scene(`click('[data-cat=roads]');await W(200);click('[data-pop=help]')`),
  'health': scene(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'F9',key:'F9',bubbles:true}))`),
  'options': scene(`click('[data-pop=menu]');await W(200);click(byText('.v2-row','Opções gráficas|Graphics options'))`),
  'about': scene(`click('[data-pop=menu]');await W(200);click(byText('.v2-row','^Sobre|^About'))`),
  'inspector-road': scene(`click('[data-cat=info]');await W(200);const n=R.world.roads;const s=n.nearestSeg(R.camera.pose().x,R.camera.pose().z,400);R.tools.inspect(...(()=>{const c=n.nodes.cols,a=n.segs.cols.a[s[0]],b=n.segs.cols.b[s[0]];return [(c.x[a]+c.x[b])/2,(c.z[a]+c.z[b])/2];})());await W(1500)`),
  'inspector-junction': scene(`click('[data-cat=info]');await W(200);const n=R.world.roads,c=n.nodes.cols;let best=-1,bd=1e9;for(let i=0;i<n.nodes.alive.length;i++){if(!n.nodes.alive[i]||c.deg[i]<3)continue;const d=Math.hypot(c.x[i]-R.camera.pose().x,c.z[i]-R.camera.pose().z);if(d<bd){bd=d;best=i;}}R.tools.inspect(c.x[best],c.z[best]);await W(1500)`),
  'section-editor': scene(`click('[data-cat=roads]');await W(300);click('.rc-card.on .rc-custom.edit');await W(300);Q('.section-canvas').dispatchEvent(new MouseEvent('click',{clientX:Q('.section-canvas').getBoundingClientRect().left+Q('.section-canvas').getBoundingClientRect().width*0.5,clientY:Q('.section-canvas').getBoundingClientRect().top+40,bubbles:true}))`),
  'build-building': scene(`click('[data-cat=build]');await W(200);const b=R.world.buildings,c=b.cols;let best=-1,bd=1e9;for(let i=0;i<b.alive.length;i++){if(!b.alive[i]||c.floors[i]<3)continue;const d=Math.hypot(c.x[i]-R.camera.pose().x,c.z[i]-R.camera.pose().z);if(d<bd){bd=d;best=i;}}R.tools.select(best)`),
  'keys': scene(`const key=(c)=>window.dispatchEvent(new KeyboardEvent('keydown',{code:c,key:c,bubbles:true}));key('KeyT');await W(200);key('F1');await W(200);click('[data-pop=menu]');await W(200);key('Escape');await W(200);key('F1')`),
  'start': '(async()=>{await new Promise(r=>setTimeout(r,1500));})()',
  'about-licences': scene(`click('[data-pop=menu]');await W(200);click(byText('.v2-row','^Sobre|^About'));await W(1500);const d=Q('.about-text');if(d)d.open=true;console.log('about open: '+!Q('.about').parentElement.hidden)`),
  'lot-actions': scene(`const A=R.ui;console.log('real actions: '+['lotLine','lotCurve','renovate','decayOf','addressOf'].map(k=>k+'='+typeof A[k]).join(' '));click('[data-cat=zones]');await W(200);click(byText('.v2-tab','Lotes|Lots'));await W(200);click(byText('.v2-card','Dividir|Split'));await W(200);click(byText('.v2-choice','Por linha|line'))`),
  'building-actions': scene(`const A=R.ui;console.log('real actions: '+['lotLine','lotCurve','renovate','decayOf','addressOf'].map(k=>k+'='+typeof A[k]).join(' '));click('[data-cat=build]');await W(200);const b=R.world.buildings,c=b.cols;let best=-1,bd=1e9;for(let i=0;i<b.alive.length;i++){if(!b.alive[i]||c.floors[i]<3)continue;const d=Math.hypot(c.x[i]-R.camera.pose().x,c.z[i]-R.camera.pose().z);if(d<bd){bd=d;best=i;}}R.tools.select(best)`),
  'people-creator': scene(`const net=R.world.roads,nc=net.nodes.cols;const sg=net.nearestSeg(300,300,800);const na=net.segs.cols.a[sg[0]];await R.camera.view(nc.x[na],nc.z[na],35,30,34,11);await W(1500);click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','Pessoas|People'));await W(400);console.log('people catalog: '+!!(R.ui.peopleCatalog&&R.ui.peopleCatalog()));click(byText('.v2-card','Em roda|In a ring'));await W(150);const c=document.getElementById('view'),r=c.getBoundingClientRect();const o={clientX:r.left+r.width*0.5,clientY:r.top+r.height*0.5,button:0,buttons:1,pointerId:1,pointerType:'mouse',bubbles:true,isPrimary:true};c.dispatchEvent(new PointerEvent('pointermove',{...o,buttons:0}));c.dispatchEvent(new PointerEvent('pointerdown',o));c.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}));await W(400);console.log('groups: '+R.history.canUndo());esc();await W(1500)`),
  'remove-poles': scene(`click('[data-cat=landscape]');await W(200);click(byText('.v2-tab','^Rua|^Street'));await W(200);click(byText('.v2-card','Remover postes|Remove poles'));await W(300);click('[data-pop=camera]')`),
  'english': scene(`click('[data-cat=roads]')`),
  'impossible-nodes': scene(`R.world.unlimited=true;const x=R.camera.pose().x+40,z=R.camera.pose().z+40;R.actions.road(x-200,z-400,x,z-400);R.actions.road(x,z-400,x+200,z-400);R.actions.road(x,z-400,x+200,z-345);await W(1200);click('.v2-warn');await W(1500)`),
  'toasts': scene(`R.notices.show('Map repaired: 1 loose end inside another road became a junction.');R.notices.show('City loaded.');await W(100)`),
  'track': scene(`click('[data-cat=transit]');await W(200);click(byText('.v2-tab','Trilho de trem|Train track'));await W(300)`),
  'split-line': scene(`click('[data-cat=build]');await W(200);const b=R.world.buildings,c=b.cols;let best=-1,bd=1e9;for(let i=0;i<b.alive.length;i++){if(!b.alive[i]||c.floors[i]<1||c.floors[i]>2||c.w[i]<16)continue;const d=Math.hypot(c.x[i]-R.camera.pose().x,c.z[i]-R.camera.pose().z);if(d<bd){bd=d;best=i;}}const x=c.x[best],z=c.z[best],r0=c.rot[best],s=Math.sin(r0),co=Math.cos(r0),L=(lx,lz)=>[x+lx*co+lz*s,z-lx*s+lz*co];await R.camera.view(x,z,35,55,70);R.ui.lotLine();const A=L(-c.w[best]*0.15,c.d[best]*0.7),B=L(c.w[best]*0.15,-c.d[best]*0.7);R.tools.click(A[0],A[1]);const y=R.actions.ground(B[0],B[1]);const v=R.camera.toScreen(B[0],y,B[1]);document.getElementById('view').dispatchEvent(new PointerEvent('pointermove',{clientX:v.x,clientY:v.y,pointerId:1,bubbles:true}));await W(500)`),
  'start-menu': scene(`click('[data-pop=menu]');await W(200);click(byText('.v2-row','Tela inicial|Title screen'));await W(300)`),
  'theme-list': scene(`click('[data-cat=build]');await W(300);click(QA('.v2-toolopts .v2-dd')[0]);await W(300)`),
  'transit-line': scene(`const n=R.world.roads,sc=n.segs.cols,nc=n.nodes.cols;const s=n.nearestSeg(R.camera.pose().x,R.camera.pose().z,600)[0];const xa=nc.x[sc.a[s]],za=nc.z[sc.a[s]],xb=nc.x[sc.b[s]],zb=nc.z[sc.b[s]];R.actions.line(0,[xa*0.7+xb*0.3,za*0.7+zb*0.3,xa*0.3+xb*0.7,za*0.3+zb*0.7],3);click('[data-cat=transit]');await W(400)`),
};
