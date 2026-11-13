import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
const root=process.cwd(),tmp=await mkdtemp(path.join(tmpdir(),'atlas-cloud-ui-'));
const base='http://127.0.0.1:18478',publicBase='https://littlefish.sarl';
const child=spawn(path.join(root,'.local/cloud-venv/bin/python'),['cloud/server.py'],{env:{...process.env,ATLAS_CLOUD_DATA:tmp,ATLAS_SERVER_BIN:path.join(root,'target/debug/atlas-server'),ATLAS_CLOUD_PORT:'18478'},stdio:['ignore','pipe','pipe']});
let browser;
try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/atlas/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route(publicBase+'/**',async route=>{
    const response=await route.fetch({url:route.request().url().replace(publicBase,base)});
    await route.fulfill({response});
  });
  const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(publicBase+'/atlas/');
  await page.getByRole('button',{name:'没有账号，去注册'}).click();
  await page.getByLabel('用户名',{exact:true}).fill('ui_alice');
  await page.getByLabel('密码',{exact:true}).fill('test-password-123');
  await page.getByRole('button',{name:'注册并登录',exact:true}).click();
  await page.getByText('ui_alice 的云端地图',{exact:true}).waitFor();
  const a=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('atlas-cloud-session')));
  async function api(method,params={}){
    const r=await fetch(base+'/atlas/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+a.token},body:JSON.stringify({method,params})});
    assert.equal(r.status,200);return r.json();
  }
  const map=await api('create_map',{title:'Plugin created map',target:'Remote topic'});
  await page.getByText('Plugin created map',{exact:true}).first().waitFor({timeout:12000});
  await api('apply_graph_patch',{map_id:map.id,expected_version:map.version,operations:[{op:'rename_map',title:'Updated while app open'}]});
  await page.getByText('Updated while app open',{exact:true}).first().waitFor({timeout:12000});
  await page.getByRole('button',{name:'MCP 设置',exact:true}).click();
  await page.getByText('云端账号 · ui_alice',{exact:true}).waitFor();
  await page.getByText('https://littlefish.sarl/atlas/mcp',{exact:true}).waitFor();
  await mkdir('artifacts/tests',{recursive:true});
  await page.screenshot({path:'artifacts/tests/cloud-account.png',fullPage:true});
  await page.getByRole('button',{name:'退出账号',exact:true}).click();
  await page.getByRole('heading',{name:'登录知识地图'}).waitFor();
  await page.getByRole('button',{name:'没有账号，去注册'}).click();
  await page.getByLabel('用户名',{exact:true}).fill('ui_bravo');
  await page.getByLabel('密码',{exact:true}).fill('test-password-123');
  await page.getByRole('button',{name:'注册并登录',exact:true}).click();
  await page.getByText('ui_bravo 的云端地图',{exact:true}).waitFor();
  assert.equal(await page.getByText('Updated while app open',{exact:true}).count(),0);
  assert.deepEqual(errors,[]);
  console.log('PASS: registration, cloud polling creates/updates maps, OAuth setup, logout, second account isolation');
}finally{
  await browser?.close();child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(tmp,{recursive:true,force:true});
}
