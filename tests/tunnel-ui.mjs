import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {mkdir} from 'node:fs/promises';
const child=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1423'],{stdio:'ignore'});
let browser;
try {
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:1423')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:1000}});
  await page.addInitScript(()=>{
    window.calls=[];
    let snapshot={settings:{tunnel_id:'',auto_connect:false,keep_in_tray:false,remember_key:false},state:'disconnected',message:'尚未连接',has_key:false,runtime_available:true};
    window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
      window.calls.push({command,args});
      if(command==='open_setup_url')return;
      if(args.action==='connect'){
        if(args.settings.remember_key)throw '系统凭据库保存失败';
        snapshot={...snapshot,settings:args.settings,state:'connecting',message:'正在连接，等待云端确认',has_key:true};
      }
      if(args.action==='disconnect')snapshot={...snapshot,state:'disconnected',message:'连接已停止'};
      if(args.action==='forget')snapshot={...snapshot,state:'disconnected',has_key:false};
      return structuredClone(snapshot);
    }};
  });
  await page.goto('http://127.0.0.1:1423/tests/tunnel-ui.html');
  await page.getByLabel('隧道 ID',{exact:true}).fill('tunnel_0123456789abcdef0123456789abcdef');
  await page.getByLabel('隧道运行密钥',{exact:true}).fill('test-key-not-for-real-use');
  await page.getByRole('button',{name:'保存并连接'}).click();
  await page.getByRole('alert').filter({hasText:'系统凭据库保存失败'}).waitFor();
  assert.equal(await page.getByRole('status').textContent(),'未连接尚未连接');
  await page.getByLabel('记住密钥（系统凭据库）').uncheck();
  assert.equal(await page.getByLabel('下次打开 Knowledge Atlas 时自动连接').isChecked(),false);
  assert.equal(await page.getByLabel('下次打开 Knowledge Atlas 时自动连接').isDisabled(),true);
  await page.getByRole('button',{name:'保存并连接'}).click();
  await page.getByRole('status').filter({hasText:'等待云端确认'}).waitFor();
  assert.equal(await page.getByLabel('隧道运行密钥',{exact:true}).inputValue(),'');
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await mkdir('artifacts/tests',{recursive:true});
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({path:'artifacts/tests/tunnel-settings.png',fullPage:true});
  await page.getByRole('button',{name:'断开',exact:true}).click();
  await page.getByRole('status').filter({hasText:'连接已停止'}).waitFor();
  await page.getByRole('link',{name:'打开 ChatGPT 插件'}).click();
  assert.equal(await page.evaluate(()=>window.calls.at(-1).args.destination),'chatgpt');
  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:'清除连接设置'}).click();
  await page.waitForFunction(()=>window.calls.some(x=>x.args.action==='forget'));
  console.log('PASS: keychain failure, memory-only fallback, automatic reconnect dependency, key clearing, disconnect, setup links, forget');
} finally {await browser?.close(); child.kill('SIGTERM');}
