// Temporary loopback-only operator tool. Never loaded by the application.
// Supabase secret is held in memory for createUser only; it is never written or returned.
import {createServer} from 'node:http';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {loadEnvFile} from 'node:process';
import {createClient} from '@supabase/supabase-js';
loadEnvFile('.env.local');
const origin='http://127.0.0.1:3103',csrf=randomBytes(32).toString('hex'),file='.local/integration-users.json';
const escapeHtml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
let busy=false;
createServer(async(req,res)=>{
  res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'");
  if(req.headers.host!=='127.0.0.1:3103'){res.writeHead(403);res.end();return;}
  if(req.method==='GET'){
    if(existsSync(file)){res.end('<h1>Test users ready</h1><p>Credentials are stored only in .local/integration-users.json.</p>');return;}
    res.end(`<h1>Trading OS development verification</h1><p>Create two confirmed test users in the configured project. No emails are sent. The secret key is used only by this local process and is not saved.</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><label>Existing project secret key<input type="password" name="key" required autocomplete="off"></label><button type="submit">Create two development users</button></form>`);return;
  }
  if(req.method!=='POST'||req.headers.origin!==origin||busy||existsSync(file)){res.writeHead(403);res.end();return;}
  busy=true;
  try{
    let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw Error('Invalid request');}
    const fields=new URLSearchParams(body);if(fields.get('csrf')!==csrf||!/^sb_secret_[\w-]+$/.test(fields.get('key')??''))throw Error('Invalid request');
    const admin=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,fields.get('key'),{auth:{persistSession:false,autoRefreshToken:false}});
    const run=randomBytes(6).toString('hex'),users=[];mkdirSync('.local',{recursive:true});
    for(const label of ['a','b']){
      const email=`trading-os-test-${run}-${label}@example.invalid`,password=`Tos!${randomBytes(24).toString('base64url')}`;
      const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{purpose:'Trading OS deterministic persistence verification'}});
      if(error||!data.user)throw Error(`Test user creation failed (${error?.status ?? 'unknown'} / ${error?.code ?? 'unknown'})`);
      users.push({id:data.user.id,email,password});writeFileSync(file,JSON.stringify({project:process.env.NEXT_PUBLIC_SUPABASE_URL,users},null,2),{mode:0o600});
    }
    res.end('<h1>Two test users created</h1><p>Ready for authenticated persistence and RLS verification.</p>');
    console.log('Created two confirmed development users; credentials saved to ignored .local/integration-users.json. No secret key retained.');
  }catch(e){res.writeHead(400);res.end(`<h1>Provisioning failed</h1><p>${escapeHtml(e instanceof Error?e.message:'Request failed')}</p>`);}finally{busy=false;}
}).listen(3103,'127.0.0.1',()=>console.log(`Development provisioning: ${origin}`));
