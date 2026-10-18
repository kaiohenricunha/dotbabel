import {it,expect,vi,beforeEach}from"vitest";
import{writeFileSync,symlinkSync,mkdirSync}from"node:fs";
import{join}from"node:path";
import{makeTempDir}from"./fixtures/temp-dir.mjs";
import{observeTranscript}from"../src/model-intelligence/observe/handoff.mjs";
import{buildRecommendation}from"../src/model-intelligence/recommend/index.mjs";
import * as claude from"../src/model-intelligence/sources/runtime/claude.mjs";
import * as codex from"../src/model-intelligence/sources/runtime/codex.mjs";

const fsControl=vi.hoisted(()=>({opened:[],closed:[],readDone:false,afterStat:undefined,shortRead:false,noFollowUnsupported:false,realFstat:undefined}));
vi.mock("node:fs",async importOriginal=>{
 const fs=await importOriginal();fsControl.realFstat=fs.fstatSync;const flags={...fs.constants};Object.defineProperty(flags,"O_NOFOLLOW",{enumerable:true,get:()=>fsControl.noFollowUnsupported?undefined:fs.constants.O_NOFOLLOW});
 return {...fs,constants:flags,
  openSync(...args){const fd=fs.openSync(...args);fsControl.opened.push(fd);return fd;},
  readSync(...args){const size=fs.readSync(...args);fsControl.readDone=true;return size-(fsControl.shortRead?1:0);},
  fstatSync(fd){const stat=fs.fstatSync(fd);return fsControl.readDone&&fsControl.afterStat?{...stat,...fsControl.afterStat(stat),isFile:()=>stat.isFile()}:stat;},
  closeSync(fd){fsControl.closed.push(fd);return fs.closeSync(fd);}
 };
});
beforeEach(()=>{fsControl.opened=[];fsControl.closed=[];fsControl.readDone=false;fsControl.afterStat=undefined;fsControl.shortRead=false;fsControl.noFollowUnsupported=false;});

const now=()=>"2026-10-18T00:00:00.000Z";
const file=text=>{const target=join(makeTempDir("mi-handoff-"),"session.jsonl");writeFileSync(target,text);return target;};
const session=()=>JSON.stringify({type:"session_meta",payload:{model_provider:"openai",cli_version:"0.163.0"}})+"\n"+JSON.stringify({type:"turn_context",payload:{model:"fixture-model",effort:"high"}})+"\n";
it("the observation consumed by recommend equals the adapter observe() result for the same fixture",async()=>{
 const stream=JSON.stringify({type:"system",subtype:"init",model:"claude-fixture",claude_code_version:"2.1.302"})+"\n";
 for(const[runtime,adapter,text]of[["claude",claude,stream],["codex",codex,session()]]){const expected=await adapter.observe({stream:text,now,runCommand:()=>{throw Error("must not execute");},readFile:()=>{throw Error("must not read configuration");}});const actual=await observeTranscript(runtime,file(text),{now});expect(actual).toEqual(expected);const report=buildRecommendation({resolverResult:{status:"unresolved",enforcement:{state:"unknown",basis:"none"},confidence:"low",diagnostics:[],explanation:[]},observation:actual.evidence});expect(report.observation).toEqual(expected.evidence);}
});
it("keeps Codex provider independent from an absent model",async()=>{
 const result=await observeTranscript("codex",file('{"type":"session_meta","payload":{"model_provider":"openai"}}\n'),{now});expect(result.status).toBe("ok");expect(result.evidence.provider).toBe("openai");expect(result.evidence.axes).toEqual({});expect(result.evidence.configurationBasis).toBe("reconstructed");
});
it("reports requested Codex turn configuration as reconstructed rather than effective inference",async()=>{
 const result=await observeTranscript("codex",file(session()+'{"type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}\n'),{now});expect(result.evidence).toMatchObject({runtimeId:"codex",axes:{model:"fixture-model",reasoning:"high"},provider:"openai",configurationBasis:"reconstructed",turnExecuted:true,fieldSources:{"axes.model":"turn_context.model","axes.reasoning":"turn_context.effort",provider:"session_meta.model_provider"}});
});
it.each(["antigravity","opencode"])("reports missing observation support for %s without reading a file or executing a command",async runtime=>{
 expect(await observeTranscript(runtime,"/missing/transcript",{now})).toMatchObject({status:"unsupported",diagnostic:{code:"observation_unsupported"}});
});
it("bounds file reads and rejects symlinks, directories, missing files and oversized transcripts without echoing contents",async()=>{
 const directory=makeTempDir("mi-handoff-invalid-"),target=file("private prompt text"),link=join(directory,"link");symlinkSync(target,link);mkdirSync(join(directory,"folder"));
 for(const source of[link,join(directory,"folder"),join(directory,"missing"),file("x".repeat(8*1024*1024+1))]){const result=await observeTranscript("claude",source,{now});expect(result.status).toBe("unknown");expect(JSON.stringify(result)).not.toContain("private prompt text");}
});
it("keeps malformed and empty observations unknown without disclosing prompt text",async()=>{
 for(const stream of["", "not JSON private prompt text",'{"type":"user","message":"private prompt text"}\n']){const result=await observeTranscript("codex",file(stream),{now});expect(result.status).toBe("unknown");expect(JSON.stringify(result)).not.toContain("private prompt text");}
});
it("does not mix configuration from two concatenated Codex sessions",async()=>{
 const result=await observeTranscript("codex",file(session()+'{"type":"session_meta","payload":{"model_provider":"other-provider"}}\n'),{now});expect(result.evidence.axes).toEqual({});expect(result.evidence.provider).toBe("codex.other-provider");expect(result.evidence.turnExecuted).toBe(false);
});
it("keeps unverified adapter support distinct from unsupported support",async()=>{
 const observe=vi.fn();const adapters=[{descriptor:{id:"claude",kind:"runtime",capabilities:{observation:{support:"unverified"}}},observe}];expect(await observeTranscript("claude","/missing",{adapters,now})).toMatchObject({status:"unknown",diagnostic:{code:"observation_unverified"}});expect(observe).not.toHaveBeenCalled();
});
it("distinguishes an adapter failure from an unreadable transcript",async()=>{
 const adapters=[{descriptor:{id:"claude",kind:"runtime",capabilities:{observation:{support:"supported"}}},observeStream:async()=>{throw Error("private error text");}}];const result=await observeTranscript("claude",file("{}\n"),{adapters,now});expect(result).toMatchObject({status:"unknown",diagnostic:{code:"observation_failed"}});expect(JSON.stringify(result)).not.toContain("private error text");
});
it("rejects invalid UTF-8 without replacing bytes inside a reported model",async()=>{
 const target=file("");writeFileSync(target,Buffer.concat([Buffer.from('{"type":"system","subtype":"init","model":"m'),Buffer.from([255]),Buffer.from('"}\n')]));expect((await observeTranscript("claude",target,{now})).status).toBe("unknown");
});

it("never starts an adapter that lacks an explicit data-only observation entry point",async()=>{
 const observe=vi.fn();const adapters=[{descriptor:{id:"claude",kind:"runtime",capabilities:{observation:{support:"supported"}}},observe}];expect(await observeTranscript("claude","/missing",{adapters,now})).toMatchObject({status:"unknown",diagnostic:{code:"observation_stream_unavailable"}});expect(observe).not.toHaveBeenCalled();
});
it("keeps source versions and a default observation clock without inventing native axes",async()=>{
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
 try{const result=await observeTranscript("codex",file(session()));expect(result.observedAt).toBe(now());expect(result.evidence.runtimeVersion).toBe("0.163.0");expect(result.provenance.sourceVersion).toBe("0.163.0");}finally{vi.useRealTimers();}
});
it("accepts the exact UTF-8 file bound and refuses oversized adapter streams",async()=>{
 const prefix='{"type":"system","subtype":"init","model":"claude-fixture"}\n',stream=prefix+" ".repeat(8*1024*1024-Buffer.byteLength(prefix));expect((await observeTranscript("claude",file(stream),{now})).evidence.axes.model).toBe("claude-fixture");
 for(const adapter of[claude,codex])for(const value of[undefined,null,{},[],1,"x".repeat(8*1024*1024+1)]){const result=adapter.observeStream(value,{now});expect(result.status).toBe("unknown");expect(result.diagnostic.code).toBe("malformed_output");expect(result.diagnostic.message.length).toBeGreaterThan(0);}
});
it("observes only explicit metadata fields across malformed and incomplete native records",()=>{
 for(const prefix of["null\n","[]\n","7\n","not JSON\n"]){expect(codex.observeStream(prefix+session(),{now}).evidence.axes).toEqual({model:"fixture-model",reasoning:"high"});}
 for(const payload of[null,[],{}, {model:1,effort:false}]){const result=codex.observeStream(session()+JSON.stringify({type:"turn_context",payload})+"\n",{now});expect(result.evidence.axes).toEqual({});expect(result.evidence.provider).toBe("openai");expect(result.evidence.turnExecuted).toBe(false);}
 const result=codex.observeStream(session()+'{"type":"response_item","payload":{"type":"message","role":"user","content":"private prompt"}}\n',{now});expect(result.evidence.turnExecuted).toBe(false);expect(JSON.stringify(result)).not.toContain("private prompt");
 expect(codex.observeStream('{"type":"session_meta","payload":null}\n',{now})).toMatchObject({status:"unknown",diagnostic:{code:"insufficient_evidence"}});
});
it("reports an invalid runtime without reading a file or exposing its value",async()=>{
 const result=await observeTranscript("private-runtime-value","/missing",{now});expect(result).toMatchObject({status:"unknown",diagnostic:{code:"observation_runtime_invalid"}});expect(JSON.stringify(result)).not.toContain("private-runtime-value");
});

it.each(["size","mtimeMs","ctimeMs"])("refuses an observation when descriptor %s changes after reading",async field=>{
 fsControl.afterStat=stat=>({[field]:stat[field]+1});const result=await observeTranscript("codex",file(session()),{now});expect(result).toMatchObject({status:"unknown",diagnostic:{code:"observation_file_changed"}});expect(result.diagnostic.message.length).toBeGreaterThan(0);
});
it("refuses a short read rather than reporting a partial file as stable",async()=>{
 fsControl.shortRead=true;const result=await observeTranscript("codex",file(session()),{now});expect(result).toMatchObject({status:"unknown",diagnostic:{code:"observation_file_changed"}});
});
it("reports unsupported no-follow protection before opening a transcript",async()=>{
 const target=file(session());fsControl.opened=[];fsControl.noFollowUnsupported=true;const result=await observeTranscript("codex",target,{now});expect(result).toMatchObject({status:"unknown",diagnostic:{code:"observation_file_unsupported"}});expect(fsControl.opened).toEqual([]);
});
it("returns distinct file refusal diagnostics and releases every opened descriptor",async()=>{
 const directory=makeTempDir("mi-handoff-codes-");
 for(const target of[directory,file("x".repeat(8*1024*1024+1))]){const result=await observeTranscript("codex",target,{now});expect(result).toMatchObject({status:"unknown",diagnostic:{code:"observation_file_invalid"}});expect(result.diagnostic.message.length).toBeGreaterThan(0);}
 await observeTranscript("codex",file(session()),{now});expect(fsControl.opened.length).toBeGreaterThan(0);
 for(const fd of fsControl.opened){expect(fsControl.closed).toContain(fd);expect(()=>fsControl.realFstat(fd)).toThrow();}
});
it("rejects invalid encoding before calling the data-only adapter",async()=>{
 const target=file("");writeFileSync(target,Buffer.from([255]));const observeStream=vi.fn(()=>({status:"ok"}));const result=await observeTranscript("claude",target,{adapters:[{descriptor:claude.descriptor,observeStream}],now});expect(result).toMatchObject({status:"unknown",diagnostic:{code:"observation_file_unavailable"}});expect(result.diagnostic.message.length).toBeGreaterThan(0);expect(observeStream).not.toHaveBeenCalled();
});
it.each(["unsupported",undefined])("never dispatches an unsupported observation adapter: %s",async support=>{
 const observeStream=vi.fn(),descriptor={id:"claude",kind:"runtime",capabilities:{...(support===undefined?{}:{observation:{support}})}};const result=await observeTranscript("claude","/missing",{adapters:[{descriptor,observeStream}],now});expect(result).toMatchObject({status:"unsupported",diagnostic:{code:"observation_unsupported"}});expect(result.diagnostic.message.length).toBeGreaterThan(0);expect(observeStream).not.toHaveBeenCalled();
});
it("selects runtime adapters without dispatching a knowledge source with the same id",async()=>{
 const observeStream=vi.fn();const result=await observeTranscript("claude","/missing",{adapters:[{descriptor:{...claude.descriptor,kind:"knowledge"},observeStream}],now});expect(result.status).toBe("unsupported");expect(observeStream).not.toHaveBeenCalled();
});
it("retains the precise reconstruction inputs and handles an exact-size Codex stream",()=>{
 const prefix=session();const result=codex.observeStream(prefix+" ".repeat(8*1024*1024-Buffer.byteLength(prefix)),{now});expect(result.status).toBe("ok");expect(result.evidence.reconstructedFrom).toEqual(["axes.model","axes.reasoning","provider"]);
 for(const record of[{type:"not-response",payload:{type:"message",role:"assistant"}},{type:"response_item",payload:{type:"not-message",role:"assistant"}},{type:"response_item"}])expect(codex.observeStream(prefix+JSON.stringify(record)+"\n",{now}).evidence.turnExecuted).toBe(false);
 for(const[stream,code]of[["\n \n","empty_output"],["not JSON","malformed_output"],["null","malformed_output"],["{}\n","insufficient_evidence"]])expect(codex.observeStream(stream,{now})).toMatchObject({status:"unknown",diagnostic:{code}});
});
it("never starts a native process when an explicitly supplied observation stream has the wrong type",async()=>{
 for(const adapter of[claude,codex])for(const stream of[undefined,null,1,{}]){const runCommand=vi.fn(()=>{throw Error("must not run");});const result=await adapter.observe({stream,now,runCommand,readFile:()=>{throw Error("must not read configuration");}});expect(result.status).toBe("unknown");expect(result.diagnostic.code).toBe("malformed_output");expect(runCommand).not.toHaveBeenCalled();}
});
