"""Extract the pinned Mastodon Rails route declarations without booting Rails.
Only the declarative DSL used by config/routes/api.rb is supported; fail on an
unrecognized route declaration so updates require reviewing the extractor.
"""
import json,re,sys,pathlib
source=pathlib.Path(sys.argv[1]);stack=[dict(path='',collection='',options='',concern=False)];routes=[]
actions={'index':[('GET','')],'show':[('GET','/:id')],'create':[('POST','')],'update':[('PUT','/:id'),('PATCH','/:id')],'destroy':[('DELETE','/:id')]}
for raw in source.read_text().splitlines():
 line=raw.strip()
 if not line or line.startswith('#'):continue
 if line=='end':stack.pop();continue
 old=stack[-1];ctx=old.copy();block=line.endswith(' do');line=re.sub(r' do$','',line)
 m=re.match(r'(namespace|scope)\s+:(\w+)',line)
 if m:ctx['path']=old['path']+'/'+m[2];ctx['collection']=ctx['path']
 elif line.startswith('scope '):pass
 elif line.startswith('with_options '):ctx['options']=line[len('with_options '):]
 elif line.startswith('concern '):ctx['concern']=True
 elif line=='member':pass
 elif line=='collection':ctx['path']=old['collection']
 elif m:=re.match(r'(resources|resource)\s+:(\w+)(.*)',line):
  plural,name,opts=m.groups();opts+=' '+old['options'];pathmatch=re.search(r'\bpath: :(\w+)',opts);path=old['path']+'/'+(pathmatch[1] if pathmatch else name);only=re.search(r'only: (\[[^]]*\]|:\w+)',opts)
  if not only:raise ValueError('Unbounded resource: '+line)
  selected=re.findall(r':(\w+)',only[1]);single=plural=='resource'
  if not old['concern']:
   for action in selected:
    for verb,suffix in actions[action]:routes.append([verb,path+('' if single else suffix)])
   if 'concerns: :approvable' in opts:
    routes.extend([['POST',path+'/:id/approve'],['POST',path+'/:id/reject']])
  ctx['path']=path+('' if single else '/:id');ctx['collection']=path
 elif m:=re.match(r'(get|post|put|patch|delete)\s+(?::(\w+)|[\'"]([^\'"]+)[\'"])',line):
  verb,name,literal=m.groups();path=old['path']+'/'+(name or literal).lstrip('/');path=path.replace('(*any)','*')
  if not old['concern']:routes.append([verb.upper(),path])
 else:raise ValueError('Unsupported DSL: '+line)
 if block:stack.append(ctx)
if len(stack)!=1:raise ValueError('Unbalanced route blocks')
print(json.dumps({'reference':'Mastodon v4.7.1','api_version':11,'commit':'bc19d30b90403d9d058da301bcd7fafcc03fbf92','source':'https://github.com/mastodon/mastodon/blob/v4.7.1/config/routes/api.rb','routes':[{'method':m,'path':p} for m,p in sorted(set(map(tuple,routes)))]},indent=2))
