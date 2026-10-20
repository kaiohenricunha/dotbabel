import os
# PACKET_ROUND=2 freezes the amendment-02 control draw into new files; round 1 keeps its original names.
ROUND=os.environ.get('PACKET_ROUND','1')
NAMES={'1':{'out':'annotation-inputs','control':'control-results.json','amendment':'contract-amendment-01.json','index':'packet-index.json','exclusions':'exclusions.json','reuse':'reuse-observations.json','report':'report.json','enriched':True},
       '2':{'out':'annotation-inputs-round2','control':'control-results-02.json','amendment':'contract-amendment-02.json','index':'packet-index-round2.json','exclusions':'exclusions-round2.json','reuse':'reuse-observations-round2.json','report':'report-round2.json','enriched':False}}[ROUND]
import base64
import collections
import datetime
import hashlib
import json
import pathlib
import re

root=pathlib.Path(os.environ['COHORT_ROOT'])
inputs=root/NAMES['out']
def digest(raw): return hashlib.sha256(raw).hexdigest()
def read(path): return json.loads(path.read_text())
def when(value): return datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
contract=read(root/'collection-contract.json')
results=read(root/'collection-results.json')
packets=[json.loads(x) for x in (inputs/'packets.jsonl').read_text().splitlines()]
freeze=read(inputs/'freeze.json')
assert len(results)==len(read(root/'candidate-runs.json'))
assert len({p['id'] for p in packets})==len(packets)
assert len({(p['repo'],p['pr']) for p in packets})==len(packets)
control=read(root/NAMES['control'])
assert control['amendment_sha256']==digest((root/NAMES['amendment']).read_bytes())
ready=([{**r,'selection_stratum':'enriched'} for r in results if r['status']=='evidence-ready-unlabeled'][:contract['screening']['max_annotation_cases']] if NAMES['enriched'] else [])+control['chosen']
ready.sort(key=lambda r: digest(r['selected_failure']['id'].encode()))
index={r['id']:r for r in read(root/NAMES['index'])}
assert all(index[r['selected_failure']['id']]['selection_stratum']==r['selection_stratum'] for r in ready)
assert all('selection_stratum' not in p and 'acquisition_hints' not in p for p in packets), 'stratum or hints leaked into packets'
repairs={}
repair={'completed':0}
assert len(ready)==len(packets)==freeze['packets']
assert [r['selected_failure']['id'] for r in ready]==[p['id'] for p in packets]
inventory={f['path']:f for f in freeze['files']}
actual={str(p.relative_to(inputs)) for p in inputs.rglob('*') if p.is_file() and p.name!='freeze.json'}
assert actual==set(inventory)
for name,f in inventory.items():
    raw=(inputs/name).read_bytes()
    assert len(raw)==f['bytes'] and digest(raw)==f['sha256']
assert read(inputs/'rubric.json')['actions'].keys()=={'retry','fix','ask-owner','unknown'}
sources_verified=0
source_bytes=0
trace_count=0
for result in results:
    trace=root/result['trace_path']
    file=trace/'manifest.json'
    if not file.exists(): continue
    trace_count+=1
    manifest=read(file)
    for s in manifest['sources']:
        if not s.get('path'): continue
        raw=(trace/s['path']).read_bytes()
        assert len(raw)==s['bytes'] and digest(raw)==s['sha256']
        if not s.get('redacted'): assert digest(raw)==s['source_sha256']
        sources_verified+=1
        source_bytes+=len(raw)

excerpt_count=0
logs_verified=0
redacted_logs=0
contexts_verified=0
counter_counts=collections.Counter()
for result,packet in zip(ready,packets):
    assert packet['label'] is None and packet['label_source'] is None and packet['human_review_status']=='pending'
    assert f'{packet["repo"]}#{packet["pr"]}'.lower() not in contract['excluded_repository_prs']
    trace=root/result['trace_path']
    for context in result['context']:
        raw=(root/context['path']).read_bytes()
        assert digest(raw)==context['sha256']
    if result['index'] in repairs:
        repaired=repairs[result['index']]
        assert repaired['id']==packet['id']
        assert repaired['previous_source_path']==result['context'][0]['path']
        assert repaired['previous_retained_sha256']==result['context'][0]['sha256']
        assert digest((root/repaired['path']).read_bytes())==repaired['sha256']
    manifest=read(trace/'manifest.json')
    assert manifest['traces'][0]['complete'] and manifest['traces'][0]['issues']==[]
    by_endpoint={s['endpoint']:s for s in manifest['sources'] if s.get('ok')}
    def fetch(endpoint):
        s=by_endpoint[endpoint]
        return read(trace/s['path'])
    prefix='repos/'+packet['repo']
    repository=fetch(prefix)
    assert repository['private'] is False and repository['full_name']==packet['repo']
    run=fetch(prefix+f'/actions/runs/{packet["run_id"]}')
    assert run['id']==packet['run_id'] and run['head_sha']==packet['execution_sha']
    assert contract['window_start']<=run['created_at']<=contract['window_end']
    anchor=[a for a in run.get('pull_requests',[]) if a['number']==packet['pr'] and a.get('url')==f'https://api.github.com/{prefix}/pulls/{packet["pr"]}']
    if not run.get('pull_requests'):
        # Same rule as the collector's recoveredAnchor (public-actions.mjs:59-73), from the archived pulls?head= pages only.
        rows=[x for e,src in by_endpoint.items() if e.startswith(prefix+'/pulls?state=all&head=') for x in read(trace/src['path'])]
        anchor=[a for a in rows if a['number']==packet['pr'] and a['url']==f'https://api.github.com/{prefix}/pulls/{packet["pr"]}' and
                a['base']['repo']['full_name']==packet['repo'] and a['head']['sha']==run['head_sha'] and a['head']['ref']==run['head_branch'] and
                a['head']['repo']['full_name']==run['head_repository']['full_name']]
    assert len(anchor)==1 and anchor[0]['head']['sha']==packet['pr_head_sha']
    history=[]
    counter=0
    actual_target=None
    for attempt in range(1,packet['native_attempt']+1):
        endpoint=prefix+f'/actions/runs/{packet["run_id"]}/attempts/{attempt}'
        state=fetch(endpoint)
        assert state['id']==run['id'] and state['run_attempt']==attempt and state['head_sha']==run['head_sha']
        jobs=[]
        total=None
        for page in range(1,manifest['config']['max_pages']+1):
            doc=fetch(endpoint+f'/jobs?per_page={manifest["config"]["page_size"]}&page={page}')
            if total is None: total=doc['total_count']
            assert doc['total_count']==total
            jobs+=doc['jobs']
            if len(jobs)>=total: break
        assert total is not None and len(jobs)==total
        assert len({j['id'] for j in jobs})==len(jobs) and len({j['name'] for j in jobs})==len(jobs)
        for j in jobs:
            assert j['run_id']==run['id'] and j['run_attempt']==attempt and j['head_sha']==run['head_sha']
            if j['name']!=packet['job_name']: continue
            assert when(j['completed_at'])<=when(packet['decision_time'])
            if j['conclusion']=='success': counter=0
            elif j['conclusion'] in ('failure','timed_out'): counter+=1
            entry={'native_attempt':attempt,'job_id':j['id'],'conclusion':j['conclusion'],'completed_at':j['completed_at']}
            history.append(entry)
            if j['id']==packet['job_id']: actual_target=j
    assert actual_target and actual_target['conclusion']==packet['job_conclusion']
    assert actual_target['completed_at']==packet['decision_time']
    assert counter==packet['within_run_consecutive_failures'] and counter in (1,2)
    actual_history=[{k:v for k,v in h.items() if k!='failure_log'} for h in packet['history']]
    assert actual_history==history
    for left_index,left in enumerate(packet['history']):
        if 'failure_log' not in left: continue
        for right in packet['history'][left_index+1:]:
            if 'failure_log' not in right: continue
            assert not (left['job_id']!=right['job_id'] and left['completed_at']==right['completed_at'] and left['failure_log']['sha256']==right['failure_log']['sha256']), 'Duplicated execution observation requires quarantine'
    counter_counts[str(counter)]+=1
    for h in packet['history']:
        assert when(h['completed_at'])<=when(packet['decision_time'])
        if 'failure_log' not in h: continue
        evidence=h['failure_log']
        source=by_endpoint[prefix+f'/actions/jobs/{h["job_id"]}/logs']
        raw=(inputs/evidence['path']).read_bytes()
        assert raw==(trace/source['path']).read_bytes()
        assert digest(raw)==source['sha256']==evidence['sha256']
        assert evidence['source_sha256']==source['source_sha256']
        assert evidence['redacted']==source['redacted']
        logs_verified+=1
        redacted_logs+=bool(source['redacted'])
    target_log=packet['failure_log']
    assert target_log['path']==packet['history'][-1]['failure_log']['path']
    lines=(inputs/target_log['path']).read_bytes().decode().splitlines()
    assert len(lines)==target_log['line_count']
    for excerpt in target_log['excerpts']:
        a,b=excerpt['line_start'],excerpt['line_end']
        assert 1<=a<=b<=len(lines)
        assert excerpt['text']=='\n'.join(lines[a-1:b])
        excerpt_count+=1
    source=result['context'][1]
    doc=read(root/source['path'])
    original=base64.b64decode(doc['content'])
    assert hashlib.sha1(b'blob '+str(len(original)).encode()+b'\0'+original).hexdigest()==source['git_blob_sha']
    assert digest(original)==source['decoded_source_sha256']
    assert doc['path']==packet['workflow_path']
    workflow=next(c for c in packet['source_context'] if c['type']=='workflow')
    assert (inputs/workflow['path']).read_bytes()==(root/source['decoded_path']).read_bytes()
    assert digest((inputs/workflow['path']).read_bytes())==workflow['sha256']==source['decoded_retained_sha256']
    changes_ref=next(c for c in packet['source_context'] if c['type']=='execution_commit_changes')
    changes=read(inputs/changes_ref['path'])
    commit_source=repairs.get(result['index'],result['context'][0])
    commit=read(root/commit_source['path'])
    assert changes['execution_sha']==packet['execution_sha']==commit['sha']
    assert changes['files']==[{'filename':f['filename'],'status':f['status'],'patch':f.get('patch')} for f in commit.get('files',[])]
    assert digest((inputs/changes_ref['path']).read_bytes())==changes_ref['sha256']
    run_ref=next(c for c in packet['source_context'] if c['type']=='run_context')
    run_file=read(inputs/run_ref['path'])
    assert digest((inputs/run_ref['path']).read_bytes())==run_ref['sha256']
    assert {k:v for k,v in run_file.items() if k!='source_endpoints'}==packet['run_context']
    attempt_prefix=f"repos/{packet['repo']}/actions/runs/{packet['run_id']}/attempts/{packet['native_attempt']}"
    assert all(e==attempt_prefix or e.startswith(attempt_prefix+'/jobs?') for e in run_file['source_endpoints']), 'run context read a later attempt'
    contexts_verified+=1
    # Whitelisted inputs contain no raw latest-run snapshot or future attempt source.
    assert all(not c['path'].startswith(('traces/','discovery/','context/')) for c in packet['source_context'])

assert dict(counter_counts)==freeze['counter_counts']
for prior in contract['previous_cohorts'].values():
    assert digest((pathlib.Path(prior['root'])/'annotation-inputs/packets.jsonl').read_bytes())==prior['packets_sha256']
groups=collections.Counter(r['diagnostic_group_hint'] for r in read(root/NAMES['index']))
report={
 'scope':'Read-only acquisition of a separate enriched supplemental cohort of native GitHub Actions failures. Final run outcomes and log signatures guide acquisition only, never annotation. No population prevalence or accuracy claim.',
 'window':{'start':contract['window_start'],'end':contract['window_end'],'field':'Workflow run created_at. Evidence retrieval occurs later; each packet has its own failed-job decision cutoff.'},
 'collection':{'repositories_queried':len(contract['repositories']),'frozen_candidate_prs':len(results),'traces_archived':trace_count,'excluded_candidates':len(results)-len(packets),'evidence_ready_cases':len(packets),'distinct_prs':len(packets),'distinct_repositories':len({p['repo'] for p in packets}),'case_counter_counts':dict(counter_counts),'annotation_cap':contract['screening']['max_annotation_cases'],'cap_reached':len(packets)>=contract['screening']['max_annotation_cases']},
 'verification':{'status':'pass','retained_source_files_hashed':sources_verified,'retained_source_bytes':source_bytes,'case_identities_and_native_histories_verified':len(packets),'failure_logs_verified_in_inputs':logs_verified,'redacted_log_files':redacted_logs,'original_raw_log_hash_policy':'Retained bytes are hash-verified. Where redaction occurred, the original-fetch SHA is preserved separately and is not asserted to equal retained bytes.','workflow_git_blobs_and_execution_contexts_verified':contexts_verified,'exact_excerpt_ranges_verified':excerpt_count,'annotation_input_files_hashed':len(inventory),'prior_pilot_packet_unchanged':True,'excluded_prior_pilot_and_contacted_prs_present':0,'later_native_attempts_in_annotation_inputs':False},
 'review_and_evaluation':{'labels_created':0,'human_review_status':'pending','ai_annotation_status':'not_run','primary_labeled_and_answered_cases':0,'required_primary_cases':100,'required_distinct_prs':30,'required_per_action':{'retry':20,'fix':20,'ask-owner':20},'actual_action_class_counts':'Unmeasured until independent annotation.','class_floor_met':False,'model_replay':False,'adoption':'Not evaluated; the original locked conductor experiment is a separate domain.'},
 'independence':{'one_primary_case_per_pr':True,'matching_diagnostic_hint_groups':sum(n>1 for n in groups.values()),'cases_in_matching_hint_groups':sum(n for n in groups.values() if n>1),'unique_causal_incident_count':'Unverified. Distinct PRs may share one cause, and generic errors may falsely match. Incident grouping requires review.','split_rule':'Keep related PRs, diagnostic groups, and underlying incidents together; no train/evaluation split has been assigned.'},
 'context_export':{'structured_string_redaction_before_json_serialization':True,'source_context_at_execution_sha':True},
 'reuse':{'source':'reuse-observations.json','scope':'Local research acquisition only. Current repository licenses are recorded as observations; a blanket redistribution license for all log contents is not asserted.','published_or_redistributed':False},
 'inputs':{'directory':str(inputs),'packets':str(inputs/'packets.jsonl'),'rubric':str(inputs/'rubric.json'),'freeze':str(inputs/'freeze.json'),'instructions':str(inputs/'review-instructions.txt')},
 'remaining':['Blind independent action annotation with exact field/log citations.','Incident-level deduplication and review of matching diagnostic groups.','Verification of final known-label counts and action quotas; unsupported cases remain unknown.'],
 'actions':{'external_messages_sent':0,'ci_runs_triggered':0,'repository_code_changed':False,'production_settings_changed':False}
}
(root/NAMES['report']).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'status':'pass','evidence_ready_cases':len(packets),'distinct_prs':len(packets),'distinct_repositories':report['collection']['distinct_repositories'],'counter_counts':dict(counter_counts),'retained_source_files_verified':sources_verified,'input_logs_verified':logs_verified,'pinned_contexts_verified':contexts_verified,'excerpt_ranges_verified':excerpt_count,'primary_labeled_cases':0,'report':str(root/NAMES['report'])},indent=2))
