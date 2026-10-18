/** Isolated real-repository migration proof; invokes public CLIs without replacing checks. */
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
const [source,root]=process.argv.slice(2);
for(const file of execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],{cwd:source,encoding:"utf8"}).split("\0").filter(Boolean)) {
 if(file.endsWith("/"))continue;
 const from=path.join(source,file),to=path.join(root,file);if(!fs.existsSync(from)&&!fs.lstatSync(from).isSymbolicLink())continue;
 fs.mkdirSync(path.dirname(to),{recursive:true});
 if(fs.lstatSync(from).isSymbolicLink())fs.symlinkSync(fs.readlinkSync(from),to);else fs.copyFileSync(from,to);
}
fs.symlinkSync(path.join(source,"node_modules"),path.join(root,"node_modules"),"dir");
execFileSync("git",["init","-q",root]);
const run=(file,args=[])=>{const output=execFileSync(process.execPath,[path.join(source,file),...args],{cwd:root,encoding:"utf8",maxBuffer:4*1024*1024});process.stdout.write(output);};
const decisions=path.join(root,"migration-decisions.json");
fs.writeFileSync(decisions,JSON.stringify([{sourcePath:"agents/changelog-assistant.md",artifactKind:"agent",category:"C",compute:{requirement:"mechanical",mode:"floor",binding:"self"}}]));
run("plugins/dotbabel/bin/dotbabel-models.mjs",["migrate","--write","--decisions",decisions,"--batch","C","--repo-root",root,"--json"]);
run("plugins/dotbabel/bin/dotbabel-index.mjs",["--repo-root",root]);
run("plugins/dotbabel/bin/dotbabel-validate-skills.mjs",["--repo-root",root,"--update"]);
run("scripts/build-plugin.mjs",["--repo-root",root]);
run("plugins/dotbabel/bin/dotbabel-project-sync.mjs",["--repo",root,"--all"]);
for(const[file,args]of [["plugins/dotbabel/bin/dotbabel-index.mjs",["--repo-root",root,"--check"]],["plugins/dotbabel/bin/dotbabel-validate-skills.mjs",["--repo-root",root]],["scripts/build-plugin.mjs",["--repo-root",root,"--check"]],["plugins/dotbabel/bin/dotbabel-check-project-sync.mjs",["--repo",root,"--all"]]])run(file,args);
console.log("Migration batch passes all four actual repository checks.");
