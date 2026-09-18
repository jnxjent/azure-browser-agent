// Live scheduling test: reads schedules and prepares drafts, never approves or submits Add.
import assert from 'node:assert/strict';
const base=process.env.SCHEDULE_TEST_API ?? 'http://127.0.0.1:3001';
const threadId=process.env.SCHEDULE_TEST_THREAD ?? `schedule-smoke-${Date.now()}`;
const userId='schedule-smoke';
const headers={'content-type':'application/json','x-user-id':userId,'x-chat-thread-id':threadId,
  ...(process.env.AGENT_API_KEY ? {authorization:`Bearer ${process.env.AGENT_API_KEY}`} : {})};
async function turn(prompt) {
  const response=await fetch(`${base}/browser-agent/runs`,{method:'POST',headers,
    body:JSON.stringify({userId,threadId,site:'desknets',mode:'read',prompt})});
  let run=await response.json();
  assert.ok(response.ok,JSON.stringify(run));
  console.log(JSON.stringify({event:'started',id:run.id,threadId,prompt}));
  const deadline=Date.now()+600000;
  while(['queued','running'].includes(run.status)) {
    assert.ok(Date.now()<deadline,'run timed out');
    await new Promise(resolve=>setTimeout(resolve,3000));
    run=await (await fetch(`${base}/browser-agent/runs/${run.id}`,{headers})).json();
  }
  console.log(JSON.stringify({event:'finished',id:run.id,status:run.status,task:run.task,
    message:run.result?.assistantMessage,error:run.error,summary:run.result?.summary,
    candidates:run.result?.availability?.map(({start,end})=>({start,end})),approval:run.result?.approvalRequest ?? run.result?.manualActionRequest}));
  assert.notEqual(run.status,'failed');
  return run;
}
const first=process.argv.includes('--continue') ? null : await turn('髙田部長、鈴木清彦部長、私で最短で打ち合わせ可能な日程を挙げて');
if(process.argv.includes('--search-only')) process.exit(0);
if(first) assert.ok(first.result?.availability?.length>=4,'Expected at least four real candidates');
const selected=await turn('では、１で');
assert.equal(selected.status,'awaiting_approval');
for(let attempt=0;attempt<2;attempt++) {
  const response=await fetch(`${base}/browser-agent/runs/${selected.id}/handoff`,{headers});
  const result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  console.log(JSON.stringify({event:'handoff',attempt,url:result.handoffUrl,registered:result.registered}));
}
const changed=await turn('同じ時間と参加者で、アクトの別の会議室に変更して');
assert.ok(['awaiting_approval','awaiting_user_input'].includes(changed.status));
const changedProposal=changed.result.approvalRequest ?? changed.result.manualActionRequest;
assert.equal(changedProposal.start,selected.result.approvalRequest.start);
assert.notEqual(changedProposal.facilityId,selected.result.approvalRequest.facilityId);
const changedHandoff=await fetch(`${base}/browser-agent/runs/${changed.id}/handoff`,{headers});
assert.equal(changedHandoff.status,200);
await turn('最短の会議開始時間が過ぎたので、再度候補を挙げて');
