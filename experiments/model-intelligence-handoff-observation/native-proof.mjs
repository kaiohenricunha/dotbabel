/** Explicit metadata-only native proof. Reuses an already controlled Codex thread; executes no inference. */
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}from"node:fs";
import{join,resolve}from"node:path";
import{tmpdir}from"node:os";
import{execFileSync}from"node:child_process";
import{fileURLToPath}from"node:url";
import{observeTranscript}from"../../plugins/dotbabel/src/model-intelligence/observe/handoff.mjs";
import * as codex from"../../plugins/dotbabel/src/model-intelligence/sources/runtime/codex.mjs";
import * as claude from"../../plugins/dotbabel/src/model-intelligence/sources/runtime/claude.mjs";
import{createCodexRpcTransport}from"../../plugins/dotbabel/src/adaptive-session-routing/codex-rpc.mjs";
import{buildRecommendation}from"../../plugins/dotbabel/src/model-intelligence/recommend/index.mjs";
if(!process.argv.includes("--run-native")){console.error("Use --run-native --codex-proof <controlled managed-session proof JSON>.");process.exit(64);}
const at=process.argv.indexOf("--codex-proof"),source=resolve(fileURLToPath(new URL("../..",import.meta.url)));
assert(at>=0&&process.argv[at+1]);const bytes=readFileSync(process.argv[at+1]);assert(bytes.length<=8192);const controlled=JSON.parse(bytes);
assert.equal(controlled.originalInputsExactlyOnce,true);assert.equal(controlled.turns.length,2);
const root=mkdtempSync(join(tmpdir(),"mi-handoff-native-"));let rpc;
const report={additionalInferenceCalls:0};
try{
 execFileSync("git",["init","-q",root]);
 rpc=createCodexRpcTransport({cwd:root,timeoutMs:15000});
 await rpc.request("initialize",{clientInfo:{name:"dotbabel-handoff-observation-proof",version:"1.0.0"},capabilities:{experimentalApi:true}});rpc.sendNotification("initialized",{});
 const read=await rpc.request("thread/read",{threadId:controlled.threadId,includeTurns:false});assert.equal(read.thread.id,controlled.threadId);assert.equal(typeof read.thread.path,"string");
 let stream;const now=()=>new Date().toISOString();
 const observation=await observeTranscript("codex",read.thread.path,{now,adapters:[{...codex,observeStream(text,options){stream=text;return codex.observeStream(text,options);}}]});
 assert.equal(observation.status,"ok");assert.deepEqual(observation.evidence.axes,controlled.turns[1].effective.axes);assert.equal(observation.evidence.configurationBasis,"reconstructed");
 const expected=await codex.observe({stream,now:()=>observation.observedAt});assert.deepEqual(observation,expected);
 const extracted=JSON.parse(execFileSync("bash",[join(source,"plugins/dotbabel/scripts/handoff-extract.sh"),"meta","codex",read.thread.path],{encoding:"utf8",timeout:15000}));assert.equal(extracted.model,expected.evidence.axes.model);assert.equal(extracted.provider,expected.evidence.provider);
 const recommendation=buildRecommendation({resolverResult:{status:"unresolved",enforcement:{state:"unknown",basis:"none"},confidence:"low",diagnostics:[],explanation:[]},observation:observation.evidence});assert.deepEqual(recommendation.observation,expected.evidence);
 report.codex={status:"verified",source:"controlled native thread obtained through thread/read",model:extracted.model,provider:extracted.provider,configurationBasis:observation.evidence.configurationBasis,fieldSources:observation.evidence.fieldSources,modelMatchesCompletedNativeTurn:true,adapterConsumerAndRecommendationMatch:true};
 rpc.close();rpc=undefined;
 const plugin=join(root,"plugin");mkdirSync(join(plugin,".claude-plugin"),{recursive:true});mkdirSync(join(plugin,"hooks"));
 writeFileSync(join(plugin,".claude-plugin/plugin.json"),JSON.stringify({name:"dotbabel-handoff-observation-proof",version:"0.1.0"}));writeFileSync(join(plugin,"hooks/hooks.json"),JSON.stringify({modules:["./register.js"]}));
 writeFileSync(join(plugin,"hooks/register.js"),`export function register(on){on('session.start',async($,e,next)=>{await $.command.register({name:'handoff-observation-probe',description:'Read native session model without inference'});return next(e);});on('command.run',{command:'handoff-observation-probe'},async($)=>({text:JSON.stringify({model:await $.session.model()})}));on('turn.step',async function*($,e){return {turnId:e.turnId,index:e.index,answer:'Observation proof blocks inference.',toolUses:[],stopReason:'end_turn',usage:null};});}\n`);
 execFileSync("claude",["plugin","validate",plugin],{cwd:root,encoding:"utf8",timeout:15000});
 let output;
 try{output=execFileSync("claude",["-p","/handoff-observation-probe","--plugin-dir",plugin,"--no-session-persistence","--output-format","stream-json","--verbose","--tools",""],{cwd:root,encoding:"utf8",timeout:25000,maxBuffer:8*1024*1024});}catch(error){output=String(error.stdout??"");}
 const events=output.split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return{};}});
 const result=events.findLast(event=>event.type==="result");if(result){assert.equal(result.total_cost_usd,0);assert.deepEqual(result.modelUsage??{},{});assert.equal(result.duration_api_ms,0);}
 const file=join(root,"claude.jsonl");writeFileSync(file,output);const native=await observeTranscript("claude",file);const expectedClaude=await claude.observe({stream:output,now:()=>native.observedAt});
 if(native.status==="ok"){
  assert.deepEqual(native,expectedClaude);const extractedClaude=JSON.parse(execFileSync("bash",[join(source,"plugins/dotbabel/scripts/handoff-extract.sh"),"meta","claude",file],{encoding:"utf8",timeout:15000}));assert.equal(extractedClaude.model,native.evidence.axes.model);assert.equal(native.evidence.turnExecuted,false);
  report.claude={status:"verified",model:extractedClaude.model,turnExecuted:false,source:"actual native stream-json initialization; local metadata command",adapterAndConsumerMatch:true};
 }else report.claude={status:"unverified",diagnostic:native.diagnostic?.code,source:"native initialization did not expose a usable model; no inference attempted"};
 console.log(JSON.stringify(report,null,2));
}finally{rpc?.close();rmSync(root,{recursive:true,force:true});}
