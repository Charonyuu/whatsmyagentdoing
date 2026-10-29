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
// The agent panel replaced the list view on the dashboard.
async function rowKeys(t){return t.locator('#side .srow').evaluateAll(rows=>rows.map(r=>r.dataset.key))}
async function openAgent(t,key){await t.click(`#side .srow[data-key="${key}"]`);await t.waitForFunction(()=>document.getElementById('side').classList.contains('detail'))}
async function backToList(t){await t.click('#sideBack');await t.waitForFunction(()=>!document.getElementById('side').classList.contains('detail'))}
async function resumeOf(t,key){await openAgent(t,key);const b=t.locator('#detailBody .copy');const v=(await b.count())?await b.getAttribute('data-copy'):null;await backToList(t);return v}
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
  assert.equal(await page.evaluate(()=>state.full&&document.body.classList.contains('full')),true,'full screen is the default');
  assert.equal(await page.locator('#side .srow').count()>0,true,'the agent panel lists the team');
  check('full screen with the agent panel is the default');
  assert.equal(await page.locator('#fullBtn').count(),0,'there is no way back to the old layout');
  assert.equal(await page.locator('h1 [data-t]').innerText(),"What's my agent doing");
  assert.equal(await page.evaluate(()=>state.showSub),false,'subagents stay hidden by default for every provider');
  await openSettings(page);await page.check('#showSub');await page.keyboard.press('Escape');
  const ompChild={key:'omp:child',id:'child',agent:'omp',project:'omp-project',cwd:'/demo/omp-project',title:'Worker > Child',status:'thinking',subagent:true,parentId:'real-omp-id',resumeCommand:null,lastEventAt:Date.now(),turnStartedAt:Date.now()};
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),[...sessions,ompChild]);
  await openAgent(page,'omp:child');
  assert.equal(await page.locator('#detailBody .dtitle').innerText(),'Worker > Child');
  assert.equal(await page.locator('#detailBody .copy').count(),0);
  await backToList(page);
  assert.equal(await page.evaluate(()=>officeOpts.label(state.data.sessions.find(s=>s.key==='omp:child'))),'Worker > Child');
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
  await openSettings(page);await page.uncheck('#showSub');await page.keyboard.press('Escape');
  check('OMP subagents show their name without an invalid Resume command');
  await page.evaluate(()=>{window.__chimes=[];chime=k=>window.__chimes.push(k);state.sound=true;});
  const lead=sessions.find(s=>s.agent==="claude"&&!s.subagent);
  await page.evaluate(([s,b])=>{onData({now:Date.now(),sessions:s.map(x=>x.key===b.key?{...b,status:'tool',stuck:0}:x)});
    onData({now:Date.now(),sessions:s.map(x=>x.key===b.key?{...b,status:'waiting',stuck:0}:x)});
    onData({now:Date.now(),sessions:s.map(x=>x.key===b.key?{...b,status:'tool',stuck:0}:x)});
    onData({now:Date.now(),sessions:s.map(x=>x.key===b.key?{...b,status:'tool',stuck:12}:x)});
    onData({now:Date.now(),sessions:s.map(x=>x.key===b.key?{...b,status:'tool',stuck:13}:x)});},[sessions,lead]);
  assert.deepEqual(await page.evaluate(()=>window.__chimes),['attention','attention'],'one chime for waiting, one when it first looks stuck');
  assert.match(await page.locator(`#side .srow[data-key="${lead.key}"] .st`).innerText(),/13/);
  await openAgent(page,lead.key);assert.match(await page.locator('#detailBody .stuck').innerText(),/13/);await backToList(page);
  await page.evaluate(s=>{state.sound=false;onData({now:Date.now(),sessions:s})},sessions);
  assert.equal(await page.locator('#sound').isChecked(),false,'sound is off by default');
  check('needs-you and stuck alerts chime once, and stuck sessions are flagged in the agent panel');
  await page.evaluate(s=>onData({now:Date.now(),sessions:s.map((x,i)=>({...x,context:i===0?{used:180000,window:200000}:null})),
    summary:JSON.parse('{"day":"d","turns":12,"tokens":2460000,"agents":2,"byAgent":{"claude":{"sessions":1,"turns":8,"tokens":2000000},"codex":{"sessions":1,"turns":4,"tokens":460000}},"projects":{"__proto__":8,"api":4}}')}),sessions);
  assert.equal(await page.locator('#todayTokens').innerText(),'2.46M');
  await page.click('#todayMenu > summary');
  assert.equal(await page.locator('#todayPanel').isVisible(),true);
  assert.match(await page.locator('#todayPanel').innerText(),/12[\s\S]*2\.46M[\s\S]*__proto__/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#todayPanel').isVisible(),false);
  await openAgent(page,sessions[0].key);
  assert.equal(await page.locator('#detailBody .ctx.full').count(),1,'a 90% context fill is shown as nearly full');
  await backToList(page);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
  check('the Today panel and context bars show usage and close with Escape');
  assert.equal(await page.locator('#showAgent').isChecked(),true);
  assert.deepEqual([...new Set(await badges(page))].sort(),['Cl','Cx','G','OMP']);
  assert.deepEqual(await drawnLogos(page),['claude','codex','gemini','omp']);
  assert.equal(await page.locator('#agentLegend img').evaluateAll(imgs=>imgs.length===4&&imgs.every(img=>img.complete&&img.naturalWidth>0)),true);
  check('all four agent icons load and show in 2D and the legend; OMP uses a neutral mark');
  await page.click('#agentChips [data-v=omp]');
  assert.deepEqual(await rowKeys(page),['omp:four']);
  assert.equal(await page.locator('#side .srow img').getAttribute('src'),'/assets/agents/omp.svg');
  await openAgent(page,'omp:four');
  assert.equal(await page.locator('#detailBody .copy').getAttribute('data-copy'),sessions.find(s=>s.agent==='omp').resumeCommand);
  await page.evaluate(()=>{window.__copied=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}})});
  await page.click('#detailBody .copy');
  assert.equal(await page.evaluate(()=>window.__copied),sessions.find(s=>s.agent==='omp').resumeCommand);
  await backToList(page);
  await page.reload();await page.waitForFunction(()=>state.loaded);
  assert.deepEqual(await page.evaluate(()=>state.agents),['omp']);assert.deepEqual(await rowKeys(page),['omp:four']);
  check('OMP filter, agent panel, Resume copy and saved filter work');
  await page.click('#agentChips [data-v=all]');await page.click('#agentChips [data-v=claude]');await page.click('#agentChips [data-v=codex]');
  assert.deepEqual((await rowKeys(page)).map(k=>k.split(':')[0]).sort(),['claude','claude','codex']);
  assert.deepEqual(await page.evaluate(()=>state.agents),['claude','codex']);
  await page.click('#agentChips [data-v=codex]');assert.deepEqual(await page.evaluate(()=>state.agents),['claude']);
  for (const a of ['codex','gemini','omp']) await page.click(`#agentChips [data-v=${a}]`);
  assert.deepEqual(await page.evaluate(()=>state.agents),[],'picking every client is the same as all');
  await page.evaluate(()=>{localStorage.setItem('wmad.agent',JSON.stringify('gemini'));localStorage.removeItem('wmad.agents')});await page.reload();await stable(page);
  assert.deepEqual(await page.evaluate(()=>state.agents),['gemini'],'an old single-agent filter carries over');
  await page.click('#agentChips [data-v=all]');
  check('the agent filter picks any number of clients, all of them, or carries an old choice over');
  await page.click('#agentChips [data-v=all]');
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
  await page.click('#agentChips [data-v=omp]');await frame.waitForFunction(()=>state.agents.join()==='omp');
  await frame.click('#viewSeg [data-v=list]');
  assert.equal(await frame.locator('.card').count(),1);
  assert.equal(await frame.locator('.card .copy').getAttribute('data-copy'),sessions.find(s=>s.agent==='omp').resumeCommand);
  await frame.click('#viewSeg [data-v=office]');
  check('OMP is in the pop-out filter and list with the right Resume command');
  await openSettings(page);await page.uncheck('#showAgent');await frame.waitForFunction(()=>!state.showAgent&&!office.showAgent);
  await page.click('#langMenu > summary');await page.click('#langList [data-lang="zh-TW"]');await frame.waitForFunction(()=>langCode==='zh-TW');
  await page.click('#agentChips [data-v=all]');await page.click('#agentChips [data-v=codex]');await frame.waitForFunction(()=>state.agents.join()==='codex');
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
  await page.click('#agentChips [data-v=all]');
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
  // App web views expose Document PiP but can't open its window: fall back to the video pop-out.
  await page.evaluate(()=>{const e=new Error('Internal error: no window');e.name='InvalidStateError';documentPictureInPicture.requestWindow=()=>Promise.reject(e)});
  await page.click('#pipBtn');await page.waitForFunction(()=>!popout.busy&&!!popout.stream);
  assert.equal(await page.locator('#pipError').isVisible(),false,'no error when the video pop-out can stand in');
  assert.equal(await page.locator('#pipPreview').isVisible(),true);
  await page.click('#closePreview');await page.waitForFunction(()=>!popout.stream);
  assert.equal(await page.evaluate(()=>popout.documentBroken),true,'later clicks go straight to the video pop-out');
  await page.evaluate(()=>{popout.documentBroken=false});
  check('a browser that cannot open the pop-out window falls back to the video pop-out');
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
  assert.equal(await page.locator('#side .srow[data-key="opencode:remote"] .nm').innerText(),'OpenCode');
  assert.equal(await resumeOf(page,'opencode:remote'),null);
  assert.equal(await resumeOf(page,'omp:remote'),null);
  assert.ok(await resumeOf(page,'omp:four'));
  assert.ok(await resumeOf(page,'claude:one'));
  await page.click('#agentChips [data-v=opencode]');
  assert.equal(await page.locator('#side .srow').count(),1);
  assert.equal(await page.locator('#agentChips [data-v=opencode]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#agentChips [data-v=opencode]').getAttribute('title'),'OpenCode');
  await page.evaluate(s=>onData({now:Date.now(),sessions:s.map(x=>x.source==='magpie'?{...x,status:'idle'}:x)}),magpieSessions);
  assert.equal(await page.locator('#side .srow').count(),0);
  await openSettings(page);await page.check('#showIdle');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#side .srow').count(),1);
  await page.reload();await page.waitForFunction(()=>state.loaded);
  await page.evaluate(s=>{__events.close();onData({now:Date.now(),sessions:s})},magpieSessions);
  assert.deepEqual(await page.evaluate(()=>state.agents),['opencode']);
  await page.click('#agentChips [data-v=all]');
  for (const quality of ['mid','high']) {
   await page.click(`#qualSeg [data-v=${quality}]`);
   await page.waitForFunction(q=>officeKind.startsWith(q)&&office.framesShown>4&&(q!=='high'||office.loaded),quality);
   assert.equal(await page.evaluate(()=>office.people.has('opencode:remote')),true);
  }
  check('Magpie clients reuse the agent panel, filters, idle visibility and both offices without invalid resume commands');
  const nativeClients = [
   {key:'kimi:one',id:'one',sessionId:'one',agent:'kimi',status:'thinking',cwd:'/demo/kimi'},
   {key:'dsh:two',id:'two',agent:'dsh',status:'waiting',activity:'Shell',cwd:'/demo/dsh'},
   {key:'grok:three',id:'three',agent:'grok',status:'tool',activity:'Read',cwd:'/demo/grok'},
   {key:'kimi:one/agent-1',id:'one/agent-1',sessionId:'one',parentId:'one',subagent:true,agent:'kimi',status:'thinking',cwd:'/demo/kimi'},
  ].map(s=>({...s,lastEventAt:Date.now()}));
  await page.evaluate(s=>{state.agents=[];state.showSub=false;onData({now:Date.now(),sessions:s})},nativeClients);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),nativeClients);
  assert.equal(await page.locator('#agentLegend img').count(),3, 'old providers leave the legend');
  for (const agent of ['kimi','dsh','grok']) {
   assert.equal(await page.locator(`#agentChips button[data-v="${agent}"]`).count(),1);
   const logo=page.locator(`#agentChips button[data-v="${agent}"] img`);
   await page.waitForFunction(agent=>{
    const img=document.querySelector(`#agentChips button[data-v="${agent}"] img`);
    return img?.complete&&img.naturalWidth>0;
   },agent);
   assert.equal(await logo.evaluate(img=>img.complete&&img.naturalWidth>0),true);
   assert.equal(await page.locator(`#agentLegend img[src="/assets/agents/${agent}.svg"]`).count(),1);
  }
  assert.equal(await page.locator('#side .srow').count(),3);
  assert.match(await resumeOf(page,'dsh:two'),/dsh tui --resume 'two'/);
  assert.match(await resumeOf(page,'kimi:one'),/kimi --session 'one'/);
  assert.match(await resumeOf(page,'grok:three'),/grok --resume 'three'/);
  await page.click('#agentChips [data-v=kimi]');
  assert.equal(await page.locator('#side .srow').count(),1);
  assert.equal(await page.locator('#agentLegend img').count(),1);
  assert.equal(await page.locator('#agentLegend img').getAttribute('src'),'/assets/agents/kimi.svg');
  await openSettings(page);await page.check('#showSub');
  assert.equal(await page.locator('#side .srow').count(),2);
  await page.click('#agentChips [data-v=all]');
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
   await openSettings(page);
   for (const agent of ['kimi','dsh','grok']) {
    const selector=`#agentChips [data-v="${agent}"] img`;
    const filter=await page.locator(selector).evaluate(img=>getComputedStyle(img).filter);
    assert.equal(filter,colorScheme==='dark'&&agent!=='dsh'?'invert(1)':'none');
   }
   for (const agent of ['kimi','grok']) {
    const filter=await page.locator(`#side .srow img[src="/assets/agents/${agent}.svg"]`).first().evaluate(img=>getComputedStyle(img).filter);
    assert.equal(filter,colorScheme==='dark'?'invert(1)':'none');
   }
   await screenshot(page,`panel-${colorScheme}`);
   await page.locator('#settingsMenu > summary').press('Escape');
   for(const quality of ['mid','high']) {
    await page.click(`#qualSeg [data-v=${quality}]`);
    await page.waitForFunction(q=>officeKind.startsWith(q)&&office.framesShown>4&&(q!=='high'||office.loaded),quality);
    assert.deepEqual(await drawnLogos(page),['dsh','grok','kimi']);
    await screenshot(page,`office-${quality}-${colorScheme}`);
   }
  }
  check('agent panel, filters, legend and both offices preserve light/dark native logos');
  const fallbackPage=await context.newPage();
  await fallbackPage.route('**/assets/agents/kimi.svg',route=>route.abort());
  await fallbackPage.goto(base);
  await fallbackPage.waitForFunction(()=>state.loaded);
  await fallbackPage.evaluate(s=>{__events.close();state.agents=[];state.showSub=true;onData({now:Date.now(),sessions:s})},nativeClients);
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
