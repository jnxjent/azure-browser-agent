# Read-only authentication test using an isolated context, never the user's schedule tab.
$ErrorActionPreference='Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if($env:COMPUTERNAME -ne 'vm-abagent-t01'){throw 'Unexpected VM'}
$release='C:\BrowserAgent\releases\'+(Get-Content 'C:\BrowserAgent\shared\active-commit.txt').Trim()
$env:DESKNETS_CREDENTIAL_FILE='C:\BrowserAgent\shared\credentials\desknets.bin'
if(!(Test-Path $env:DESKNETS_CREDENTIAL_FILE)){Write-Output '{"credentialsRegistered":false,"liveAuthTest":"pending"}';exit 2}
$code=@'
const {chromium}=require(process.cwd()+'/node_modules/playwright');
const {pathToFileURL}=require('node:url');
(async()=>{
 const {loadDeskNetsCredentials}=await import(pathToFileURL(process.cwd()+'/services/browser-worker/dist/desknets-credentials.js'));
 const {DeskNetsAuthentication}=await import(pathToFileURL(process.cwd()+'/services/browser-worker/dist/desknets-auth.js'));
 const lease=await loadDeskNetsCredentials();
 if(!lease||lease.credentials.origin!=='https://desknets.midac.jp')throw new Error('Credential origin mismatch');
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
 const context=await browser.newContext();
 try {
  const page=await context.newPage();
  for(let attempt=0;attempt<2;attempt++){
   const auth=new DeskNetsAuthentication(page,lease,lease.credentials.origin,new AbortController().signal);
   try {
    await auth.attach();
    await page.goto(lease.credentials.origin+'/dneo/dneo.cgi?cmd=schindex#cmd=schweekgrp',{waitUntil:'domcontentloaded',timeout:30000});
    const recovered=await auth.recoverLogin();
    await page.getByText('\u6c0f\u540d/\u7d44\u7e54\u540d',{exact:true}).first().waitFor({state:'visible',timeout:15000});
    auth.assertHealthy();
    console.log(JSON.stringify({attempt:attempt+1,appRecovered:recovered,scheduleVisible:true,basicBlocked:await lease.blocked('basic'),appBlocked:await lease.blocked('app')}));
   }catch {
    console.log(JSON.stringify({attempt:attempt+1,basicBlocked:await lease.blocked('basic'),appBlocked:await lease.blocked('app'),loginShape:await page.evaluate(()=>({
     path:location.pathname,
     inputs:[...document.querySelectorAll('input')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({type:e.type,name:e.name,id:e.id})),
     forms:[...document.forms].map(f=>({method:f.method,path:new URL(f.action||location.href).pathname})),
     loginControls:[...document.querySelectorAll('button,a,input[type=submit]')].filter(e=>/\u30ed\u30b0\u30a4\u30f3|login/i.test(e.textContent||e.getAttribute('value')||'')).map(e=>({tag:e.tagName,id:e.id,role:e.getAttribute('role')}))
    })).catch(()=>null)}));
    throw new Error('Authentication verification failed');
   }finally{await auth.dispose();}
   await context.clearCookies();
  }
 }finally{await context.close();await browser.close();}
})().catch(()=>{console.log(JSON.stringify({liveAuthTest:'failed',manualReviewRequired:true}));process.exitCode=1});
'@
Push-Location $release
try {$code | & 'C:\BrowserAgent\runtime\node-v22.23.2-win-x64\node.exe' -;if($LASTEXITCODE -ne 0){throw 'Live authentication test failed; no credentials printed.'}}finally{Pop-Location}
