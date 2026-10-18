/** Explicit controlled native proof. Uses a new read-only ephemeral Git project and two primary turns. */
if (!process.argv.includes("--live")) { console.error("Use --live to execute two controlled native model turns."); process.exit(64); }
import { execFileSync } from "node:child_process";
import { createCodexRpcTransport } from "../../plugins/dotbabel/src/adaptive-session-routing/codex-rpc.mjs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prepareRoute } from "../../plugins/dotbabel/src/adaptive-session-routing/prepare.mjs";
import { createCodexTurnRouter } from "../../plugins/dotbabel/src/adaptive-session-routing/codex.mjs";
import * as codex from "../../plugins/dotbabel/src/model-intelligence/sources/runtime/codex.mjs";
import { buildCatalog } from "../../plugins/dotbabel/src/model-intelligence/catalog/index.mjs";
import { loadPolicyLayers, mergePolicy } from "../../plugins/dotbabel/src/model-intelligence/policy/index.mjs";
const cwd = await mkdtemp(join(tmpdir(), "dotbabel-real-codex-routing-"));
execFileSync("git",["init","-q"],{cwd});
await writeFile(join(cwd,".dotbabel.json"),JSON.stringify({model_intelligence:{enabled:true,adaptive_routing:{enabled:true}}}));
const discovery = await codex.discover({ cwd });
if(discovery.status!=="ok") throw new Error("native discovery unavailable");
const catalog = buildCatalog([{result:discovery,freshness:"fresh",refresh:"idle"}]);
const rpc=createCodexRpcTransport({cwd,timeoutMs:15000});
const completions=new Map();const waiters=new Map();const observedInputs=[];const reroutes=[];const notificationCounts={};let router;let stage="initialize";
const hash=text=>createHash("sha256").update(text).digest("hex");
rpc.onNotification(msg=>{
 notificationCounts[msg.method]=(notificationCounts[msg.method]??0)+1;
 router?.notify(msg);
 if(msg.method==="hook/completed"&&msg.params?.run?.eventName==="stop"&&["blocked","failed","stopped"].includes(msg.params.run.status)) {
  console.error(JSON.stringify({stage:"native-stop-hook",status:msg.params.run.status}));
  if(msg.params.turnId)rpc.request("turn/interrupt",{threadId:msg.params.threadId,turnId:msg.params.turnId}).catch(()=>{});
 }
 if(msg.method==="turn/moderationMetadata"&&notificationCounts[msg.method]>8&&msg.params?.turnId)rpc.request("turn/interrupt",{threadId:msg.params.threadId,turnId:msg.params.turnId}).catch(()=>{});
 if(msg.method==="model/rerouted")reroutes.push(msg.params);
 if(msg.method==="item/completed"&&msg.params?.item?.type==="userMessage")observedInputs.push({turnId:msg.params.turnId,content:msg.params.item.content});
 if(msg.method==="turn/completed"){const t=msg.params.turn;completions.set(t.id,t);const waiter=waiters.get(t.id);if(waiter){waiters.delete(t.id);clearTimeout(waiter.timer);waiter.resolve(t);}}
 if(msg.method==="error")console.error(JSON.stringify({stage,notification:"error",code:msg.params?.error?.codexErrorInfo,willRetry:msg.params?.willRetry}));
});
const call=async(method,params)=>{stage=method;console.error(JSON.stringify({stage}));return rpc.request(method,params);};
const complete=id=>completions.has(id)?Promise.resolve(completions.get(id)):new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(id);reject(Object.assign(new Error("native completion deadline"),{code:"native_completion_timeout"}));},90000);waiters.set(id,{resolve,reject,timer});});
const proof={turns:[],reroutes:[],extraClassifierInferenceCalls:0,approvalHandler:"no automatic tool approval",transcriptReplayed:false};
try{
 const init=await call("initialize",{clientInfo:{name:"dotbabel-routing-real-proof",version:"0.1.0"},capabilities:{experimentalApi:true}});rpc.sendNotification("initialized",{});
 proof.runtime=init.userAgent;
 const listing=await call("model/list",{includeHidden:true});
 const ids=new Set(listing.data.filter(m=>m.hidden===false).map(m=>m.model));
 const localCatalog={...catalog,runtimes:catalog.runtimes.map(r=>({...r,models:r.models.filter(m=>ids.has(m.model))}))};
 const started=await call("thread/start",{cwd,ephemeral:true,sandbox:"read-only",approvalPolicy:"on-request",baseInstructions:"Answer the user's controlled test prompt. Do not use tools. Keep the response short."});
 if(!Array.isArray(started.thread.turns)||started.thread.turns.length!==0)throw new Error("new thread is not verified cold");
 const threadId=started.thread.id;proof.threadId=threadId;proof.initial={model:started.model??started.thread.model,reasoning:started.reasoningEffort??started.thread.reasoningEffort};
 const capability={support:"supported",axes:{model:"supported",reasoning:"supported"}};
 const manual={model:{source:"inherited"},reasoning:{source:"inherited"}};
 const dependencies={loadResolverInput:async()=>{const {shipped,user,project}=loadPolicyLayers({repoRoot:cwd});return {policy:mergePolicy({shipped,user,project}),catalog:localCatalog,target:{runtimeId:"codex",artifactKind:"workflow"},runtimeContract:codex.descriptor};}};
 router=createCodexTurnRouter({threadId,repoRoot:cwd,current:{axes:proof.initial,turnExecuted:false},manual,runtimeCapability:capability,request:call,dependencies});
 let seenAxes=proof.initial;
 const prompts=["Format the sample JSON as two-space indented text. Do not use tools. Return only JSON: {a:1}","Investigate this authentication race and give one sentence of verification guidance without using tools. Two requests read a missing token before either writes it."];
 for(let i=0;i<prompts.length;i++){
  const params={threadId,input:[{type:"text",text:prompts[i],text_elements:[]}],model:null,effort:null};
  const dry=await prepareRoute({repoRoot:cwd,prompt:prompts[i],current:{axes:seenAxes,turnExecuted:i===0?false:true},manual,runtimeCapability:capability},dependencies);
  if(dry.status!=="proposed")throw new Error("preflight did not propose: "+dry.diagnostics?.map(x=>x.code).join(","));
  console.error(JSON.stringify({stage:"preflight",index:i,status:dry.status,changes:dry.changes}));
  if(i===0&&!dry.changes.model)throw new Error("preflight cannot demonstrate an automatic model change");
  const before=JSON.stringify(params);const result=await router.submit("proof-"+i,params);
  if(result.status!=="accepted")throw new Error("routing did not accept: "+result.status+":"+(result.decision?.diagnostics?.map(d=>d.code).join(",")??"unknown"));
  const turn=await complete(result.accepted.turnId);
  if(turn.status!=="completed")throw new Error("native turn did not complete: "+turn.status);
  const read=await call("thread/read",{threadId,includeTurns:false});
  const axes={model:read.thread.model,reasoning:read.thread.reasoningEffort};
  proof.turns.push({index:i,turnId:turn.id,promptSha256:hash(prompts[i]),status:turn.status,decision:result.decision.status,requested:result.requested,selected:result.decision.configuration?.axes,nativeObserved:axes,observationSource:"thread/read after turn/completed",inputUnchanged:before===JSON.stringify(params),effectiveAtAcknowledgement:result.effective.state});
  router.updateState({current:{axes,turnExecuted:true}});seenAxes=axes;
 }
 proof.reroutes=reroutes.map(r=>({turnId:r.turnId,fromModel:r.fromModel,toModel:r.toModel,reason:r.reason}));
 proof.observedUserMessages=observedInputs.map(item=>({turnId:item.turnId,textSha256:item.content.filter(x=>x.type==="text").map(x=>hash(x.text))}));
 proof.configurationsDiffer=JSON.stringify(proof.turns[0].nativeObserved)!==JSON.stringify(proof.turns[1].nativeObserved);
 proof.exactOriginalMessages=prompts.every((p,i)=>observedInputs.filter(x=>x.turnId===proof.turns[i].turnId).length===1&&observedInputs.find(x=>x.turnId===proof.turns[i].turnId).content.filter(x=>x.type==="text").map(x=>x.text).join("\n")===p);
 proof.notificationCounts=notificationCounts;proof.transportDiagnostics=rpc.diagnostics;
 if(!proof.configurationsDiffer||!proof.exactOriginalMessages||proof.turns.some(t=>t.selected.model!==t.nativeObserved.model||t.selected.reasoning!==t.nativeObserved.reasoning))throw new Error("real routing assertions did not pass");
 console.log(JSON.stringify(proof,null,2));
}catch(e){console.log(JSON.stringify({...proof,code:"real_runtime_proof_failed",message:e.message,stage,notificationCounts,transportDiagnostics:rpc.diagnostics},null,2));process.exitCode=1;}finally{rpc.close();for(const w of waiters.values())clearTimeout(w.timer);}
