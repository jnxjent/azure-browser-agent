import { randomUUID } from "node:crypto";
import type { Locator, Page, Request } from "playwright";

/** Hidden listings for other tabs must never participate in participant lookup. */
export function participantResultsTable(dialog: Locator): Locator {
  // Keep strict matching: if two visible tables remain, do not guess with first().
  return dialog.locator(".co-sel-search.co-sel-chooser-items .co-sel-list-scroll table.co-sel-table-list:visible");
}

export async function participantResultsBaseline(table: Locator): Promise<string> {
  // Before the first search the results may not be visible yet. Read immediately
  // rather than waiting for a table that only appears after submitting the form.
  return table.evaluateAll((tables) => {
    if (tables.length > 1) throw new Error("Multiple visible participant result tables.");
    return tables[0]?.innerHTML ?? "";
  });
}

/** A missing table is not proof of an empty search. Require a fresh rendered
 * result or an explicit empty response; never reuse the preceding person's rows.
 */
export async function searchParticipantResults(dialog:Locator,page:Page,name:string,timeoutMs=8_000):Promise<"results"|"empty"> {
  const token=randomUUID(), deadline=Date.now()+timeoutMs;
  let cancelled=false,finished=false,failed=false;
  const requests=new Set<Request>();
  const onRequest=(request:Request)=>{
    if(!["xhr","fetch"].includes(request.resourceType()))return;
    try {
      if(new URL(request.url()).origin!==new URL(page.url()).origin)return;
      const input=decodeURIComponent(`${request.url()} ${request.postData()??""}`.replace(/\+/g," "));
      if(input.includes(name))requests.add(request);
    }catch{ /* An unrelated or undecodable request cannot complete this search. */ }
  };
  const onFinished=async(request:Request)=>{
    if(!requests.has(request))return;
    try { const response=await request.response(); if(!response?.ok())failed=true; else finished=true; }
    catch { failed=true; }
  };
  const onFailed=(request:Request)=>{if(requests.has(request))failed=true;};
  let timer:ReturnType<typeof setTimeout>|undefined;
  const unavailable=()=>new Error(`${name}さんの検索結果を確認できませんでした。時間をおいて再度お試しください。`);
  try {
    return await Promise.race([
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(unavailable());},timeoutMs);}),
      (async()=>{
        await dialog.evaluateAll((dialogs,token)=>{
          if(dialogs.length!==1)throw Error("Participant dialog unavailable.");
          const root=dialogs[0]!, section=root.querySelector(".co-sel-search.co-sel-chooser-items");
          if(!section)throw Error("Participant search section unavailable.");
          const state={changes:0,contentChanges:0,observer:null as MutationObserver|null};
          state.observer=new MutationObserver(changes=>{
            if(changes.some(change=>{
              const target=change.target instanceof Element?change.target:change.target.parentElement;
              return target && (target===section || target.closest(".co-sel-list-scroll") || Array.from(change.addedNodes).some(node=>node instanceof Element && (node.matches(".co-sel-list-scroll") || node.querySelector(".co-sel-list-scroll"))));
            })) {
              state.changes++;
              if(changes.some(change=>{
                const target=change.target instanceof Element?change.target:change.target.parentElement;
                return change.type!=="attributes" && (target?.closest("table.co-sel-table-list") || Array.from(change.addedNodes).some(node=>node instanceof Element && (node.matches("table.co-sel-table-list")||node.querySelector("table.co-sel-table-list"))));
              }))state.contentChanges++;
            }
          });
          state.observer.observe(section,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["style","hidden","class"]});
          (window as any)[token]=state;
        },token);
        if(cancelled)throw unavailable();
        page.on("request",onRequest);page.on("requestfinished",onFinished);page.on("requestfailed",onFailed);
        await dialog.locator('input[name="name"]:visible').first().press("Enter",{timeout:Math.max(1,deadline-Date.now())});
        let last="",stableSince=Date.now();
        while(!cancelled && Date.now()<deadline) {
          if(failed)throw unavailable();
          const state=await dialog.evaluateAll((dialogs,token)=>{
            if(dialogs.length!==1)throw Error("Participant dialog unavailable.");
            const root=dialogs[0]!, section=root.querySelector(".co-sel-search.co-sel-chooser-items");
            if(!section)throw Error("Participant search section unavailable.");
            const visible=(node:Element)=>!!(node as HTMLElement).getClientRects().length&&getComputedStyle(node).visibility!=="hidden";
            const tables=Array.from(section.querySelectorAll(".co-sel-list-scroll table.co-sel-table-list")).filter(visible);
            if(tables.length>1)throw Error("Multiple visible participant result tables.");
            return {changes:(window as any)[token]?.changes??0,contentChanges:(window as any)[token]?.contentChanges??0,html:tables[0]?.innerHTML??"",rows:tables[0]?.querySelectorAll("span.co-sel-name").length??0,
              empty:Array.from(section.querySelectorAll("*" )).some(node=>visible(node)&&node.children.length===0&&/該当.*(?:ありません|いません)|見つかりません|検索結果.*0件|no results/i.test(node.textContent??""))};
          },token);
          const current=JSON.stringify(state);
          if(current!==last){last=current;stableSince=Date.now();}
          if(state.changes>0 && Date.now()-stableSince>=150 && (!requests.size||finished)) {
            if(state.rows>0 && state.contentChanges>0)return "results" as const;
            if(state.empty || finished)return "empty" as const;
          }
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        throw unavailable();
      })(),
    ]);
  } catch(error) {
    if(error instanceof Error && error.message.startsWith(`${name}さん`))throw error;
    throw new Error(`${name}さんの検索結果を確認できませんでした。時間をおいて再度お試しください。`,{cause:error});
  } finally {
    cancelled=true;if(timer)clearTimeout(timer);
    page.off("request",onRequest);page.off("requestfinished",onFinished);page.off("requestfailed",onFailed);
    // Do not let diagnostics/cleanup introduce another unbounded locator wait.
    void page.evaluate(token=>{const state=(window as any)[token];state?.observer?.disconnect();delete (window as any)[token];},token).catch(()=>{});
  }
}
