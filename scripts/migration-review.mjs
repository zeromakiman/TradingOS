import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const root = new URL("../supabase/migrations/", import.meta.url);
const escapeHtml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
createServer((req,res)=>{
  const name = decodeURIComponent((req.url ?? "/").slice(1));
  const files=readdirSync(root).filter(f=>/^\d+_[a-z_]+\.sql$/.test(f));
  res.setHeader("Content-Type","text/html; charset=utf-8");res.setHeader("Cache-Control","no-store");
  if(!files.includes(name)){res.end(`<h1>Trading OS migration review</h1>${files.map(f=>`<p><a href="/${f}">${f}</a></p>`).join("")}`);return;}
  const sql=readFileSync(new URL(name,root),"utf8"), version=name.split("_")[0], label=name.slice(version.length+1,-4);
  const literal="'"+sql.replaceAll("'","''")+"'";
  const migration=`begin;\ncreate schema if not exists supabase_migrations;\ncreate table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text);\ndo $guard$ begin if exists(select 1 from supabase_migrations.schema_migrations where version='${version}') then raise exception 'Migration already applied'; end if; end $guard$;\n${sql}\ninsert into supabase_migrations.schema_migrations(version,statements,name) values('${version}',array[${literal}],'${label}');\ncommit;\nselect version,name,md5(array_to_string(statements,'')) as source_md5 from supabase_migrations.schema_migrations order by version;`;
  res.end(`<h1>${name}</h1><p>Source MD5: ${createHash("md5").update(sql).digest("hex")}</p><pre id="migration">${escapeHtml(migration)}</pre>`);
}).listen(3102,"127.0.0.1",()=>console.log("Migration review: http://127.0.0.1:3102"));
