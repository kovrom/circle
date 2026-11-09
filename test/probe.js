// Behaviour checks for the real app, run by test/run.sh. Each SCENARIO starts main.js
// headless with a throwaway profile, faked weather/web pages and stubbed nmcli/systemctl.
const { app, BrowserWindow, session } = require('electron');
const path=require('path'),fs=require('fs'),http=require('http');
const PROJ=process.env.CIRCLE_PROJ||path.resolve(__dirname,'..'),ROOT=process.env.CIRCLE_ROOT,SC=process.env.SCENARIO;
const UD=path.join(ROOT,'ud',SC),STUB=process.env.CIRCLE_STUB_LOG;
fs.rmSync(UD,{recursive:true,force:true});fs.mkdirSync(UD,{recursive:true});fs.writeFileSync(STUB,'');
const sleep=m=>new Promise(r=>setTimeout(r,m));
let fails=0;const check=(n,ok,x='')=>{console.log((ok?'PASS':'FAIL')+' ['+SC+'] '+n+(x!==''?'  -> '+x:''));if(!ok)fails++;};
const hits={};const ix=['main','offline','hang','meteofail','uvoff','corrupt','legacy','minimal','extras'].indexOf(SC);const PORT=38761+ix*2,PORT2=PORT+1;
const handler=(q,s)=>{hits[q.url]=(hits[q.url]||0)+1;s.setHeader('content-type','text/html');s.end('<title>'+q.url+'</title><h1>'+q.url+'</h1>');};
http.createServer(handler).listen(PORT,'127.0.0.1');
const late=http.createServer(handler);
const U=p=>`http://127.0.0.1:${PORT}/${p}`;const DEAD=`http://127.0.0.1:${PORT2}/dead`;
const base={urls:[{url:U('a'),backgroundColor:'#000000'},{url:U('b'),backgroundColor:'#102226'},{url:U('c'),backgroundColor:'#000000'}],autoRotate:false,autoRotateInterval:60000,fullscreen:false,enableDevTools:false,screensaverUrl:'@Quotes/index.html',screensaverEnabled:true,uvUpdateFrequency:60,latitude:40.7,longitude:-74};
const cfgPath=path.join(UD,'config.json');
const CFG={main:JSON.stringify(base),offline:JSON.stringify({...base,urls:[{url:DEAD,backgroundColor:'#000000'}]}),hang:JSON.stringify(base),meteofail:JSON.stringify(base),uvoff:JSON.stringify({...base,showUV:false,uvUpdateFrequency:0.05}),corrupt:'{ "urls": [ oops',legacy:JSON.stringify({...base,urls:[U('a'),U('b')]}),minimal:JSON.stringify({urls:[U('a')]}),extras:JSON.stringify({...base,autoRotate:true,autoRotateInterval:2000})}[SC];
fs.writeFileSync(cfgPath,CFG);
app.setPath('userData',UD);app.setAppPath(PROJ);app.setAsDefaultProtocolClient=()=>false;
require(PROJ+'/node_modules/electron-log').transports.file.resolvePathFn=()=>path.join(UD,'main.log');
let quitAttempts=0;app.on('before-quit',e=>{quitAttempts++;if(!global.__done)e.preventDefault();});
const csp=[];app.on('web-contents-created',(_e,c)=>{c.on('console-message',ev=>{if(/Content Security Policy/i.test(ev.message||''))csp.push(ev.message)});});
require(PROJ+'/main.js');
const T0=Date.now();const meteo={n:0,temp:0,urls:[]};
const JSONH={'content-type':'application/json','access-control-allow-origin':'*'};
const meteoBody=JSON.stringify({daily:{sunrise:['2026-11-09T06:30'],sunset:['2026-11-09T16:45'],uv_index_max:[3]},current:{uv_index:4,temperature_2m:21,relative_humidity_2m:55}});
const done=c=>{global.__done=true;console.log('DONE ['+SC+'] fails='+fails);app.exit(c)};
app.whenReady().then(async()=>{
  session.defaultSession.protocol.handle('https',async req=>{
    if(req.url.includes('open-meteo')){meteo.n++;if(req.url.includes('temperature_2m'))meteo.temp++;meteo.urls.push(req.url);
      if(SC==='hang')return new Promise(()=>{});
      if(SC==='meteofail'&&Date.now()-T0<6000)return new Response('x',{status:500,headers:JSONH});
      return new Response(meteoBody,{headers:JSONH});}
    return new Response('<h1>stub</h1>',{headers:{'content-type':'text/html'}});
  });
  await sleep(500);
  const mainWin=BrowserWindow.getAllWindows()[0];const win=()=>mainWin;
  const R=js=>win().webContents.executeJavaScript(js);
  const inst=f=>R(f);
  const cur=()=>{const v=win().getBrowserView();return v?v.webContents.getURL():null};
  const overlayHidden=()=>R(`document.getElementById('error-overlay').classList.contains('hidden')`);
  const loadingGone=()=>R(`getComputedStyle(document.getElementById('loading-screen')).display==='none'`);
  const tabs=()=>app.getAppMetrics().filter(m=>m.type==='Tab').length;
  const stub=()=>fs.readFileSync(STUB,'utf8');
  const count=re=>(stub().match(re)||[]).length;
  const openS=async()=>{await R(`document.getElementById('settings-btn').click()`);await sleep(500)};
  const closeS=async()=>{await R(`document.getElementById('settings-cancel').click()`);await sleep(300)};
  const saveS=async()=>{await R(`document.getElementById('settings-form').requestSubmit()`);await sleep(1200)};
  try{ await ({
   async main(){
    await sleep(4000);
    check('loading screen cleared',await loadingGone());
    const idx=()=>[U('a'),U('b'),U('c')].indexOf(cur());
    win().isFocused=()=>true;
    let i0=idx();win().webContents.focus();win().webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});await sleep(400);win().webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await sleep(400);
    check('one key press moves one slide',idx()===(i0+1)%3,i0+'->'+idx());
    for(let n=0;n<3;n++){await openS();if(n<2)await closeS();}
    await R(`document.getElementById('wifi-refresh-btn').click()`);await sleep(1000);
    check('one Refresh click runs one scan',count(/wifi list/g)===1,count(/wifi list/g));
    const opts=await R(`[...document.querySelectorAll('#wifi-networks-select option')].map(o=>o.textContent)`);
    check('SSID with spaces intact',opts.some(o=>o.includes('My Home WiFi')),JSON.stringify(opts));
    check('connected network marked',opts.some(o=>o.includes('(Connected)')));
    check('terse-escaped colon SSID',opts.some(o=>o.includes('Cafe:Net')));
    check('duplicate/hidden SSIDs dropped',opts.length===3,opts.length);
    const st=await R(`document.getElementById('wifi-status-text').textContent`);check('status names full SSID',st.includes('My Home WiFi'),st);
    await R(`(()=>{const s=document.getElementById('wifi-networks-select');s.selectedIndex=0;document.getElementById('wifi-password').value='goodpass';document.getElementById('wifi-connect-btn').click()})()`);await sleep(1500);
    check('one Connect click runs one connect',count(/wifi connect/g)===1,count(/wifi connect/g));
    await R(`(()=>{const s=document.getElementById('wifi-networks-select');s.selectedIndex=0;document.getElementById('wifi-password').value='badpass-S3CR3T';document.getElementById('wifi-connect-btn').click()})()`);await sleep(1500);
    const lg=fs.readFileSync(path.join(UD,'main.log'),'utf8');check('password not in log',!lg.includes('S3CR3T'));
    const shown=await R(`document.body.innerText`);check('password not on screen',!shown.includes('S3CR3T'));
    await closeS();
    await sleep(3500);
    const before=JSON.stringify(hits);fs.writeFileSync(STUB,'');
    await openS();await saveS();await openS();await saveS();
    check('Save with same URLs reloads nothing',JSON.stringify(hits)===before,before+' vs '+JSON.stringify(hits));
    check('Save with autostart unchanged runs no enable/disable/stop',count(/enable|disable|stop/g)-count(/is-enabled/g)===0,JSON.stringify(stub()));
    check('view attached after saves',cur()!==null,cur());
    const a=idx();await R(`window.electronAPI.invoke('next-slide')`);await sleep(400);check('next-slide moves one after 2 saves',idx()===(a+1)%3,a+'->'+idx());
    check('indicators match urls',await R(`document.querySelectorAll('.indicator').length`)===3);
    fs.writeFileSync(STUB,'');await openS();await R(`document.getElementById('autostart-enabled').checked=true`);await saveS();
    check('autostart on enables once',count(/ enable circle/g)===1,JSON.stringify(stub()));
    const svc=path.join(process.env.HOME,'.config/systemd/user/circle.service');check('service file written under fake HOME',fs.existsSync(svc));
    fs.writeFileSync(STUB,'');await openS();await sleep(400);await R(`document.getElementById('autostart-enabled').checked=false`);await saveS();
    check('autostart off disables without stop',count(/ disable circle/g)===1&&count(/ stop circle/g)===0,JSON.stringify(stub()));
    const wn=BrowserWindow.getAllWindows().length;const vw=win().getBrowserView().webContents;await vw.executeJavaScript(`window.open('about:blank','_blank')?1:0`,true).catch(()=>{});await sleep(800);
    check('window.open denied',BrowserWindow.getAllWindows().length===wn,wn+'->'+BrowserWindow.getAllWindows().length);
    BrowserWindow.getAllWindows().filter(w=>w!==mainWin).forEach(w=>w.destroy());
    const perm=await vw.executeJavaScript(`navigator.permissions.query({name:'notifications'}).then(p=>p.state)`);check('notifications not granted',perm!=='granted',perm);
    const t0=tabs();await R(`window.electronAPI.invoke('show-screensaver')`);await sleep(2500);
    check('screensaver covers window',cur()&&cur().includes('Quotes'),cur());
    check('screensaver loaded quotes',(await win().getBrowserView().webContents.executeJavaScript(`document.querySelectorAll('.ts-line').length`))>0);
    win().webContents.focus();win().webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await sleep(500);
    check('Esc on screensaver hides it, no quit',quitAttempts===0&&!(cur()||'').includes('Quotes'),'quits='+quitAttempts+' cur='+cur());
    if((cur()||'').includes('Quotes')){await R(`window.electronAPI.invoke('hide-screensaver')`);}
    await sleep(1500);check('process count back to baseline after screensaver',tabs()===t0,t0+'->'+tabs());
    await openS();win().webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await sleep(600);
    check('Esc closes Settings',await R(`document.getElementById('settings-overlay').classList.contains('hidden')`));
    check('view reattached after modal',cur()!==null);
    await openS();await R(`document.getElementById('add-url-btn').click()`);await R(`(()=>{const l=[...document.querySelectorAll('.url-input')].pop();l.value='${DEAD}'})()`);await saveS();
    check('indicators grew',await R(`document.querySelectorAll('.indicator').length`)===4);
    await R(`window.electronAPI.invoke('go-to-slide',3)`);await sleep(1500);
    check('failed slide shows error after saves',!(await overlayHidden()));
    check('failed slide detached so error is visible',cur()===null,cur());
    await R(`window.electronAPI.invoke('go-to-slide',0)`);await sleep(700);check('error clears on healthy slide',await overlayHidden());check('healthy slide attached',cur()===U('a'),cur());
    check('facts IPC returns array',Array.isArray(await R(`window.electronAPI.invoke('get-todays-bitcoin-fact')`)));
    check('no CSP violations',csp.length===0,csp[0]||'');
   },
   async offline(){
    await sleep(2500);
    check('dead URL shows error',!(await overlayHidden()));
    check('dead URL detached so error is visible',cur()===null,cur());
    late.listen(PORT2,'127.0.0.1');
    let ok=false;for(let i=0;i<30&&!ok;i++){await sleep(1000);ok=cur()===DEAD&&await overlayHidden()&&(hits['/dead']||0)>=1;}
    check('recovers by itself once reachable',ok,'cur='+cur()+' hits='+JSON.stringify(hits));
   },
   async hang(){await sleep(4000);check('loading clears with weather hung',await loadingGone());},
   async meteofail(){await sleep(36000);check('weather retried after failure',meteo.n>=2,meteo.n);check('value recovered',(await R(`document.getElementById('temperature-value').textContent`)).startsWith('21'),await R(`document.getElementById('temperature-value').textContent`)+' / unit C=21');},
   async uvoff(){await sleep(11000);check('temp keeps refreshing with UV off',meteo.temp>=3,meteo.temp);check('uv group hidden',await R(`getComputedStyle(document.querySelector('.uv-index-group')).display==='none'`));},
   async corrupt(){await sleep(3000);check('broken config not overwritten',fs.readFileSync(cfgPath,'utf8')===CFG);check('broken config backed up',fs.existsSync(cfgPath+'.broken'));check('app still up with defaults',await R(`document.querySelectorAll('.indicator').length`)>=1);},
   async legacy(){await sleep(3000);check('string urls load',cur()===U('a'),cur());check('indicators',await R(`document.querySelectorAll('.indicator').length`)===2);await openS();await saveS();const c=JSON.parse(fs.readFileSync(cfgPath,'utf8'));check('saved as objects',typeof c.urls[0]==='object');check('view after save',cur()===U('a'),cur());},

   async extras(){
    await sleep(1500);const seen=new Set();for(let i=0;i<12;i++){seen.add(cur());await sleep(500);}
    check('auto-rotate advances',seen.size>=2,[...seen].join(' '));
    await openS();const during=new Set();for(let i=0;i<10;i++){during.add(await R(`digitalSignageInstance.currentIndex`));await sleep(500);}
    check('auto-rotate paused in Settings',during.size===1,[...during].join());check('page hidden during modal',cur()===null);
    await R(`document.getElementById('rotate-interval').value='1'`);await saveS();const st=await R(`({t:digitalSignageInstance.autoRotateTimer!==null,p:digitalSignageInstance.autoRotatePaused,i:digitalSignageInstance.config.autoRotateInterval})`);
    check('auto-rotate re-armed after Save (form clamps to 1 min)',st.t&&!st.p&&st.i===60000,JSON.stringify(st));
    await R(`document.getElementById('settings-btn').click()`);await sleep(400);await R(`digitalSignageInstance.autoRotatePaused=true`);
    await R(`document.getElementById('virtual-keyboard-toggle').click()`);await sleep(100);
    const kb=()=>R(`!document.getElementById('virtual-keyboard').classList.contains('hidden')`);
    check('virtual keyboard opens',await kb());await closeS();check('keyboard hidden on close',!(await kb()));
    await openS();await R(`document.getElementById('virtual-keyboard-toggle').click()`);await sleep(100);check('keyboard opens with ONE tap on reopen',await kb());await closeS();
    await R(`digitalSignageInstance.config.autoRotate=false;digitalSignageInstance.resetAutoRotate()`);
    const n0=meteo.n,f0=await R(`digitalSignageInstance.currentDay='stale';digitalSignageInstance.checkDayChange();digitalSignageInstance.currentDay`);await sleep(500);
    check('date change refreshes data',meteo.n===n0+1&&f0===new Date().toDateString(),n0+'->'+meteo.n);
    await R(`digitalSignageInstance.checkDayChange()`);await sleep(300);check('same day does not refresh',meteo.n===n0+1,meteo.n);
    await R(`digitalSignageInstance.showBitcoinHistoryModal([{year:2009,month:1,day:3,title:'T',description:'D'}])`);await sleep(500);
    check('history modal open, page hidden',!(await R(`document.getElementById('bitcoin-history-overlay').classList.contains('hidden')`))&&cur()===null);
    win().isFocused=()=>true;win().webContents.focus();win().webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await sleep(500);
    check('Esc closes history modal',await R(`document.getElementById('bitcoin-history-overlay').classList.contains('hidden')`));check('page back after modal',cur()!==null);check('no quit from Esc in modal',quitAttempts===0);
    const t0=tabs();await R(`window.electronAPI.invoke('show-screensaver')`);await sleep(1500);
    await win().getBrowserView().webContents.executeJavaScript(`document.body.click();1`);await sleep(1200);
    check('click dismisses screensaver',!(cur()||'').includes('Quotes')&&cur()!==null,cur());check('no leftover process',tabs()===t0,t0+'->'+tabs());
    await R(`window.electronAPI.invoke('show-screensaver')`);await sleep(1200);win().getBrowserView().webContents.sendInputEvent({type:'keyDown',keyCode:'A'});await sleep(1200);
    check('key in screensaver dismisses',!(cur()||'').includes('Quotes'),cur());
    await R(`window.electronAPI.invoke('show-screensaver')`);await sleep(800);check('screensaver reopens',(cur()||'').includes('Quotes'),cur());await R(`window.electronAPI.invoke('hide-screensaver')`);await sleep(600);
    const pageWc=win().getBrowserView().webContents;const u=pageWc.getURL();pageWc.forcefullyCrashRenderer();await sleep(9000);
    check('crashed page comes back',cur()===u&&await overlayHidden(),'cur='+cur()+' overlayHidden='+await overlayHidden());
    check('no CSP violations',csp.length===0,csp[0]||'');
   },
   async minimal(){await sleep(3000);check('urls-only config loads',cur()===U('a'),cur());check('loading cleared',await loadingGone());await openS();await saveS();check('save works',cur()===U('a'),cur());},
  })[SC]();}catch(e){check('scenario threw',false,e.stack);}
  done(fails?1:0);
});
setTimeout(()=>{console.log('WATCHDOG ['+SC+']');global.__done=true;app.exit(3)},115000);
