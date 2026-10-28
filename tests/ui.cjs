// Browser integration checks with fixed sample sessions (no private logs).
// Requires Google Chrome; WMAD_HEADED=1 opens visible test windows.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.WMAD_NO_UPDATE_CHECK = '1';
const { DemoWatcher } = require('../src/demo');
const { createServer } = require('../src/server');
const screenshots = process.env.WMAD_SCREENSHOTS;
async function screenshot(page, name) {
  if (!screenshots) return;
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, name + '.png') });
}
const clientsOnly = process.env.WMAD_UI_CLIENTS_ONLY === '1';
const checks=[];
const check=(name)=>{checks.push(name);console.log('PASS',name)};
const sessions = [
 {key:'claude:one', id:'one', agent:'claude',project:'claude-project',status:'thinking'},
 {key:'codex:two', id:'two', agent:'codex',project:'codex-project',status:'waiting'},
 {key:'gemini:three', id:'three', agent:'gemini',project:'gemini-project',status:'tool',activity:'Read: index.js'},
 {key:'omp:four', id:'real-omp-id', agent:'omp',project:'omp-project',status:'tool',activity:'read file.js',resumeCommand:"omp --cwd 'C:\\demo project\\O''Brien' --session-dir 'C:\\sessions' --resume 'real-omp-id'"},
 {key:'claude:done', id:'done', agent:'claude',project:'finished-project',status:'done'},
 {key:'codex:sub', id:'sub', agent:'codex',project:'sub-project',status:'thinking',subagent:true},
].map(s=>({...s,lastEventAt:Date.now(),turnStartedAt:Date.now()-1000,cwd:'/demo/'+s.project}));
async function stable(page){
 await page.waitForFunction(()=>typeof office!=='undefined' && office?.framesShown>4);
 await page.evaluate(s=>{window.__events?.close();onData({now:Date.now(),sessions:s})},sessions);
}
async function openSettings(page) {
 if (!(await page.locator('#settingsMenu').getAttribute('open') !== null)) await page.click('#settingsMenu > summary');
}
async function badges(target){
 return target.evaluate(()=>{
  const found=[];const original=office.agentBadge;
  office.agentBadge=function(a,...rest){found.push(a.short);return original.call(this,a,...rest)};
  office.frame(performance.now());office.agentBadge=original;return found;
 });
}
async function drawnLogos(target) {
 await target.waitForFunction(()=>Object.values(OFFICE_AGENT_BADGES).every(b=>b.image.complete&&b.image.naturalWidth>0));
 return target.evaluate(()=>{
  const found=new Set();const ctx=office.ctx;const original=ctx.drawImage;
  ctx.drawImage=function(img,...args){
   for(const [key,badge] of Object.entries(OFFICE_AGENT_BADGES)) if(img===badge.image) found.add(key);
   return original.call(this,img,...args);
  };
  try {office.frame(performance.now());} finally {ctx.drawImage=original;}
  return [...found].sort();
 });
}
(async()=>{
 const watcher = new DemoWatcher().start();
 const server = createServer(watcher, { demo: true, privacy: false });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
 const base = `http://127.0.0.1:${server.address().port}`;
 let browser;
 const errors=[];
 try {
  const translations = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), translations);
  const keys = Object.keys(translations.window.I18N.en).sort();
  for (const lang of Object.values(translations.window.I18N)) assert.deepEqual(Object.keys(lang).sort(), keys);
  check('all nine languages provide every UI string');
  browser=await chromium.launch({headless:process.env.WMAD_HEADED !== '1',channel:'chrome',ignoreDefaultArgs:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],args:['--window-size=1280,960']});
  const context=await browser.newContext({viewport:{width:1280,height:960},locale:'en-US'});
  await context.addInitScript(sessions=>{
   window.EventSource=class {constructor(){window.__events=this;setTimeout(()=>{if(!this.closed)this.onmessage?.({data:JSON.stringify({now:Date.now(),sessions})})},0)}close(){this.closed=true}};
   window.__notifications=[];
   window.Notification=class {static permission='granted';constructor(title,options){window.__notifications.push({title,options})}};
  },sessions);
  context.on('page',p=>p.on('pageerror',e=>errors.push(String(e))));
  const page=await context.newPage();await page.goto(base);await stable(page);
  assert.equal(await page.locator('h1 [data-t]').innerText(),"What's my agent doing");
  assert.equal(await page.evaluate(()=>state.showSub),false,'subagents stay hidden by default for every provider');
  await openSettings(page);await page.check('#showSub');await page.keyboard.press('Escape');
  const ompChild={key:'omp:child',id:'child',agent:'omp',project:'omp-project',cwd:'/demo/omp-project',title:'Worker > Child',status:'thinking',subagent:true,parentId:'real-omp-id',resumeCommand:null,lastEventAt:Date.now(),turnStartedAt:Date.now()};
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),[...sessions,ompChild]);
  await page.click('#viewSeg [data-v=list]');
  assert.equal(await page.locator('.card[data-key="omp:child"] .title').innerText(),'Worker > Child');
  assert.equal(await page.locator('.card[data-key="omp:child"] .copy').count(),0);
  assert.equal(await page.evaluate(()=>officeOpts.label(state.data.sessions.find(s=>s.key==='omp:child'))),'Worker > Child');
  await page.click('#viewSeg [data-v=office]');await page.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
  await openSettings(page);await page.uncheck('#showSub');await page.keyboard.press('Escape');
  check('OMP subagents show their name without an invalid Resume command');
  assert.equal(await page.locator('#showAgent').isChecked(),true);
  assert.deepEqual([...new Set(await badges(page))].sort(),['Cl','Cx','G','OMP']);
  assert.deepEqual(await drawnLogos(page),['claude','codex','gemini','omp']);
  assert.equal(await page.locator('#agentLegend img').evaluateAll(imgs=>imgs.length===4&&imgs.every(img=>img.complete&&img.naturalWidth>0)),true);
  check('all four agent icons load and show in 2D and the legend; OMP uses a neutral mark');
  await openSettings(page);await page.click('#agentSeg [data-v=omp]');
  await page.click('#viewSeg [data-v=list]');
  assert.equal(await page.locator('.card').count(),1);
  assert.equal(await page.locator('.card .agent.omp').innerText(),'OMP');
  assert.equal(await page.locator('.card .copy').getAttribute('data-copy'),sessions.find(s=>s.agent==='omp').resumeCommand);
  await page.evaluate(()=>{window.__copied=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}})});
  await page.click('.card .copy');
  assert.equal(await page.evaluate(()=>window.__copied),sessions.find(s=>s.agent==='omp').resumeCommand);
  await page.reload();await page.waitForFunction(()=>state.loaded);
  assert.equal(await page.evaluate(()=>state.agent),'omp');assert.equal(await page.locator('.card').count(),1);
  check('OMP filter, list, Resume copy and saved filter work');
  await openSettings(page);await page.click('#agentSeg [data-v=all]');await page.click('#viewSeg [data-v=office]');
  await openSettings(page);await page.check('#showSub');
  assert.equal((await badges(page)).length,6);
  check('2D shows four providers and subagents without duplicate badges');
  await openSettings(page);await page.uncheck('#showAgent');assert.equal((await badges(page)).length,0);
  assert.equal(await page.locator('#agentLegend').isVisible(),false);
  await page.reload();await stable(page);assert.equal(await page.locator('#showAgent').isChecked(),false);
  await openSettings(page);await page.check('#showAgent');check('badge toggle hides markers and legend and persists across reload');
  await page.click('#qualSeg [data-v=high]');
  await page.waitForFunction(()=>officeKind==='high:office'&&office?.loaded&&office.framesShown>4,{},{timeout:30000});
  assert.deepEqual([...new Set(await badges(page))].sort(),['Cl','Cx','G','OMP']);
  await screenshot(page, 'office-3d');
  assert.deepEqual(await drawnLogos(page),['claude','codex','gemini','omp']);
  check('3D shows the same four provider badges');
  if (!clientsOnly) {
  await page.click('#pipBtn');await page.waitForFunction(()=>!!popout.win);
  const pip=context.pages().find(p=>p!==page);assert.ok(pip);
  const frame=await (async()=>{for(let i=0;i<100;i++){const f=pip.frames().find(f=>f.url().includes('?pip=1'));if(f)return f;await new Promise(r=>setTimeout(r,50))}throw Error('No compact frame')})();
  await frame.waitForFunction(()=>office?.loaded&&office.framesShown>4);
  await frame.evaluate(s=>{window.__events?.close();onData({now:Date.now(),sessions:s})},sessions);
  assert.deepEqual(await drawnLogos(frame),['claude','codex','gemini','omp']);
  assert.equal(await page.evaluate(()=>office.visible),false);
  assert.equal(await frame.evaluate(()=>state.quality),'high');
  assert.equal(await frame.locator('#pipBtn').isVisible(),false);
  await pip.setViewportSize({width:480,height:400});
  await frame.waitForFunction(()=>!document.getElementById('office').classList.contains('loading'));await page.waitForTimeout(400);await screenshot(pip, 'pip-3d');
  assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  check('real Document PiP opens 3D at compact size and suspends the main office');
  await openSettings(page);await page.click('#agentSeg [data-v=omp]');await frame.waitForFunction(()=>state.agent==='omp');
  await frame.click('#viewSeg [data-v=list]');
  assert.equal(await frame.locator('.card').count(),1);
  assert.equal(await frame.locator('.card .copy').getAttribute('data-copy'),sessions.find(s=>s.agent==='omp').resumeCommand);
  await frame.click('#viewSeg [data-v=office]');
  check('OMP is in the pop-out filter and list with the right Resume command');
  await openSettings(page);await page.uncheck('#showAgent');await frame.waitForFunction(()=>!state.showAgent&&!office.showAgent);
  await openSettings(page);await page.selectOption('#langSel','zh-TW');await frame.waitForFunction(()=>langCode==='zh-TW');
  await openSettings(page);await page.click('#agentSeg [data-v=codex]');await frame.waitForFunction(()=>state.agent==='codex');
  await frame.click('#viewSeg [data-v=list]');await page.waitForFunction(()=>state.view==='list');
  assert.equal(await frame.locator('section').count(),2);
  assert.equal(await frame.locator('.card[data-s=done]').count(),0);
  assert.equal(await frame.locator('.card .agent.claude').count(),0);
  assert.equal(await frame.locator('.card .agent img').evaluateAll(imgs=>imgs.length>0&&imgs.every(img=>img.complete&&img.naturalWidth>0)),true);
  await screenshot(pip, 'pip-list');
  check('preferences synchronize in both directions; compact list shows only attention/working sessions');
  const next=sessions.map(s=>s.key==='codex:sub'?{...s,status:'done',subagent:false}:s);
  await frame.evaluate(s=>onData({now:Date.now(),sessions:s}),next);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),next);
  assert.equal(await frame.evaluate(()=>__notifications.length),0);
  assert.equal(await page.evaluate(()=>__notifications.length),1);
  check('only the main page emits completion notifications');
  await openSettings(page);await page.click('#agentSeg [data-v=all]');
  await frame.click('#viewSeg [data-v=office]');await openSettings(page);await page.check('#showAgent');await frame.click('#qualSeg [data-v=mid]');
  await frame.waitForFunction(()=>officeKind==='mid'&&office.framesShown>4);
  await page.waitForFunction(()=>state.quality==='mid');
  const foreground=await context.newPage();await foreground.goto('about:blank');await foreground.bringToFront();
  const before=await frame.evaluate(()=>({frames:office.framesShown,visible:document.visibilityState}));
  await new Promise(r=>setTimeout(r,1100));
  const after=await frame.evaluate(()=>({frames:office.framesShown,visible:document.visibilityState}));
  assert.ok(after.frames>before.frames,JSON.stringify({before,after}));
  await foreground.close();check('pop-out keeps animating while another tab is foreground');
  await pip.close();await page.waitForFunction(()=>!popout.win&&office.visible);
  await page.bringToFront();await page.waitForFunction(()=>office.framesShown>4);
  await page.click('#pipBtn');await page.waitForFunction(()=>!!popout.win);
  await page.click('#pipBtn');await page.waitForFunction(()=>!popout.win&&office.visible);
  check('native close and button close restore the main view; reopening works');
  await page.evaluate(()=>{documentPictureInPicture.requestWindow=()=>Promise.reject(new Error('Test rejection'))});
  await page.click('#pipBtn');await page.waitForFunction(()=>!popout.busy&&!document.getElementById('pipError').hidden);
  assert.equal(await page.evaluate(()=>office.visible),true);
  assert.equal(await page.locator('#pipBtn').isEnabled(),true);
  check('request failure gives a translated error and leaves the dashboard usable');
  // Force only the capability branch; rendering and MediaStream remain real.
  const fallback=await context.newPage();
  await fallback.addInitScript(()=>Object.defineProperty(window,'documentPictureInPicture',{value:undefined}));
  await fallback.goto(base+'/?view=office&quality=high');await stable(fallback);
  await fallback.waitForFunction(()=>office.loaded&&office.framesShown>4);
  await fallback.click('#pipBtn');
  await fallback.waitForFunction(()=>!!popout.stream&&!popout.busy&&document.getElementById('pipVideo').videoWidth>0);
  assert.equal(await fallback.locator('#pipPreview').isVisible(),true);
  const colors=await fallback.evaluate(()=>{
   const data=popout.captureContext.getImageData(0,0,960,540).data;const values=new Set();
   for(let i=0;i<data.length;i+=160)values.add(`${data[i]},${data[i+1]},${data[i+2]}`);
   window.__stream=popout.stream;return values.size;
  });
  assert.ok(colors>20,'preview includes rendered 3D content rather than a blank frame');
  await fallback.click('#qualSeg [data-v=mid]');await fallback.waitForFunction(()=>officeKind==='mid'&&office.framesShown>4);
  assert.equal(await fallback.evaluate(()=>popout.stream===__stream),true);
  await fallback.click('#closePreview');await fallback.waitForFunction(()=>!popout.stream);
  assert.equal(await fallback.evaluate(()=>__stream.getTracks().every(t=>t.readyState==='ended')),true);
  assert.equal(await fallback.evaluate(()=>document.getElementById('pipVideo').srcObject),null);
  check('video fallback captures 3D + overlay, survives renderer changes and releases media tracks on stop');
  await fallback.click('#viewSeg [data-v=list]');assert.equal(await fallback.locator('#pipBtn').isVisible(),false);
  check('view-only fallback is offered only for office mode');
  const compact=await context.newPage();await compact.goto(base+'/?pip=1&view=list');
  await compact.waitForFunction(()=>state.loaded);
  await compact.evaluate(()=>{__events.close();onData({now:Date.now(),sessions:[]})});
  assert.match(await compact.locator('#main').innerText(),/目前沒有|No agents/);
  await compact.reload();assert.equal(await compact.evaluate(()=>PIP),true);
  check('empty compact list explains the quiet state and retains compact mode after reload');
  await page.bringToFront();
  await openSettings(page);
  await page.locator('#settingsMenu > summary').press('Escape');
  assert.equal(await page.locator('#settingsPanel').isVisible(),false);
  assert.equal(await page.locator('#settingsMenu > summary').evaluate(el=>el===document.activeElement),true);
  await openSettings(page);await page.click('h1');
  assert.equal(await page.locator('#settingsPanel').isVisible(),false);
  }
  const magpieSessions = [
   ...sessions,
   {key:'opencode:remote',id:'remote',agent:'opencode',agentName:'OpenCode',source:'magpie',status:'thinking',title:'Gateway task',lastEventAt:Date.now()},
   {key:'omp:remote',id:'remote',agent:'omp',source:'magpie',status:'thinking',lastEventAt:Date.now()},
   {key:'magpie:remote',id:'remote',agent:'magpie',agentName:'Magpie',source:'magpie',status:'idle',lastEventAt:Date.now()},
  ];
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),magpieSessions);
  await page.click('#viewSeg [data-v=list]');
  assert.equal(await page.locator('[data-key="opencode:remote"] .agent').innerText(),'OpenCode');
  assert.equal(await page.locator('[data-key="opencode:remote"] .copy').count(),0);
  assert.equal(await page.locator('[data-key="omp:remote"] .copy').count(),0);
  assert.equal(await page.locator('[data-key="omp:four"] .copy').count(),1);
  assert.equal(await page.locator('[data-key="claude:one"] .copy').count(),1);
  await openSettings(page);await page.click('#agentSeg [data-v=opencode]');
  assert.equal(await page.locator('.card').count(),1);
  assert.equal(await page.locator('#activeFilter').innerText(),'OpenCode');
  await page.evaluate(s=>onData({now:Date.now(),sessions:s.map(x=>x.source==='magpie'?{...x,status:'idle'}:x)}),magpieSessions);
  assert.equal(await page.locator('.card').count(),0);
  await openSettings(page);await page.check('#showIdle');
  assert.equal(await page.locator('.card').count(),1);
  await page.reload();await page.waitForFunction(()=>state.loaded);
  await page.evaluate(s=>{__events.close();onData({now:Date.now(),sessions:s})},magpieSessions);
  assert.equal(await page.evaluate(()=>state.agent),'opencode');
  await openSettings(page);await page.click('#agentSeg [data-v=all]');
  await page.click('#viewSeg [data-v=office]');
  for (const quality of ['mid','high']) {
   await page.click(`#qualSeg [data-v=${quality}]`);
   await page.waitForFunction(q=>officeKind.startsWith(q)&&office.framesShown>4&&(q!=='high'||office.loaded),quality);
   assert.equal(await page.evaluate(()=>office.people.has('opencode:remote')),true);
  }
  check('Magpie clients reuse list, filters, idle visibility and both offices without invalid resume commands');
  const nativeClients = [
   {key:'kimi:one',id:'one',sessionId:'one',agent:'kimi',status:'thinking',cwd:'/demo/kimi'},
   {key:'dsh:two',id:'two',agent:'dsh',status:'waiting',activity:'Shell',cwd:'/demo/dsh'},
   {key:'grok:three',id:'three',agent:'grok',status:'tool',activity:'Read',cwd:'/demo/grok'},
   {key:'kimi:one/agent-1',id:'one/agent-1',sessionId:'one',parentId:'one',subagent:true,agent:'kimi',status:'thinking',cwd:'/demo/kimi'},
  ].map(s=>({...s,lastEventAt:Date.now()}));
  await page.evaluate(s=>{state.agent='all';state.showSub=false;onData({now:Date.now(),sessions:s})},nativeClients);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),nativeClients);
  assert.equal(await page.locator('#agentLegend img').count(),3, 'old providers leave the legend');
  for (const agent of ['kimi','dsh','grok']) {
   assert.equal(await page.locator(`#agentSeg button[data-v="${agent}"]`).count(),1);
   const logo=page.locator(`#agentSeg button[data-v="${agent}"] img`);
   await page.waitForFunction(agent=>{
    const img=document.querySelector(`#agentSeg button[data-v="${agent}"] img`);
    return img?.complete&&img.naturalWidth>0;
   },agent);
   assert.equal(await logo.evaluate(img=>img.complete&&img.naturalWidth>0),true);
   assert.equal(await page.locator(`#agentLegend img[src="/assets/agents/${agent}.svg"]`).count(),1);
  }
  await page.click('#viewSeg [data-v=list]');
  assert.equal(await page.locator('.card').count(),3);
  assert.match(await page.locator('[data-key="dsh:two"] .copy').getAttribute('data-copy'),/dsh tui --resume 'two'/);
  assert.match(await page.locator('[data-key="kimi:one"] .copy').getAttribute('data-copy'),/kimi --session 'one'/);
  assert.match(await page.locator('[data-key="grok:three"] .copy').getAttribute('data-copy'),/grok --resume 'three'/);
  await openSettings(page);await page.click('#agentSeg [data-v=kimi] img');
  assert.equal(await page.locator('.card').count(),1);
  assert.equal(await page.locator('#agentLegend img').count(),1);
  assert.equal(await page.locator('#agentLegend img').getAttribute('src'),'/assets/agents/kimi.svg');
  await openSettings(page);await page.check('#showSub');
  assert.equal(await page.locator('.card').count(),2);
  await openSettings(page);await page.click('#agentSeg [data-v=all]');
  await page.click('#viewSeg [data-v=office]');
  for (const quality of ['mid','high']) {
   await page.click(`#qualSeg [data-v=${quality}]`);
   await page.waitForFunction(q=>officeKind.startsWith(q)&&office.framesShown>4&&(q!=='high'||office.loaded),quality);
   // Reused renderers animate the previous fixture's people walking out.
   await page.waitForFunction(keys=>office.people.size===keys.length&&keys.every(k=>office.people.has(k)),nativeClients.map(s=>s.key));
   assert.deepEqual([...new Set(await badges(page))].sort(),['Ds','Gr','Ki']);
   assert.deepEqual(await drawnLogos(page),['dsh','grok','kimi']);
   assert.equal(await page.evaluate(()=>office.people.has('kimi:one/agent-1')),true);
   await page.evaluate(s=>onData({now:Date.now(),sessions:s.filter(x=>x.agent==='kimi')}),nativeClients);
   assert.equal(await page.locator('#agentLegend img').count(),1, 'two Kimi sessions share one legend entry');
   await page.evaluate(()=>onData({now:Date.now(),sessions:[]}));
   assert.equal(await page.locator('#agentLegend img').count(),0);
   assert.equal(await page.locator('#agentLegend').isHidden(),true);
   await page.evaluate(s=>onData({now:Date.now(),sessions:s}),nativeClients);
   assert.equal(await page.locator('#agentLegend img').count(),3);
   assert.equal(await page.locator('#agentLegend').isVisible(),true);
  }
  check('Kimi, DSH and Grok support filters, subagents, resume commands and packaged logos in both offices');
  check('agent legends follow current sessions and filters, disappear when empty and return without duplicates in 2D/3D');
  for (const colorScheme of ['light','dark']) {
   await page.emulateMedia({colorScheme});
   await page.click('#viewSeg [data-v=list]');
   await openSettings(page);
   for (const agent of ['kimi','dsh','grok']) {
    const selector=`#agentSeg [data-v="${agent}"] img`;
    const filter=await page.locator(selector).evaluate(img=>getComputedStyle(img).filter);
    assert.equal(filter,colorScheme==='dark'&&agent!=='dsh'?'invert(1)':'none');
   }
   await screenshot(page,`list-${colorScheme}`);
   await page.locator('#settingsMenu > summary').press('Escape');
   await page.click('#viewSeg [data-v=office]');
   for(const quality of ['mid','high']) {
    await page.click(`#qualSeg [data-v=${quality}]`);
    await page.waitForFunction(q=>officeKind.startsWith(q)&&office.framesShown>4&&(q!=='high'||office.loaded),quality);
    assert.deepEqual(await drawnLogos(page),['dsh','grok','kimi']);
    await screenshot(page,`office-${quality}-${colorScheme}`);
   }
  }
  check('list, filters, legend and both offices preserve light/dark native logos');
  const fallbackPage=await context.newPage();
  await fallbackPage.route('**/assets/agents/kimi.svg',route=>route.abort());
  await fallbackPage.goto(base);
  await fallbackPage.waitForFunction(()=>state.loaded);
  await fallbackPage.evaluate(s=>{__events.close();state.agent='all';state.showSub=true;onData({now:Date.now(),sessions:s})},nativeClients);
  await fallbackPage.click('#qualSeg [data-v=mid]');
  await fallbackPage.waitForFunction(()=>officeKind==='mid'&&office.framesShown>4&&OFFICE_AGENT_BADGES.kimi.image.complete);
  assert.equal(await fallbackPage.evaluate(()=>OFFICE_AGENT_BADGES.kimi.image.naturalWidth),0);
  assert.equal(await fallbackPage.evaluate(()=>{
   const texts=[],ctx=office.ctx,original=ctx.fillText;
   ctx.fillText=function(text,...args){texts.push(text);return original.call(this,text,...args)};
   try {office.frame(performance.now());} finally {ctx.fillText=original;}
   return texts.includes('Ki');
  }),true);
  await fallbackPage.close();
  check('a failed Kimi image still draws the existing canvas initials');
  if (!clientsOnly) {
  for (const width of [320,390,768,1280]) {
   await page.setViewportSize({width,height:800});
   for (const colorScheme of ['light','dark']) {
    await page.emulateMedia({colorScheme});
    await openSettings(page);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const panel=await page.locator('#settingsPanel').boundingBox();
    assert.ok(panel.x>=0 && panel.x+panel.width<=width);
    await page.locator('#settingsMenu > summary').press('Escape');
    await screenshot(page,`toolbar-${width}-${colorScheme}`);
   }
  }
  check('settings close with Escape/outside click, restore focus, and fit narrow and wide screens in both themes');
  }
  assert.deepEqual(errors,[]);check('no uncaught browser errors');
  console.log('TOTAL',checks.length);
 } finally {
  await browser?.close();
  watcher.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
