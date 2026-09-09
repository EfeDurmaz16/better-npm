import base64,gzip,hashlib,io,json,pathlib,subprocess,tarfile,tempfile,threading,http.server,time
root=pathlib.Path(tempfile.mkdtemp(prefix='better-cache-publication-'))
binary=str(pathlib.Path(__file__).resolve().parents[2] / 'crates/target/debug/better-core')
def archive(bad=False):
 b=io.BytesIO()
 with tarfile.open(fileobj=b,mode='w:gz') as t:
  data=b'{"name":"fixture","version":"1.0.0"}'
  h=tarfile.TarInfo('package/package.json'); h.size=len(data);t.addfile(h,io.BytesIO(data))
 return b.getvalue() if not bad else b'not gzip'
data=archive(); digest=hashlib.sha512(data).hexdigest(); count=0
class H(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  global count
  count+=1;self.send_response(200);self.end_headers();self.wfile.write(data)
 def log_message(self,*a):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=server.serve_forever,daemon=True).start()
project=root/'project';project.mkdir();cache=root/'cache'
(project/'package.json').write_text('{"name":"test","version":"1.0.0"}')
(project/'package-lock.json').write_text(json.dumps({'lockfileVersion':3,'packages':{'':{},'node_modules/fixture':{'version':'1.0.0','resolved':f'http://127.0.0.1:{server.server_port}/p.tgz','integrity':'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()}}}))
cmd=[binary,'install','--project-root',str(project),'--cache-root',str(cache),'--no-scripts','--json']
def run():
 p=subprocess.run(cmd,capture_output=True,text=True);assert p.returncode==0,(p.stdout,p.stderr);return p
run();first=count
markers=list(cache.rglob('.better_extracted'));assert len(markers)==1,markers
markers[0].unlink();run();assert count==first,(count,first)
print(json.dumps({'initial_gets':first,'after_marker_repair_gets':count,'root':str(root)}))
server.shutdown()
