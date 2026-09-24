import type { Page, CDPSession } from "playwright";
import type { CredentialLease } from "./desknets-credentials.js";

export class DeskNetsAuthenticationError extends Error {
  constructor(message = "DeskNet'sの再認証が必要です。VMの専用Edgeで認証するか、保存した認証情報を更新してください。") { super(message); this.name = "DeskNetsAuthenticationError"; }
}
export async function isLoginPage(page: Page): Promise<boolean> {
  return await page.locator('input[type="password"]:visible').count() > 0;
}
export function isHttpAuthError(error: unknown): boolean {
  return error instanceof Error && /ERR_(?:INVALID|MISSING)_AUTH_CREDENTIALS/.test(error.message);
}

/** Attaches only for a worker operation; never changes the user's Edge profile. */
export class DeskNetsAuthentication {
  private session: CDPSession | undefined;
  private httpFailed = false;
  private attempts = new Set<string>();
  private appAttempted = false;
  private pending = new Set<Promise<unknown>>();
  constructor(private page: Page, private lease: CredentialLease | undefined, private origin: string, private signal: AbortSignal) {}

  async attach(): Promise<void> {
    if (!this.lease?.credentials.basic) return;
    if (this.lease.credentials.origin !== this.origin) throw new DeskNetsAuthenticationError("DeskNet's認証情報の接続先が一致しません。設定を確認してください。");
    const session = await this.page.context().newCDPSession(this.page);
    this.session = session;
    const track = (promise: Promise<unknown>) => {
      this.pending.add(promise);
      void promise.catch(() => { this.httpFailed = true; }).finally(() => this.pending.delete(promise));
    };
    session.on("Fetch.requestPaused", event => {
      track((async () => {
        if (this.attempts.has(event.requestId) && event.responseStatusCode !== undefined && event.responseStatusCode >= 200 && event.responseStatusCode < 400) {
          await this.lease!.clear("basic");
        }
        await session.send("Fetch.continueRequest", { requestId: event.requestId });
      })());
    });
    session.on("Fetch.authRequired", event => {
      track((async () => {
        const challenge = event.authChallenge;
        const permitted = !this.signal.aborted && challenge.source === "Server" && challenge.scheme.toLowerCase() === "basic" && new URL(event.request.url).origin === this.origin && new URL(challenge.origin).origin === this.origin;
        if (!permitted) {
          await session.send("Fetch.continueWithAuth", { requestId: event.requestId, authChallengeResponse: { response: "CancelAuth" } });
          return;
        }
        if (this.attempts.has(event.requestId) || await this.lease!.blocked("basic")) {
          this.httpFailed = true;
          await session.send("Fetch.continueWithAuth", { requestId: event.requestId, authChallengeResponse: { response: "CancelAuth" } });
          return;
        }
        // Persist before sending: crashes/restarts cannot repeatedly submit bad credentials.
        await this.lease!.block("basic");
        this.attempts.add(event.requestId);
        await session.send("Fetch.continueWithAuth", { requestId: event.requestId, authChallengeResponse: { response: "ProvideCredentials", ...this.lease!.credentials.basic! } });
      })());
    });
    await session.send("Fetch.enable", { handleAuthRequests: true, patterns: [{urlPattern:"*",requestStage:"Request"},{urlPattern:"*",requestStage:"Response"}] });
  }

  async recoverLogin(): Promise<boolean> {
    this.signal.throwIfAborted();
    if (this.httpFailed) throw new DeskNetsAuthenticationError("DeskNet's入口のBASIC認証に失敗しました。認証情報を更新してください。");
    if (!await isLoginPage(this.page)) return false;
    const pair = this.lease?.credentials.app;
    if (!pair || this.appAttempted || this.lease!.credentials.origin !== new URL(this.page.url()).origin || await this.lease!.blocked("app")) throw new DeskNetsAuthenticationError();
    // Only a simple, unambiguous login form. MFA/password changes/select-user forms remain manual.
    const password = this.page.locator('input[type="password"]:visible');
    const username = this.page.locator('input[type="text"]:visible, input[type="email"]:visible, input:not([type]):visible');
    // Native DeskNet's puts an auxiliary submit input far offscreen. The visible
    // anchor invokes its own AJAX form handler; do not force-click the auxiliary input.
    const nativeLogin = this.page.locator("#login-btn.jlogin-submit:visible");
    const login = await nativeLogin.count() === 1 ? nativeLogin : this.page.getByRole("button", { name: /^ログイン$|^Login$|^Log in$/i });
    if (await password.count() !== 1 || await username.count() !== 1 || await login.count() !== 1 || await this.page.locator('input[autocomplete="one-time-code"]:visible').count() > 0) throw new DeskNetsAuthenticationError();
    const safeForm = await password.evaluate(input => {
      const form = (input as HTMLInputElement).form;
      return form !== null && form.method.toLowerCase() === "post" && new URL(form.action || location.href).origin === location.origin;
    });
    const safeButton = await login.evaluate(element => {
      const target = element.getAttribute("formaction");
      const method = element.getAttribute("formmethod");
      return (!target || new URL(target, location.href).origin === location.origin) && (!method || method.toLowerCase() === "post");
    });
    if (!safeForm || !safeButton) throw new DeskNetsAuthenticationError();
    const schedule = new URL(this.page.url());
    this.appAttempted = true;
    await this.lease!.block("app");
    try {
      this.signal.throwIfAborted();
      await username.fill(pair.username, { timeout: 5000 });
      await password.fill(pair.password, { timeout: 5000 });
      this.signal.throwIfAborted();
      await login.click({ timeout: 10_000 });
      await password.waitFor({ state: "hidden", timeout: 10_000 });
      this.signal.throwIfAborted();
      if (new URL(this.page.url()).origin !== this.origin) throw new DeskNetsAuthenticationError();
      schedule.search = "?cmd=schindex";
      schedule.hash = "cmd=schweekgrp";
      await this.page.goto(schedule.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await this.page.getByText("氏名/組織名", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
      await this.lease!.clear("app");
      return true;
    } catch {
      // Do not expose Playwright call logs (which can contain filled values).
      throw new DeskNetsAuthenticationError();
    } finally {
      if (await isLoginPage(this.page).catch(() => false)) {
        await password.fill("", { timeout: 1000 }).catch(() => {});
        await username.fill("", { timeout: 1000 }).catch(() => {});
      }
    }
  }

  assertHealthy(): void { if (this.httpFailed) throw new DeskNetsAuthenticationError("DeskNet's入口のBASIC認証に失敗しました。認証情報を更新してください。"); }
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await this.session?.detach().catch(() => {});
  }
}
