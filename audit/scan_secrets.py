"""Run Gitleaks with redacted output; classify only exact reviewed code lines.

The default detector set remains enabled. Changed lines, other files, other rule
IDs and unreviewed findings fail the review gate. No live provider is contacted.
"""
from pathlib import Path
import argparse,hashlib,json,shutil,subprocess,tempfile

ROOT=Path(__file__).resolve().parent.parent
FINDINGS_EXIT_CODE=42

def classify(finding,line,entries):
 if finding.get('StartLine',1)!=finding.get('EndLine',1):return 'REQUIRES_REVIEW'
 digest=hashlib.sha256(line.encode()).hexdigest()
 return 'NON_SECRET_CODE_IDENTIFIER' if any(e['path']==finding['File'] and e['rule_id']==finding['RuleID'] and e['line_sha256']==digest for e in entries) else 'REQUIRES_REVIEW'

def scan_passed(exit_code,report_valid,finding_count,unreviewed_count):
 if not report_valid or unreviewed_count:return False
 if exit_code==0:return finding_count==0
 if exit_code==FINDINGS_EXIT_CODE:return finding_count>0
 return False

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--history',action='store_true');parser.add_argument('--output',default='verification/secret-scan.json');args=parser.parse_args()
 binary=shutil.which('gitleaks')
 if not binary:raise SystemExit('Gitleaks is required for this optional local verification.')
 entries=json.loads((ROOT/'audit/nonsecret-identifiers.json').read_text())['entries']
 with tempfile.TemporaryDirectory(prefix='review-secret-scan-')as directory:
  tmp=Path(directory);raw=tmp/'redacted-report.json'
  if args.history:
   mode=['git'];target=ROOT
  else:
   target=tmp/'tracked-copy';target.mkdir()
   names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=ROOT,text=True).splitlines()
   for name in set(names):
    p=ROOT/name
    if not p.is_file():continue
    out=target/name;out.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,out)
   mode=['dir']
  cmd=[binary,*mode,'--exit-code',str(FINDINGS_EXIT_CODE),'--redact=100','--ignore-gitleaks-allow','--report-format','json','--report-path',str(raw),'--no-banner','--no-color',str(target)]
  run=subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True)
  try:
   findings=json.loads(raw.read_text())
   report_valid=isinstance(findings,list)
  except (OSError,json.JSONDecodeError):
   findings=[];report_valid=False
  if not report_valid:findings=[]
  classified=[]
  for item in findings:
   name=Path(item['File'])
   if name.is_absolute():name=name.relative_to(target)
   item['File']=name.as_posix()
   if args.history:
    text=subprocess.check_output(['git','show',item['Commit']+':'+item['File']],cwd=ROOT,text=True)
   else:text=(ROOT/name).read_text()
   line=text.splitlines()[item['StartLine']-1]
   classified.append({'path':item['File'],'rule_id':item['RuleID'],'line':item['StartLine'],'classification':classify(item,line,entries)})
  unknown=sum(x['classification']=='REQUIRES_REVIEW'for x in classified)
  report={'kind':'STANDARD_SECRET_SCAN/1','scanner':subprocess.check_output([binary,'version'],text=True).strip(),'scope':'reachable_git_history'if args.history else'tracked_and_untracked_review_files','default_detectors_enabled':True,'inline_allow_comments_ignored':True,'findings_exit_code':FINDINGS_EXIT_CODE,'raw_scanner_exit_code':run.returncode,'valid_report_received':report_valid,'raw_findings':len(classified),'classified_nonsecret':len(classified)-unknown,'unreviewed_findings':unknown,'findings':classified,'passed':scan_passed(run.returncode,report_valid,len(classified),unknown),'limits':['Exact reviewed code identifiers remain visible in the raw finding count.','This is not a GitGuardian engine scan or a guarantee that no secret exists.']}
  output=ROOT/args.output;output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+'\n')
  print(json.dumps({k:v for k,v in report.items()if k!='findings'}))
  raise SystemExit(0 if report['passed'] else 1)

if __name__=='__main__':main()
