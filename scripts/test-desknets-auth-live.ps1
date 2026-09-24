# Read-only authentication test using an isolated context, never the user's schedule tab.
$ErrorActionPreference='Stop'
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
    await page.getByText('氏名/組織名',{exact:true}).first().waitFor({state:'visible',timeout:15000});
    auth.assertHealthy();
    console.log(JSON.stringify({attempt:attempt+1,appRecovered:recovered,scheduleVisible:true,basicBlocked:await lease.blocked('basic'),appBlocked:await lease.blocked('app')}));
   }finally{await auth.dispose();}
   await context.clearCookies();
  }
 }finally{await context.close();await browser.close();}
})().catch(()=>{console.log(JSON.stringify({liveAuthTest:'failed',manualReviewRequired:true}));process.exitCode=1});
'@
Push-Location $release
try {$code | & 'C:\BrowserAgent\runtime\node-v22.23.2-win-x64\node.exe' -;if($LASTEXITCODE -ne 0){throw 'Live authentication test failed; no credentials printed.'}}finally{Pop-Location}
