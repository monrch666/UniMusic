import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'unimusic-features-'));
const env = {...process.env, UNIMUSIC_TEST_USER_DATA:directory};delete env.ELECTRON_RUN_AS_NODE;
const packaged=process.env.UNIMUSIC_EXECUTABLE;
const app=await electron.launch({executablePath:packaged||require('electron'),args:packaged?[]:[resolve('.')],env});
try {
 const page=await app.firstWindow();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const wav=Buffer.alloc(44+22050*2*4);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(22050,24);wav.writeUInt32LE(44100,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
 for(let i=0;i<22050*4;i++)wav.writeInt16LE(Math.round(Math.sin(2*Math.PI*110*i/22050)*12000),44+i*2);
 await writeFile(join(directory,'import.wav'),wav);
 await app.evaluate(({net,dialog,BrowserWindow},{directory,wav})=>{
  BrowserWindow.getAllWindows()[0].webContents.setAudioMuted(true);
  globalThis.__calls=[];
  net.fetch=async(input,init)=>{
   const method=String(input).split('/').at(-1);const params=new URLSearchParams(String(init?.body??''));
   if(String(input).startsWith('https://fixture.test/'))return new Response(Buffer.from(wav),{headers:{'Content-Type':'audio/wav','Content-Length':String(wav.length)}});
   const track=id=>({id,owner_id:123,artist:'Тестовый исполнитель',title:`Песня ${id}`,duration:4,url:`https://fixture.test/${id}.wav`});
   globalThis.__calls.push({method,offset:params.get('offset')});
   let data;
   if(method==='get_anonym_token')data={token:'fixture-anonymous'};
   else if(method==='auth.validateAccount')data={response:{sid:'fixture-sid',flow_name:'auth_without_password',next_step:{verification_method:'password'}}};
   else if(method==='token')data={access_token:'vk1.a.feature-test-credential-not-real',user_id:123};
   else if(method==='users.get')data={response:[{id:123,first_name:'Тест',last_name:'Функций'}]};
   else if(method==='audio.getById')data={response:[track(Number(params.get('audios').split('_')[1]))]};
   else if(method==='audio.get'||method==='audio.search')data={response:{count:4,items:params.get('offset')==='2'?[track(3),track(4)]:[track(1),track(2)]}};
   else if(method==='audio.getPlaylists')data={response:{count:1,items:[{id:7,owner_id:123,title:'Плейлист',count:4}]}};
   else if(method==='audio.getLyrics')data={response:{lyrics:{text:['Test text']}}};
   else if(method==='audio.createPlaylist')data={response:{id:8,owner_id:123,title:params.get('title'),count:0}};
   else if(method==='audio.add')data={response:Number(params.get('audio_id'))+1000};
   else if(method.startsWith('audio.'))data={response:1};
   else throw new Error('Unexpected fixture request');
   return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  };
  dialog.showOpenDialog=async(_win,options)=>({canceled:false,filePaths:[options.properties.includes('openDirectory')?directory:joinPath(directory,'import.wav')]});
  function joinPath(a,b){return a+'/'+b;}
 },{directory,wav:[...wav]});
 await page.evaluate(async()=>{const api=window.unimusic;await api.preferences({autoCache:false});await api.auth({type:'begin',login:'test@example.com'});const r=await api.auth({type:'password',password:'fixture'});if(!r.ok)throw new Error(r.error);});
 await page.reload();await page.getByRole('button',{name:'Выйти из VK',exact:true}).waitFor();
 await page.getByRole('button',{name:'Моя музыка',exact:true}).click();
  await page.getByRole('button',{name:'VK Музыка',exact:true}).click();
 await page.getByRole('button',{name:'Слушать всё',exact:true}).click();
 await page.getByRole('button',{name:'Пауза',exact:true}).waitFor();
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.now-playing strong').textContent==='Песня 2');
 await page.getByRole('button',{name:'Следующий трек',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.now-playing strong').textContent==='Песня 3');
 assert.ok(await app.evaluate(()=>globalThis.__calls.some(c=>c.method==='audio.get'&&c.offset==='2')));
 await page.getByRole('button',{name:'Пауза',exact:true}).click();
 await page.evaluate(async()=>{const api=window.unimusic;await api.offline({type:'directory'});await api.offline({type:'import'});const r=await api.browse({kind:'library'});await api.offline({type:'download',tracks:r.data.tracks});});
 await poll(()=>page.evaluate(async()=>{const r=await window.unimusic.offline({type:'list'});const error=r.data.entries.find(e=>e.state==='error');if(error)throw new Error(error.error);return r.data.entries.filter(e=>e.state==='complete').length===3;}));
 const offline=await page.evaluate(async()=>{const api=window.unimusic;const r=await api.offline({type:'list'});const song=r.data.entries.find(e=>e.track.ownerId===123).track;const source=await api.resolveTrack(song);const info=await api.trackInfo(song);return {source:source.ok?source.data.url:source.error,info};});
 
 assert.match(offline.source,/^unimusic-media:\/\/file\//);assert.ok(offline.info.ok&&offline.info.data.size>1000);
 await page.evaluate(async()=>{const r=await window.unimusic.playback();if(!r.ok)throw new Error(r.error);});
 await poll(()=>page.evaluate(async()=>{const r=await window.unimusic.playback();return r.ok&&r.data?.queue.length===4;}));
 await page.reload();await page.waitForFunction(()=>document.querySelector('.now-playing strong').textContent==='Песня 3');
 assert.equal(await page.getByRole('button',{name:'Воспроизвести',exact:true}).count(),1);
 await page.getByRole('button',{name:'Моя музыка',exact:true}).click();await page.getByRole('button',{name:'На устройстве',exact:true}).click();
 await page.getByRole('button',{name:'Слушать: Песня 1',exact:true}).click();await page.getByRole('button',{name:'Пауза',exact:true}).waitFor();
 await page.screenshot({path:resolve('test-results/features-offline.png')});
 await page.getByRole('button',{name:'Настройки',exact:true}).click();
 await page.getByRole('checkbox',{name:'Продолжать музыку в трее при закрытии окна',exact:true}).click();
 await poll(()=>page.evaluate(async()=>{const r=await window.unimusic.preferences();return r.ok&&r.data.closeToTray;}));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
 await page.getByRole('checkbox',{name:'Продолжать музыку в трее при закрытии окна',exact:true}).click();
 await poll(()=>page.evaluate(async()=>{const r=await window.unimusic.preferences();return r.ok&&!r.data.closeToTray;}));
 await page.evaluate(async()=>{await window.unimusic.offline({type:'clear'});await window.unimusic.preferences({autoCache:true});});
 const unliked=await page.evaluate(async()=>{
  const api=window.unimusic;
  const track={source:'vk',id:88,ownerId:999,title:'Без лайка',artist:'Test',duration:4,url:'',restricted:false};
  await api.played(track);
  const before=await api.offline({type:'list'});
  const liked=await api.library({type:'add',track});
  if(!liked.ok)throw new Error(liked.error);
  return before;
 });
 assert.equal(unliked.data.entries.length,0);
 await poll(()=>page.evaluate(async()=>{const r=await window.unimusic.offline({type:'list'});return r.ok&&r.data.entries.some(e=>e.track.id===1088&&e.state==='complete');}));
 await page.evaluate(async()=>{
  const api=window.unimusic;
  const track={source:'vk',id:1088,ownerId:123,title:'Без лайка',artist:'Test',duration:4,url:'',restricted:false};
  await api.library({type:'delete',track});
  await api.offline({type:'clear'});
  await api.played(track);
 });
 const afterUnlike=await page.evaluate(()=>window.unimusic.offline({type:'list'}));
 assert.equal(afterUnlike.data.entries.length,0);
 await page.getByRole('button',{name:'Моя музыка',exact:true}).click();
 await page.getByRole('button',{name:'Слушать: Песня 2',exact:true}).click();
 await poll(()=>page.evaluate(async()=>{const r=await window.unimusic.offline({type:'list'});return r.ok&&r.data.entries.some(e=>e.track.id===2&&e.state==='complete');}));
 await page.getByRole('button',{name:'Настройки',exact:true}).click();
 const autoCache=page.getByRole('checkbox',{name:'Автоматически скачивать только лайкнутые песни',exact:true});
 assert.equal(await autoCache.isChecked(),true);
 await autoCache.click();
 await poll(()=>page.evaluate(async()=>{const r=await window.unimusic.preferences();return r.ok&&!r.data.autoCache;}));
 await page.evaluate(async()=>{await window.unimusic.played({id:99,ownerId:123,title:'Disabled',artist:'Test',duration:4,url:'',restricted:false});});
 const state=await page.evaluate(async()=>window.unimusic.offline({type:'list'}));
 assert.equal(state.data.entries.some(e=>e.track.id===99),false);
 await page.screenshot({path:resolve('test-results/auto-cache-settings.png')});
 await page.getByRole('button',{name:'Главная',exact:true}).click();
 await page.screenshot({path:resolve('test-results/home-glass.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS: paginated queue, encrypted restore, import, download/transcode, offline playback, automatic caching, opt-out and tray.');
} finally {
 await app.close();assert.ok(directory.startsWith(join(tmpdir(),'unimusic-features-')));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:300});
}

async function poll(action) {
 const deadline=Date.now()+60000;
 while(Date.now()<deadline){if(await action())return;await new Promise(r=>setTimeout(r,150));}
 throw new Error("Asynchronous feature check timed out");
}
