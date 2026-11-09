"""Read-only audit of this review snapshot. No live provider or account access."""
from pathlib import Path
import hashlib,json,re,sys

ROOT=Path(__file__).resolve().parent.parent
SKIP={'.git','node_modules','dist','__pycache__'}
def files():
 return [p for p in ROOT.rglob('*') if p.is_file() and not any(x in SKIP for x in p.relative_to(ROOT).parts)]
issues=[]
scanned=files()
manifest=json.loads((ROOT/'provenance/source-manifest.json').read_text())
for entry in manifest['files']:
 p=ROOT/entry['path']
 if not p.exists():issues.append({'kind':'MISSING_SOURCE','path':entry['path']});continue
 if hashlib.sha256(p.read_bytes()).hexdigest()!=entry['snapshot_sha256']:
  issues.append({'kind':'SOURCE_HASH_MISMATCH','path':entry['path']})

patterns={
 'PERSONAL_PATH':r'/Users/[A-Za-z0-9_.-]+/',
 'PRIVATE_NOTION_ID':r'(?i)[a-f0-9]{4}0?faf1[a-f0-9-]{18,}',
 'PRIVATE_CHAT_URL':r'https://chatgpt\.com/(?:c|plugins)/[A-Za-z0-9_-]+',
 'PRIVATE_MCP_URL':r'https?://[^\s\x22\x27<>`]+/mcp/[A-Za-z0-9_-]{32,}',
 'ANTHROPIC_KEY':r'sk-ant-[A-Za-z0-9_-]{30,}',
 'OPENAI_KEY':r'sk-(?:proj-)?[A-Za-z0-9_-]{40,}',
 'GITHUB_TOKEN':r'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})',
}
for p in scanned:
 rel=p.relative_to(ROOT).as_posix()
 if p.is_symlink():issues.append({'kind':'SYMLINK','path':rel});continue
 if p.name.startswith('.env') and p.name!='.env.example':issues.append({'kind':'ENV_FILE','path':rel})
 if p.suffix.lower() in {'.zip','.dump','.sqlite','.db','.pem','.key','.jpeg','.jpg','.png'}:
  issues.append({'kind':'PRIVATE_OR_UNREVIEWED_BINARY','path':rel})
 try:text=p.read_text()
 except UnicodeDecodeError:issues.append({'kind':'UNREVIEWED_BINARY','path':rel});continue
 for kind,pattern in patterns.items():
  if re.search(pattern,text):issues.append({'kind':kind,'path':rel})
 if p.suffix=='.md':
  clean=re.sub(r'```[\s\S]*?```','',text)
  for m in re.finditer(r'(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)',clean):
   ref=m[1].strip('<>')
   if re.match(r'^(?:https?://|mailto:|#)',ref):continue
   path,_,fragment=ref.partition('#')
   target=(p.parent/path).resolve()
   if not target.is_relative_to(ROOT):issues.append({'kind':'LINK_OUTSIDE_REPO','path':rel});continue
   if not target.exists():issues.append({'kind':'BROKEN_LINK','path':rel,'target':path});continue
   if fragment.startswith('L') and re.fullmatch(r'L\d+',fragment) and int(fragment[1:])>len(target.read_text().splitlines()):issues.append({'kind':'INVALID_LINE_ANCHOR','path':rel,'target':path})

example=json.loads((ROOT/'examples/work-dossier.json').read_text())
if not (example['state']['last_run_ref']==example['run']['logical_ref'] and example['run']['mutation_refs']==[example['ledger']['logical_ref']] and example['ledger']['run_ref']==example['run']['logical_ref'] and example['ledger']['target_ref']==example['work']['account_ref']):issues.append({'kind':'INCONSISTENT_EXAMPLE'})
observed=json.loads((ROOT/'notion/observed/accounts-schema.json').read_text())
if observed.get('rows_read')!=0 or len(observed.get('properties',{}))!=19:issues.append({'kind':'SCHEMA_OBSERVATION_SCOPE'})
for p in (ROOT/'evidence').glob('*.json'):
 d=json.loads(p.read_text())
 if d.get('kind')=='ANONYMIZED_RECEIPT_DERIVATIVE/1' and d.get('anonymization',{}).get('source_signatures_validate_this_derivative') is not False:issues.append({'kind':'ANONYMIZED_SIGNATURE_CLAIM','path':p.relative_to(ROOT).as_posix()})
print(json.dumps({'kind':'DOSSIER_READ_ONLY_AUDIT/1','files_scanned':len(scanned),'source_files_checked':len(manifest['files']),'issues':issues,'passed':not issues},ensure_ascii=False,indent=2))
sys.exit(1 if issues else 0)
