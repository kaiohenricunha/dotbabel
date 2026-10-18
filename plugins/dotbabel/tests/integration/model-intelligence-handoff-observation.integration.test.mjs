import{it,expect}from"vitest";
import{execFileSync}from"node:child_process";
it.skipIf(!process.env.DOTBABEL_CODEX_CONTROLLED_PROOF)("installed-runtime handoff models equal adapter observations without new inference",()=>{
 const output=execFileSync(process.execPath,["experiments/model-intelligence-handoff-observation/native-proof.mjs","--run-native","--codex-proof",process.env.DOTBABEL_CODEX_CONTROLLED_PROOF],{encoding:"utf8",timeout:60000});const report=JSON.parse(output);expect(report.additionalInferenceCalls).toBe(0);expect(report.codex.status).toBe("verified");expect(report.codex.adapterConsumerAndRecommendationMatch).toBe(true);expect(report.claude.status).toBe("verified");expect(report.claude.turnExecuted).toBe(false);
},65000);
