import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { DeskNetsAuthentication, DeskNetsAuthenticationError } from "./desknets-auth.js";
import { validateCredentials, type CredentialLease } from "./desknets-credentials.js";
import { loadDeskNetsCredentials } from "./desknets-credentials.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture() {
  const stats = { basic: 0, login: 0, registrations: 0 };
  let mode = "normal";
  const server = createServer(async (req, res) => {
    if (req.headers.authorization) stats.basic++;
    if (req.headers.authorization !== `Basic ${Buffer.from("basic:basic-secret").toString("base64")}`) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }); res.end(); return;
    }
    if (req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      stats.login++;
      const form = new URLSearchParams(body);
      if (form.get("user") === "app" && form.get("password") === "app-secret") {
        res.writeHead(302, { Location: "/dneo.cgi?cmd=schindex", "Set-Cookie": "session=ok; Path=/" }); res.end(); return;
      }
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.headers.cookie?.includes("session=ok")) {
      res.end('<div>氏名/組織名</div><button>追加</button>'); return;
    }
    const control = mode === "native"
      ? '<a id="login-btn" class="jlogin-submit" href="#" onclick="event.preventDefault();this.closest(\'form\').requestSubmit()">ログイン</a><input type="submit" value="ログイン" style="position:absolute;left:-10000px">'
      : '<button>ログイン</button>';
    res.end(`<form method="post"><input type="text" name="user"><input type="password" name="password">${mode === "mfa" ? '<input autocomplete="one-time-code">' : ''}${control}</form>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const blocked = new Set<string>();
  const lease: CredentialLease = { credentials: { origin, basic: {username:"basic",password:"basic-secret"}, app: {username:"app",password:"app-secret"} },
    blocked: async k => blocked.has(k), block: async k => {blocked.add(k);}, clear: async k => {blocked.delete(k);} };
  return {origin, lease, stats, blocked, mode: (value:string) => {mode=value;}, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }};
}

test("BASIC and app login recover; a later cookie expiry can recover again", async () => {
  const f = await fixture();
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (let i=0;i<2;i++) {
      if (i===1) f.mode("native");
      const auth = new DeskNetsAuthentication(page,f.lease,f.origin,new AbortController().signal);
      try {
        await auth.attach();
        await page.goto(f.origin+"/dneo.cgi?cmd=schindex");
        assert.equal(await auth.recoverLogin(),true);
        auth.assertHealthy();
        assert.equal(await page.getByText("氏名/組織名").count(),1);
        assert.equal(f.blocked.size,0);
      } finally {await auth.dispose();}
      await context.clearCookies();
    }
    assert.equal(f.stats.login,2);
    assert.equal(f.stats.registrations,0);
  } finally {await browser.close();await f.close();}
});

test("wrong BASIC credentials are attempted once and locked across recovery instances", async () => {
  const f=await fixture(); f.lease.credentials.basic!.password="wrong-basic-secret";
  const browser=await chromium.launch({headless:true});
  try {
    for(let i=0;i<2;i++) {
      const context=await browser.newContext();const page=await context.newPage();
      const auth=new DeskNetsAuthentication(page,f.lease,f.origin,new AbortController().signal);
      try {await auth.attach();await page.goto(f.origin+"/dneo.cgi").catch(()=>{});assert.throws(()=>auth.assertHealthy(),DeskNetsAuthenticationError);}
      finally {await auth.dispose();await context.close();}
    }
    assert.equal(f.stats.basic,1);assert.equal(f.stats.login,0);
  } finally {await browser.close();await f.close();}
});

test("wrong app password is not retried and errors never contain credentials", async () => {
  const f=await fixture();f.lease.credentials.app!.password="wrong-app-secret";
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    for(let i=0;i<2;i++) {
      const auth=new DeskNetsAuthentication(page,f.lease,f.origin,new AbortController().signal);
      try {await auth.attach();await page.goto(f.origin+"/dneo.cgi");
        await assert.rejects(()=>auth.recoverLogin(),(error:unknown)=>error instanceof DeskNetsAuthenticationError && !error.message.includes("wrong-app-secret"));
      } finally {await auth.dispose();}
    }
    assert.equal(f.stats.login,1);
    assert.equal(await page.locator('input[type=password]').inputValue(),"");
  } finally {await browser.close();await f.close();}
});

test("foreign BASIC challenge receives no credentials",async()=>{
  const f=await fixture();const foreign=await fixture();const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();const auth=new DeskNetsAuthentication(page,f.lease,f.origin,new AbortController().signal);
    try {await auth.attach();await page.goto(foreign.origin+"/dneo.cgi").catch(()=>{});assert.equal(foreign.stats.basic,0);}finally{await auth.dispose();}
  }finally{await browser.close();await f.close();await foreign.close();}
});

test("MFA and cancellation require manual intervention without login submission",async()=>{
  const f=await fixture();f.mode("mfa");const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();const controller=new AbortController();
    const auth=new DeskNetsAuthentication(page,f.lease,f.origin,controller.signal);
    try {await auth.attach();await page.goto(f.origin+"/dneo.cgi");await assert.rejects(()=>auth.recoverLogin(),DeskNetsAuthenticationError);
      controller.abort();await assert.rejects(()=>auth.recoverLogin());assert.equal(f.stats.login,0);
    }finally{await auth.dispose();}
  }finally{await browser.close();await f.close();}
});

test("credential configuration only accepts an exact HTTPS origin",()=>{
  for(const origin of ['http://desk.example','https://desk.example/path','https://u:p@desk.example']) assert.throws(()=>validateCredentials({origin,basic:{username:'u',password:'p'}}));
  assert.equal(validateCredentials({origin:'https://desk.example',basic:{username:'u',password:'p'}}).origin,'https://desk.example');
});

test("DPAPI store survives reload, locks failures, and credential replacement resets the lock",{skip:process.platform!=="win32"},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'desknets-credential-test-'));
  const previous=process.env.DESKNETS_CREDENTIAL_FILE;
  process.env.DESKNETS_CREDENTIAL_FILE=join(directory,'test.bin');
  try {
    assert.equal(await loadDeskNetsCredentials(),undefined);
    const code="Add-Type -AssemblyName System.Security; $v='{"+ '"origin":"https://desk.example","basic":{"username":"test","password":"fake-only"}' +"}'; [IO.File]::WriteAllBytes($env:DESKNETS_CREDENTIAL_FILE,[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine))";
    const save=()=>promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true});
    await save();
    const lease=(await loadDeskNetsCredentials())!;
    assert.equal(lease.credentials.basic!.password,'fake-only');
    await lease.block('basic');
    assert.equal(await (await loadDeskNetsCredentials())!.blocked('basic'),true);
    await lease.clear('basic');
    assert.equal(await (await loadDeskNetsCredentials())!.blocked('basic'),false);
    await lease.block('basic');await save();
    assert.equal(await (await loadDeskNetsCredentials())!.blocked('basic'),false);
    await writeFile(process.env.DESKNETS_CREDENTIAL_FILE!,'corrupt-secret');
    await assert.rejects(()=>loadDeskNetsCredentials(),(e:unknown)=>e instanceof Error && !e.message.includes('corrupt-secret'));
  }finally{
    if(previous===undefined)delete process.env.DESKNETS_CREDENTIAL_FILE;else process.env.DESKNETS_CREDENTIAL_FILE=previous;
    await rm(directory,{recursive:true,force:true});
  }
});
