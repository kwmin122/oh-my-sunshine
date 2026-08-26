import type { FastifyInstance } from "fastify";
import type { MobilePairingService } from "../services/mobile/mobile-control-service.js";
import type { DocumentRepository } from "../infrastructure/db/document-repository.js";
import type { ProjectService } from "../application/project/project-service.js";
import type { DecisionService } from "../application/governance/decision-service.js";
import type { ApprovalService } from "../application/governance/approval-service.js";

/** Mobile Companion web surface (spec §5.17). A remote CONTROL SURFACE only:
 * monitor, converse with the Engineering Lead, answer decisions, act on approvals,
 * pause/resume. All commands pass through the same deterministic governance as desktop. */
export function registerMobilePage(app: FastifyInstance, deps: {
  pairing: MobilePairingService;
  docs: DocumentRepository;
  projects: ProjectService;
  decisions: DecisionService;
  approvals: ApprovalService;
}): void {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>DevFlow Mobile</title>
<style>
 body{background:#0a0a0a;color:#e5e5e5;font-family:system-ui;margin:0;padding:16px}
 .card{border:1px solid #262626;border-radius:10px;padding:12px;margin-bottom:12px;background:#141414}
 button{background:#0369a1;border:none;border-radius:6px;color:white;padding:8px 12px;margin:4px 4px 0 0}
 button.danger{background:#7f1d1d} input,select{background:#171717;border:1px solid #333;border-radius:6px;color:#eee;padding:8px;width:100%;box-sizing:border-box}
 h3{margin:4px 0;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#a3a3a3}
 .muted{color:#737373;font-size:12px}.ok{color:#34d399}.bad{color:#f87171}.warn{color:#fbbf24}
</style></head><body>
<h2>DevFlow OS <span style="font-size:11px;color:#737373">mobile companion</span></h2>
<div id="root">loading…</div>
<script>
const S={device:null,project:null};
function pickProject(id){S.project=id;render();}
const el=(h)=>{document.getElementById('root').innerHTML=h};
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function pair(){
  const name=document.getElementById('dname').value||'phone';
  const role=document.getElementById('drole').value;
  const b=await fetch('/api/mobile/pair/begin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceName:name,requestedRole:role})}).then(r=>r.json());
  const c=await fetch('/api/mobile/pair/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:b.pairingToken})}).then(r=>r.json());
  if(!c.device){el('<p class="bad">pairing failed</p>');return;}
  // device secret = hash of identity (demo transport auth; production uses stored keypair)
  const secret=await sha256(c.device.deviceIdentity);
  S.device={id:c.device.id,name:c.device.name,role:c.device.role,secret};
  localStorage.setItem('devflow_device',JSON.stringify(S.device));
  render();
}

async function sha256(t){
  const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function mcall(path,body){
  return fetch(path,{method:'POST',headers:{'content-type':'application/json','x-devflow-device':S.device.id,'x-devflow-secret':S.device.secret},body:JSON.stringify(body)}).then(async r=>{const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j;});
}

async function send(kind,text,refId){
  try{
    const r=await mcall('/api/m/message',{kind,text,refId:refId||null});
    await render();
    // render() rebuilds the DOM (including #reply) — write the answer after it.
    document.getElementById('reply').textContent=r.outbound.text;
  }catch(e){document.getElementById('reply').textContent='⚠ '+e.message;}
}

async function render(){
  if(!S.device){
    el(\`<div class="card"><h3>Pair this device</h3>
      <input id="dname" placeholder="device name"/><br/>
      <select id="drole"><option>VIEWER</option><option selected>OPERATOR</option><option>ADMIN</option></select><br/>
      <button onclick="pair()">Pair (10-min single-use token)</button>
      <p class="muted">VIEWER=read-only · OPERATOR=chat+decisions+pause · ADMIN=dangerous approvals too</p></div>\`);
    return;
  }
  const projParam = S.project ? '?projectId=' + encodeURIComponent(S.project) : '';
  const st=await fetch('/api/m/status'+projParam,{headers:{'x-devflow-device':S.device.id,'x-devflow-secret':S.device.secret}}).then(r=>r.json());
  S.project = st.project?.id ?? null;
  let h='';
  if(st.projects && st.projects.length>1){
    h+='<div class="card"><h3>Project</h3><select id="proj" onchange="pickProject(this.value)">';
    for(const p of st.projects)h+='<option value="'+esc(p.id)+'"'+(p.id===S.project?' selected':'')+'>'+esc(p.name)+'</option>';
    h+='</select></div>';
  }
  h+='<div class="card"><h3>' + esc(st.project?st.project.name:'No project') + '</h3>';
  if(st.project){h+='<p class="muted">decisions needing you: '+st.needsYou.decisions+' · approvals: '+st.needsYou.approvals+'</p>';}
  h+='</div>';
  if(st.openDecisions)for(const d of st.openDecisions){
    h+='<div class="card"><h3 class="warn">Decision '+esc(d.stableKey)+'</h3>'+esc(d.question);
    for(const o of d.options)h+='<br/><button onclick="send(\\'DECISION_ANSWER\\',\\''+esc(o.label)+'\\',\\''+d.id+'\\')">'+esc(o.key)+'. '+esc(o.label)+'</button>';
    h+='</div>';
  }
  if(st.openApprovals)for(const a of st.openApprovals){
    h+='<div class="card"><h3 class="bad">Approval</h3><span class="mono">'+esc(a.requestedActionSummary)+'</span><p class="muted">'+esc(a.reason)+'</p>';
    h+='<button class="danger" onclick="send(\\'APPROVAL_OUTCOME\\',\\'ALLOW_ONCE\\',\\''+a.id+'\\')">Allow once</button>';
    h+='<button onclick="send(\\'APPROVAL_OUTCOME\\',\\'REJECT\\',\\''+a.id+'\\')">Reject</button></div>';
  }
  h+='<div class="card"><h3>Engineering Lead</h3><input id="chat" placeholder="What is happening?" onkeydown="if(event.key==\\'Enter\\')send(\\'CHAT\\',this.value)"/><button onclick="send(\\'CHAT\\',document.getElementById(\\'chat\\').value)">Send</button>';
  h+='<input placeholder="taskId" id="tid"/><button onclick="send(\\'COMMAND\\',\\'pause \\'+document.getElementById(\\'tid\\').value)">Pause</button><button onclick="send(\\'COMMAND\\',\\'resume \\'+document.getElementById(\\'tid\\').value)">Resume</button>';
  h+='<p id="reply" class="muted"></p></div>';
  el(h);
}
window.addEventListener('DOMContentLoaded',async()=>{S.device=JSON.parse(localStorage.getItem('devflow_device')||'null');await render();});
</script></body></html>`;
  app.get("/m", async (_req, reply) => {
    reply.type("text/html").send(html);
  });
  void deps;
}
