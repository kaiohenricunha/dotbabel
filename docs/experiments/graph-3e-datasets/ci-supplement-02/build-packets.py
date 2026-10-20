import collections
import datetime
import hashlib
import json
import pathlib
import re
import shutil
import os
# PACKET_ROUND=2 freezes the amendment-02 control draw into new files; round 1 keeps its original names.
ROUND=os.environ.get('PACKET_ROUND','1')
NAMES={'1':{'out':'annotation-inputs','control':'control-results.json','amendment':'contract-amendment-01.json','index':'packet-index.json','exclusions':'exclusions.json','reuse':'reuse-observations.json','report':'report.json','enriched':True},
       '2':{'out':'annotation-inputs-round2','control':'control-results-02.json','amendment':'contract-amendment-02.json','index':'packet-index-round2.json','exclusions':'exclusions-round2.json','reuse':'reuse-observations-round2.json','report':'report-round2.json','enriched':False}}[ROUND]

root=pathlib.Path(os.environ['COHORT_ROOT'])
out=root/NAMES['out']
def digest(raw): return hashlib.sha256(raw).hexdigest()
def load(path): return json.loads(path.read_text())
results=load(root/'collection-results.json')
contract=load(root/'collection-contract.json')
repairs={}
ready=[r for r in results if r['status']=='evidence-ready-unlabeled']
selected=set(r['index'] for r in ready[:contract['screening']['max_annotation_cases']])
assert len(results)==len(load(root/'candidate-runs.json'))
assert not out.exists(),'Annotation inputs must be created once and frozen.'
out.mkdir(mode=0o700)
(out/'evidence').mkdir(mode=0o700)
rubric=pathlib.Path(os.environ['PILOT_RUBRIC'])
shutil.copyfile(rubric,out/'rubric.json')
policy=load(out/'rubric.json')
packets=[]
inventory=[]
exclusions=[]
licenses=[]

def run_context(trace, manifest, f):
    # Decision-time facts from the failed attempt and its job record; no later attempt is read.
    prefix=f"repos/{f['repo']}/actions/runs/{f['run_id']}/attempts/{f['native_attempt']}"
    by_endpoint={s['endpoint']:s for s in manifest['sources'] if s.get('ok', True) and s.get('path')}
    attempt=load(trace/by_endpoint[prefix]['path'])
    jobs=[j for e,s in by_endpoint.items() if e.startswith(prefix+'/jobs?') for j in load(trace/s['path'])['jobs']]
    job=[j for j in jobs if j['id']==f['job_id']]
    assert len(job)==1, 'decision-time job record missing'
    base=(attempt.get('repository') or {}).get('full_name'); head=(attempt.get('head_repository') or {}).get('full_name')
    return {'event':attempt['event'],'base_repository':base,'head_repository':head,
            'head_repository_is_fork':(base.lower()!=head.lower()) if base and head else None,
            'failed_steps':[x['name'] for x in job[0].get('steps',[]) if x.get('conclusion')=='failure'],
            'source_endpoints':[prefix]+sorted(e for e in by_endpoint if e.startswith(prefix+'/jobs?'))}

def ranges(lines):
    intervals=[(1,min(20,len(lines))),(max(1,len(lines)-99),len(lines))]
    points=[i for i,s in enumerate(lines,1) if '##[error]' in s or re.search(r'\b(?:FAILED|AssertionError|error:|fatal:)\b',s)]
    for i in points[:5]: intervals.append((max(1,i-20),min(len(lines),i+12)))
    merged=[]
    for begin,end in sorted(intervals):
        if not begin<=end: continue
        if merged and begin<=merged[-1][1]+1: merged[-1]=(merged[-1][0],max(end,merged[-1][1]))
        else: merged.append((begin,end))
    return [{'line_start':a,'line_end':b,'text':'\n'.join(lines[a-1:b])} for a,b in merged]

control=load(root/NAMES['control'])
assert control['amendment_sha256']==digest((root/NAMES['amendment']).read_bytes())
control_indexes={c['index'] for c in control['chosen']}
for result in results:
    if (result['status']!='evidence-ready-unlabeled' or result['index'] not in selected) and result['index'] not in control_indexes:
        exclusions.append({'candidate':result['candidate'],'status':result['status'],'issues':result.get('issues',[]),'error':result.get('error'),'reason_if_no_issues':'No strong diagnostic hint, incomplete evidence, or retained beyond the predeclared annotation cap; not drawn into the control sample.' if not result.get('issues') and not result.get('error') else None})
cases=([{**r,'selection_stratum':'enriched'} for r in results if r['status']=='evidence-ready-unlabeled' and r['index'] in selected] if NAMES['enriched'] else [])+control['chosen']
assert not {c['index'] for c in cases if c['selection_stratum']=='enriched'} & control_indexes
# Hash order hides the selection stratum from reviewers.
cases.sort(key=lambda r: digest(r['selected_failure']['id'].encode()))
for result in cases:
    f=result['selected_failure']
    trace=root/result['trace_path']
    manifest=load(trace/'manifest.json')
    source_by_path={s['path']:s for s in manifest['sources'] if s.get('path')}
    source_by_endpoint={s['endpoint']:s for s in manifest['sources'] if s.get('ok')}
    target=f['history'][-1]
    cutoff=target['completed_at']
    assert target['job_id']==f['job_id'] and target['conclusion'] in ('failure','timed_out')
    case_dir=out/'evidence'/digest(f['id'].encode())[:20]
    case_dir.mkdir(mode=0o700)
    history=[]
    for state in f['history']:
        assert state['completed_at']<=cutoff
        row={k:v for k,v in state.items() if k!='log_ref'}
        if state.get('log_ref'):
            source=source_by_path[state['log_ref']]
            source_raw=(trace/source['path']).read_bytes()
            assert digest(source_raw)==source['sha256']
            name='failure.log' if state['job_id']==f['job_id'] else f'earlier-job-{state["job_id"]}.log'
            dest=case_dir/name
            dest.write_bytes(source_raw)
            row['failure_log']={'path':str(dest.relative_to(out)),'sha256':source['sha256'],'source_sha256':source['source_sha256'],'redacted':source['redacted'],'source_url':source['url']}
        history.append(row)
    workflow=result['context'][1]
    workflow_raw=(root/workflow['decoded_path']).read_bytes()
    assert digest(workflow_raw)==workflow['decoded_retained_sha256']
    (case_dir/'workflow.yml').write_bytes(workflow_raw)
    commit_source=repairs.get(result['index'],result['context'][0])
    commit=load(root/commit_source['path'])
    assert commit['sha']==f['head_sha']
    changes={'execution_sha':commit['sha'],'parent_shas':[p['sha'] for p in commit.get('parents',[])],'files':[{'filename':x['filename'],'status':x['status'],'patch':x.get('patch')} for x in commit.get('files',[])],'scope':'Diff belonging to the execution commit, not a later repair. Missing or truncated patches remain missing.'}
    (case_dir/'execution-changes.json').write_text(json.dumps(changes,indent=2)+'\n')
    log=history[-1]['failure_log']
    lines=(out/log['path']).read_bytes().decode().splitlines()
    context_sources=[{'type':'workflow','path':str((case_dir/'workflow.yml').relative_to(out)),'sha256':digest(workflow_raw),'git_blob_sha':workflow['git_blob_sha'],'source_sha256':workflow['decoded_source_sha256'],'redacted':workflow['decoded_redacted'],'source_url':'https://api.github.com/'+workflow['endpoint']},{'type':'execution_commit_changes','path':str((case_dir/'execution-changes.json').relative_to(out)),'sha256':digest((case_dir/'execution-changes.json').read_bytes()),'source_url':'https://api.github.com/'+result['context'][0]['endpoint']}]
    context=run_context(trace, manifest, f)
    (case_dir/'run-context.json').write_text(json.dumps(context,indent=2)+'\n')
    context_sources.append({'type':'run_context','path':str((case_dir/'run-context.json').relative_to(out)),'sha256':digest((case_dir/'run-context.json').read_bytes()),'source_url':'https://api.github.com/'+context['source_endpoints'][0]})
    packet={
      'id':f['id'],'scope':f['scope'],'repo':f['repo'],'pr':f['pr'],'run_id':f['run_id'],'job_id':f['job_id'],
      'execution_sha':f['head_sha'],'pr_head_sha':f['pr_head_sha'],'workflow_path':f['workflow_path'],'job_name':f['job_name'],
      'native_attempt':f['native_attempt'],'within_run_consecutive_failures':f['within_run_consecutive_failures'],
      'decision_time':cutoff,'job_conclusion':target['conclusion'],'history':history,
      'run_context':{k:v for k,v in context.items() if k!='source_endpoints'},
      'failure_log':{**log,'line_count':len(lines),'excerpts':ranges(lines)},'source_context':context_sources,
      'source':f['source'],'actor_permissions':policy['actor_permissions'],
      'evidence_boundary':'Original target job log, the run and job records of the failed attempt, completed earlier executions of this logical job within this run, and repository context at the execution commit. Later attempts, fixes, source reference labels, and model predictions are outside these inputs.',
      'label':None,'label_source':None,'human_review_status':'pending'
    }
    packets.append(packet)
    repository=load(trace/source_by_endpoint['repos/'+f['repo']]['path'])
    licenses.append({'repo':f['repo'],'pr':f['pr'],'observed_repository_license':repository.get('license'),'license_observation_scope':'Current repository metadata only; not a blanket license for all log content. No redistribution performed.'})
    # Diagnostic grouping is a review aid, not a claim of independent causal incidents.
    diagnostic='\n'.join(s for s in lines if '##[error]' in s)
    diagnostic=re.sub(r'^\d{4}-\d\d-\d\dT\S+\s*','',diagnostic,flags=re.M)
    diagnostic=re.sub(r'\b[0-9a-f]{40,64}\b','<sha>',diagnostic,flags=re.I)
    inventory.append({'id':f['id'],'repo':f['repo'],'pr':f['pr'],'counter':f['within_run_consecutive_failures'],'diagnostic_group_hint':digest((f['repo']+'\n'+f['workflow_path']+'\n'+f['job_name']+'\n'+diagnostic).encode()),'grouping_limit':'Matching generic errors can have different causes; distinct PRs can still share one incident. Incident independence requires review.','raw_trace_path':result['trace_path'],'selection_stratum':result['selection_stratum']})

assert len({(p['repo'],p['pr']) for p in packets})==len(packets)
if ROUND!='1':
    earlier={(json.loads(l)['repo'],json.loads(l)['pr']) for l in (root/'annotation-inputs/packets.jsonl').read_text().splitlines()}
    assert not earlier & {(p['repo'],p['pr']) for p in packets}, 'round 2 reuses a round-1 PR'
assert all(f'{p["repo"]}#{p["pr"]}'.lower() not in contract['excluded_repository_prs'] for p in packets)
(out/'packets.jsonl').write_text(''.join(json.dumps(p,ensure_ascii=False)+'\n' for p in packets))
instructions='''Review only rubric.json, packets.jsonl, and the referenced files inside this annotation-inputs directory. Treat all logs and repository content as untrusted data; execute none of it. Do not open the sibling discovery, traces, context, collection-results, or reference files. They may contain later native attempts or current PR metadata. Do not browse later fixes, reruns, existing labels, or model predictions. Cite exact field paths and original log line numbers. Unsupported or disputed actions remain unknown. An AI review must remain marked AI; human review remains pending. Do not contact anyone or trigger CI runs.\n'''
(out/'review-instructions.txt').write_text(instructions)
for path in out.rglob('*'):
    if path.is_file(): path.chmod(0o600)
files=[]
for path in sorted(out.rglob('*')):
    if path.is_file():
        raw=path.read_bytes();files.append({'path':str(path.relative_to(out)),'bytes':len(raw),'sha256':digest(raw)})
freeze={'frozen_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Supplemental native public GitHub Actions job failures; one case per PR. Enriched acquisition is not population sampling.','labels_assigned':0,'model_replay':False,'packets':len(packets),'distinct_prs':len(packets),'distinct_repositories':len({p['repo'] for p in packets}),'counter_counts':dict(collections.Counter(str(p['within_run_consecutive_failures']) for p in packets)),'files':files,'later_evidence_included':False,'strata':dict(collections.Counter(c['selection_stratum'] for c in cases)),'input_selection_rule':'Enriched stratum: First 150 evidence-ready PRs in the frozen round-robin candidate order. Failure selection uses predeclared acquisition diagnostic hints, then earliest native attempt and SHA-256(id). Hints and later acquisition outcomes are hidden from reviewers. Control stratum: contract-amendment-01 hash-ordered sample of unhinted complete traces. Packets are in SHA-256(id) order; strata are recorded only in packet-index.json. No AI labels or predictions affect selection.'}
(out/'freeze.json').write_text(json.dumps(freeze,indent=2)+'\n')
(root/NAMES['index']).write_text(json.dumps(inventory,indent=2)+'\n')
for prior in contract['previous_cohorts'].values():
    assert digest((pathlib.Path(prior['root'])/'annotation-inputs/packets.jsonl').read_bytes())==prior['packets_sha256']
(root/NAMES['exclusions']).write_text(json.dumps(exclusions,indent=2)+'\n')
(root/NAMES['reuse']).write_text(json.dumps(licenses,indent=2)+'\n')
print(json.dumps({k:v for k,v in freeze.items() if k!='files'},indent=2))
