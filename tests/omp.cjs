// Только искусственные журналы: история пользователя в тестах не используется.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { newSession, applyOMP, applyClaude, applyCodex, applyGemini } = require('../src/parsers');
const { ompDirs, ompResumeCommand } = require('../src/omp');
const { snapshot } = require('../src/server');
const NOW = Date.parse('2026-10-26T10:00:00Z');
const HOUR = 3600000;
const entry = (type, extra={}) => ({ type, timestamp:new Date(NOW).toISOString(), ...extra });
const message = (role, extra={}) => entry('message', { message:{ role, ...extra } });
const user = () => message('user', { content:[{type:'text',text:'Проверь проект'}] });
const call = (id, name='read') => ({type:'toolCall',id,name,arguments:{path:'file.js'}});
const assistant = (content, stopReason='toolUse') => message('assistant',{content,stopReason});
const result = id => message('toolResult',{toolCallId:id,toolName:'read',content:[{type:'text',text:'ok'}]});
const lines = entries => entries.map(e=>JSON.stringify(e)+'\n').join('');
const session = () => newSession('omp',null,'/tmp/sample.jsonl');
const apply = (s,...es) => {for(const e of es)applyOMP(s,e);return s;};

test('OMP: metadata, настоящий ID, происхождение и смена модели',()=>{
 const s=apply(session(),entry('title',{title:'Текущее имя'}),entry('session',{id:'real-id',cwd:'C:\\Проект с пробелом',title:'Старое имя',parentSession:'ancestor'}),entry('model_change',{model:'openai/main'}),entry('model_change',{role:'smol',model:'openai/small'}));
 assert.equal(s.id,'real-id');assert.equal(s.sessionId,'real-id');assert.equal(s.title,'Текущее имя');
 assert.equal(s.cwd,'C:\\Проект с пробелом');assert.equal(s.model,'openai/main');assert.equal(s.subagent,false);assert.equal(s.parentId,null);
 apply(s,entry('title_change',{title:'Новое имя'}));assert.equal(s.title,'Новое имя');
});
test('OMP: пользователь, toolCall/toolResult и завершённый ответ',()=>{
 const s=apply(session(),user());assert.equal(s.status,'thinking');assert.equal(s.prompt,'Проверь проект');
 apply(s,assistant([call('one')]));assert.equal(s.status,'tool');assert.match(s.activity,/read/);
 apply(s,result('one'));assert.equal(s.status,'thinking');assert.equal(s.activity,null);
 apply(s,assistant([{type:'text',text:'Готово?'}],'stop'));assert.equal(s.status,'done');assert.equal(s.reply,'Готово?');
});
test('OMP: несколько незавершённых инструментов и ask',()=>{
 const s=apply(session(),user(),assistant([call('one'),call('two','bash'),call('question','ask')]));
 assert.equal(s.status,'waiting');apply(s,result('one'));assert.equal(s.status,'waiting');
 apply(s,result('question'));assert.equal(s.status,'tool');assert.match(s.activity,/bash/);
 apply(s,result('two'));assert.equal(s.status,'thinking');
});
test('OMP: отдельный tool_execution_start и повторный маркер не теряют pending',()=>{
 const s=apply(session(),user(),assistant([call('one'),call('two')]));
 apply(s,entry('custom',{customType:'tool_execution_start',data:{toolCallId:'one',toolName:'read'}}),result('one'));
 assert.equal(s.status,'tool');apply(s,result('two'));assert.equal(s.status,'thinking');
 apply(s,entry('custom',{customType:'tool_execution_start',data:{toolCallId:'ask',toolName:'ask'}}));assert.equal(s.status,'waiting');
});
test('OMP: error, aborted, восстановление и ошибки инструментов',()=>{
 const s=apply(session(),user(),assistant([],'error'));assert.equal(s.status,'error');assert.ok(s.error);
 apply(s,user());assert.equal(s.error,null);apply(s,assistant([],'aborted'));assert.equal(s.status,'interrupted');
 apply(s,user(),assistant([call('one')]),message('toolResult',{toolCallId:'one',isError:true,content:'ошибка чтения'}));
 assert.equal(s.status,'error');assert.equal(s.error,'ошибка чтения');
 apply(s,assistant([{type:'text',text:'Исправлено'}],'stop'));assert.equal(s.status,'done');assert.equal(s.error,null);
});
test('OMP: session_exit различает завершение, прерывание и fatal',()=>{
 const exit=(kind,extra={})=>entry('custom',{customType:'session_exit',data:{kind,...extra}});
 const s=apply(session(),user(),assistant([{type:'text',text:'Готово'}],'stop'),exit('normal'));assert.equal(s.status,'done');
 apply(s,user(),assistant([call('one')]),exit('normal'));assert.equal(s.status,'interrupted');
 apply(s,user(),exit('signal'));assert.equal(s.status,'interrupted');
 apply(s,user(),exit('fatal',{reason:'fatal fixture'}));assert.equal(s.status,'error');
});
test('OMP: служебные события, developer и неверный snake_case не меняют состояние',()=>{
 const s=apply(session(),user(),assistant([call('one')]));
 apply(s,message('tool_result',{toolCallId:'one'}),message('developer',{content:'инструкция'}),entry('model_usage',{model:'tiny'}),entry('custom',{customType:'approval',data:{}}));
 assert.equal(s.status,'tool');assert.equal(s.prompt,'Проверь проект');
});

function fixture(t, {env={}, override}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wmad-omp-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const reads=[];let now=NOW;
 const io=new Proxy(fs,{get(target,name){
  if(name==='readSync')return (fd,b,o,n,pos)=>{reads.push(n);return target.readSync(fd,b,o,n,pos)};
  return target[name];
 }});
 const file=path.join(__dirname,'../src/watcher.js'), mod={exports:{}};
 class Clock extends Date{static now(){return now}}
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{
  module:mod,Buffer,Date:Clock,process:{env,platform:'win32'},setInterval,clearInterval,
  require:name=>name==='fs'?io:name==='os'?{homedir:()=>root}:createRequire(file)(name),
 },{filename:file});
 const watcher=new mod.exports.Watcher({ompDir:override?.(root)});
 const write=(rel,es,at=now)=>{const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,lines(es));fs.utimesSync(f,new Date(at),new Date(at));return f};
 const append=(f,es)=>{fs.appendFileSync(f,lines(es));fs.utimesSync(f,new Date(now),new Date(now))};
 const header=id=>entry('session',{id,cwd:'/fixture/project',parentSession:'lineage-only'});
 return {root,watcher,write,append,header,reads,advance(ms=6000){now+=ms}};
}
test('OMP: свежие файлы, возобновлённые старые сессии, артефакты и неверные JSONL',t=>{
 const f=fixture(t), dir='.omp/agent/sessions/project/';
 const old=f.write(dir+'old-name.jsonl',[f.header('actual-id'),user()],NOW-48*HOUR);
 f.write(dir+'fresh.jsonl',[entry('title',{title:'Имя'}),f.header('fresh-id'),user()]);
 f.write(dir+'fresh/Worker.jsonl',[f.header('child'),user()]);f.write(dir+'fresh/__advisor.jsonl',[f.header('advisor'),user()]);
 f.write(dir+'garbage.jsonl',[user()]);
 f.watcher.tick();assert.deepEqual(Array.from(f.watcher.sessions(),s=>s.id),['fresh-id']);
 f.advance();f.append(old,[user()]);f.watcher.tick();
 assert.deepEqual(Array.from(f.watcher.sessions(),s=>s.id).sort(),['actual-id','fresh-id']);
 assert.equal(f.watcher.sessions()[0].subagent,false);
 const tracker=f.watcher.trackers.get(old);f.advance(1000);f.append(old,[assistant([call('one')])]);f.watcher.tick();
 assert.equal(f.watcher.trackers.get(old),tracker);assert.equal(tracker.session.status,'tool');
});
test('OMP: частичная последняя строка и разрыв UTF-8 между опросами',t=>{
 const f=fixture(t),file=f.write('.omp/agent/sessions/project/x.jsonl',[f.header('real')]);
 const tail=Buffer.from(lines([message('user',{content:'Привет'})]));const idx=tail.indexOf(Buffer.from('и'))+1;
 fs.appendFileSync(file,tail.subarray(0,idx));f.watcher.tick();assert.equal(f.watcher.sessions()[0].prompt,null);
 fs.appendFileSync(file,tail.subarray(idx));f.advance(1000);f.watcher.tick();assert.equal(f.watcher.sessions()[0].prompt,'Привет');
 assert.equal(f.watcher.sessions()[0].status,'thinking');
});
test('OMP: переименование слота при неизменном размере, а также вместе с append',t=>{
 const f=fixture(t),slot=title=>JSON.stringify({type:'title',title,pad:' '.repeat(50-title.length)})+'\n';
 const file=f.write('.omp/agent/sessions/project/x.jsonl',[f.header('real'),entry('title_change',{title:'Историческое имя'}),user()]);
 const body=fs.readFileSync(file);fs.writeFileSync(file,Buffer.concat([Buffer.from(slot('Первое')),body]));f.watcher.tick();
 assert.equal(f.watcher.sessions()[0].title,'Первое');const size=fs.statSync(file).size;
 const fd=fs.openSync(file,'r+');fs.writeSync(fd,slot('Второе'),0,'utf8');fs.closeSync(fd);f.advance(1000);f.watcher.tick();
 assert.equal(fs.statSync(file).size,size);assert.equal(f.watcher.sessions()[0].title,'Второе');
 const next=fs.openSync(file,'r+');fs.writeSync(next,slot('Третье'),0,'utf8');fs.closeSync(next);
 f.append(file,[assistant([{type:'text',text:'Ответ'}],'stop')]);f.advance(1000);f.watcher.tick();
 assert.equal(f.watcher.sessions()[0].title,'Третье');assert.equal(f.watcher.sessions()[0].status,'done');
});
test('OMP: большой журнал, длинная строка и toolCall в середине файла',t=>{
 const f=fixture(t),file=f.write('.omp/agent/sessions/project/x.jsonl',[f.header('real'),user()]);
 const padding=entry('padding',{text:'x'.repeat(4096)});
 f.append(file,[...Array(80).fill(padding),assistant([call('one'),call('two')]),message('user',{steering:true,content:'Длинное сообщение '+ 'z'.repeat(1100000)}),...Array(240).fill(padding),result('one')]);
 f.watcher.tick();const s=f.watcher.sessions()[0];assert.equal(s.id,'real');assert.equal(s.cwd,'/fixture/project');assert.equal(s.status,'tool');
 assert.ok(Math.max(...f.reads)<=128*1024,'чтение ограничено порциями');
 f.append(file,[result('two'),assistant([{type:'text',text:'Завершено'}],'stop')]);f.advance(1000);f.watcher.tick();assert.equal(f.watcher.sessions()[0].status,'done');
});
test('OMP: явный нестандартный корень и прямой --session-dir',t=>{
 for(const direct of [false,true]){
  const f=fixture(t,{override:root=>path.join(root,'custom folder')});
  f.write('custom folder/'+(direct?'':'project/')+'x.jsonl',[f.header('custom-id'),user()]);
  f.write('.omp/agent/sessions/project/default.jsonl',[f.header('ignored'),user()]);
  if(direct)f.write('custom folder/x/Worker.jsonl',[f.header('ignored-child'),user()]);
  f.watcher.tick();assert.deepEqual(Array.from(f.watcher.sessions(),s=>s.id),['custom-id']);
 }
});
test('OMP: профиль и env override хранилища',t=>{
 const f=fixture(t);f.write('.omp/profiles/work/agent/sessions/project/x.jsonl',[f.header('profile-id'),user()]);
 f.watcher.tick();assert.equal(f.watcher.sessions()[0].ompProfile,'work');
 const custom=ompDirs(null,{PI_CODING_AGENT_DIR:path.join(f.root,'agent override')},f.root,'win32');assert.equal(custom[0].dir,path.join(f.root,'agent override/sessions'));
 assert.deepEqual(ompDirs(null,{WMAD_OMP_SESSIONS_DIR:f.root},f.root),[{dir:f.root,profile:null}]);
});
test('OMP: удаление, усечение и новый заголовок не оставляют старое состояние',t=>{
 const f=fixture(t),file=f.write('.omp/agent/sessions/project/x.jsonl',[f.header('old'),user(),assistant([call('one')])]);f.watcher.tick();
 fs.writeFileSync(file,lines([f.header('new'),user()]));f.advance(1000);f.watcher.tick();assert.equal(f.watcher.sessions()[0].id,'new');
 fs.unlinkSync(file);f.advance(1000);f.watcher.tick();assert.equal(f.watcher.sessions().length,0);
});
test('OMP: Resume содержит ID, профиль, cwd и каталог, с экранированием PowerShell',()=>{
 const s={id:'real-id',cwd:"C:\\проект с пробелом\\O'Brien $(whoami) `quote`",file:"C:\\сеансы\\O'Brien\\x.jsonl",ompProfile:'work'};
 const cmd=ompResumeCommand(s,'win32');assert.match(cmd,/--resume 'real-id'/);assert.match(cmd,/--profile 'work'/);assert.match(cmd,/O''Brien/);assert.ok(!cmd.includes('&&'));
 if(process.platform==='win32'){
  const script="function omp { ConvertTo-Json -Compress -InputObject @($args) }; "+cmd;
  const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);const args=JSON.parse(run.stdout.trim());
  assert.deepEqual(args,['--profile','work','--cwd',s.cwd,'--session-dir',path.dirname(s.file),'--resume','real-id']);
 }
 assert.match(ompResumeCommand({...s,cwd:"/tmp/O'Brien"},'linux'),/O'\\''Brien/);
});
test('OMP: snapshot и приватный режим сохраняют Resume, скрывают переписку',()=>{
 const s=apply(session(),entry('session',{id:'real',cwd:'/demo'}),user(),assistant([{type:'text',text:'Готово'}],'stop'));
 const out=snapshot({sessions:()=>[s]},{privacy:true}).sessions[0];assert.equal(out.id,'real');assert.match(out.resumeCommand,/--resume 'real'/);
 assert.equal(out.prompt,null);assert.equal(out.reply,null);assert.equal(out.title,null);
});
test('Три прежних парсера продолжают обрабатывать свои форматы',()=>{
 const a=newSession('claude','a','a');applyClaude(a,{type:'user',message:{content:'Привет'}});assert.equal(a.status,'thinking');
 const b=newSession('codex','b','b');applyCodex(b,{type:'event_msg',payload:{type:'task_complete',last_agent_message:'Готово'}});assert.equal(b.status,'done');
 const c=newSession('gemini','c','c');applyGemini(c,{type:'gemini',content:'Ответ'});assert.equal(c.status,'typing');
});
