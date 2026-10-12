import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function runEmployeeLayoutCases({ browser, output, origin, cases, fill, clickText, directory, editor, writes, releaseDraft }) {
  const e = browser.evaluate;
  const variants = [320,390,640,768,1024,1280,1440,1920,2560].map(width => ({ name: String(width), width, host: width }));
  variants.push({name:"narrow-host",width:1920,host:640}, {name:"dark-touch",width:320,host:320,theme:"graphite",touch:true,reduced:true},
    {name:"native-shell",width:1440,host:1440,native:true}, {name:"rollback",width:1280,host:1280,rollback:true});
  const geometry = async (selector, input) => e(`(()=>{
    const root=document.querySelector(${JSON.stringify(selector)}),field=document.querySelector(${JSON.stringify(input)}).closest('.wand-settings-library-field'),r=n=>n.getBoundingClientRect().toJSON(),s=getComputedStyle(root);
    return {root:r(root),container:root.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),label:r(field.querySelector('.ant-form-item-label')),control:r(field.querySelector('.ant-form-item-control')),overflow:root.scrollWidth>root.clientWidth+1};
  })()`);
  const assertField = (value, host, name) => {
    assert.ok(value.root.width>=host-22,`${name}: fill the actual host`);
    assert.equal(value.overflow,false,`${name}: no horizontal overflow`);
    if(value.container>=1040) assert.ok(value.control.x>value.label.x&&Math.abs(value.control.y-value.label.y)<1,`${name}: desktop labels and controls share a row`);
    else assert.ok(value.control.y>value.label.y,`${name}: narrow labels stack`);
  };
  for(const v of variants) {
    await browser.send("Emulation.setDeviceMetricsOverride", {width:v.width,height:1000,deviceScaleFactor:1,mobile:false});
    await browser.send("Emulation.setTouchEmulationEnabled", {enabled:!!v.touch});
    await browser.send("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:v.reduced?"reduce":"no-preference"}]});
    await browser.send("Page.navigate", {url:origin+(v.rollback?"/?reactUi=0":"/")});
    await browser.wait("!!window.employeeProfileFixture"); await directory();
    if(v.native) await e("document.documentElement.classList.add('is-wand-app');true");
    if(v.theme) await e(`employeeProfileFixture.setTheme(${JSON.stringify(v.theme)});true`);
    if(v.host!==v.width) await e(`document.getElementById('fixture-stage').style.width='${v.host}px';true`);
    await browser.settle();
    const index=await e(`(()=>{const page=document.querySelector('.wand-employee-workspace'),items=document.querySelector('.employee-items'),rows=[...items.querySelectorAll('.employee-item')],r=n=>n.getBoundingClientRect().toJSON();return {page:r(page),items:r(items),rows:rows.map(r),overflow:page.scrollWidth>page.clientWidth+1}})()`);
    assert.equal(index.page.width,v.host); assert.ok(index.items.width>=v.host-42); assert.equal(index.overflow,false);
    const columns=v.host-40>=1440?3:v.host-40>=980?2:1;
    assert.ok(index.rows.slice(0,columns).every(row=>Math.abs(row.y-index.rows[0].y)<1),`${v.name}: directory column count`);
    assert.ok(index.rows[columns].y>index.rows[0].y,`${v.name}: remaining employees wrap into the next row`);
    if(["2560","390"].includes(v.name)) await browser.screenshot(join(output,`directory-${v.name}.png`));
    await clickText("招聘员工",".employee-directory"); await browser.wait("!!document.querySelector('#new-employee-expectation')");
    await fill("#new-employee-expectation","布局验收草稿：请保留输入与候选顺序。");
    const basic=await geometry(".is-new","#new-employee-expectation"); assertField(basic,v.host,`${v.name}/new-basic`);
    if(["2560","390"].includes(v.name)) await browser.screenshot(join(output,`new-basic-${v.name}.png`));
    await browser.click(".is-new .ant-collapse-header");
    await browser.wait("!!document.querySelector('#new-employee-name')?.getClientRects().length");
    await fill("#new-employee-name","布局验证员工"); await fill("#new-employee-duty","负责验证大屏和窄屏下的填写体验。");
    await clickText("编辑头像",".is-new"); await browser.wait("!!document.querySelector('.is-new .appearance-controls')");
    const manual=await geometry(".is-new","#new-employee-name"); assertField(manual,v.host,`${v.name}/manual`);
    const avatar=await e(`(()=>{const p=document.querySelector('.is-new .avatar-stage'),c=document.querySelector('.is-new .appearance-controls'),r=n=>n.getBoundingClientRect().toJSON();return {preview:r(p),controls:r(c)}})()`);
    if(manual.container>=640) assert.ok(avatar.controls.x>avatar.preview.x&&Math.abs(avatar.controls.y-avatar.preview.y)<1,`${v.name}: avatar preview and options sit side by side`);
    else assert.ok(avatar.controls.y>avatar.preview.y,`${v.name}: avatar options stack`);
    await browser.click('.is-new .appearance input[value="diamond"]');
    await browser.key("ArrowRight"); assert.equal(await e("document.querySelector('.is-new .appearance input[value=round]').checked"),true);
    await browser.click(".is-new .ant-collapse-header"); await browser.click(".is-new .ant-collapse-header");
    await browser.wait("!!document.querySelector('#new-employee-name')?.getClientRects().length");
    assert.equal(await e("document.querySelector('#new-employee-name').value"),"布局验证员工");
    assert.equal(await e("document.querySelector('.is-new .appearance input[value=round]').checked"),true,"disclosure retains avatar draft");
    if(["2560","390"].includes(v.name)) {
      await browser.click('.is-new .wand-team-candidate [aria-label$="指派给"]'); await browser.wait("!!document.querySelector('.wand-ui-select-content [role=option][title=Codex]')");
      await browser.click('.wand-ui-select-content [role=option][title=Codex]');
      await browser.click('.is-new .wand-team-candidate [aria-label$="模型"]'); await browser.wait("!!document.querySelector('.wand-ui-select-content input')");
      await browser.click('.wand-ui-select-content input'); await browser.send("Input.insertText",{text:"模型"});
      await browser.wait("!!document.querySelector('.wand-ui-select-content [role=option][title=模型二]')"); await browser.click('.wand-ui-select-content [role=option][title=模型二]');
      assert.equal(await e("!!document.querySelector('#new-employee-name')?.getClientRects().length"),true,"owned model Portal preserves the form");
      await browser.click('.is-new .wand-team-candidate [aria-label$="模型"]'); await browser.wait("!!document.querySelector('.wand-ui-select-content')");
      await browser.click('.is-new .wand-team-candidate-tag'); await browser.wait("!document.querySelector('.wand-ui-select-content')");
      await browser.click('.is-new .wand-team-candidate [aria-label$="模型"]'); await browser.wait("!!document.querySelector('.wand-ui-select-content input')"); await browser.click('.wand-ui-select-content input');
      await browser.key("Escape"); await browser.wait("!document.querySelector('.wand-ui-select-content')");
      assert.equal(await e("!!document.querySelector('#new-employee-name')?.getClientRects().length"),true,"Escape closes only the model popup");
      await e("document.querySelector('.is-new').scrollTop=0;true"); await browser.screenshot(join(output,`new-manual-${v.name}.png`));
    }
    await clickText("取消",".is-new"); await browser.wait("!!document.querySelector('.employee-directory')");
    await editor("emp-custom"); await browser.settle();
    const edit=await geometry("[data-employee-profile] .editor","#employee-emp-custom-name"); assertField(edit,v.host,`${v.name}/edit`);
    await fill("#employee-emp-custom-name","编辑布局草稿");
    await browser.click('.identity-summary button'); await browser.wait("!!document.querySelector('[data-employee-profile] .appearance-controls')");
    const editorFits=await e("(()=>{const n=document.querySelector('.profile-body');return n.scrollWidth<=n.clientWidth+1})()"); assert.equal(editorFits,true);
    if(["2560","390"].includes(v.name)) {await e("document.querySelector('.profile-body').scrollTop=0;true");await browser.screenshot(join(output,`edit-${v.name}.png`));}
    assert.equal(writes(),0,"layout cases never create, save or execute a model");
    cases.push({name:v.name,width:v.width,host:v.host,touch:!!v.touch,basic,manual,avatar,index,edit});
  }
  // A loopback-only deferred AI-draft response checks cancellation isolation;
  // no real model, installed-service endpoint or employee record is used.
  await browser.send("Emulation.setDeviceMetricsOverride", {width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  await browser.send("Emulation.setTouchEmulationEnabled", {enabled:false}); await directory();
  await clickText("招聘员工",".employee-directory"); await fill("#new-employee-expectation","只在隔离fixture里生成。"); await browser.click('.is-new .ant-collapse-header');
  await clickText("请嘟嘟重新拟定",".is-new"); await browser.wait("document.querySelector('.wand-employee-create-submit').disabled");
  await clickText("取消",".is-new"); await browser.wait("!!document.querySelector('.employee-directory')");
  assert.equal(await e("[...document.querySelectorAll('.employee-directory button')].find(n=>n.innerText.includes('招聘员工')).disabled"),false,"cancelling generation releases the parent busy state");
  await clickText("招聘员工",".employee-directory"); await browser.click('.is-new .ant-collapse-header'); await fill("#new-employee-name","新会话草稿不能被迟到生成覆盖");
  releaseDraft(); await browser.wait("employeeProfileFixture.draftResponses===1");
  assert.equal(await e("document.querySelector('#new-employee-name').value"),"新会话草稿不能被迟到生成覆盖");
  cases.push({name:"cancel mock generation releases busy state and rejects late draft"});
  writeFileSync(join(output,"layout-evidence.json"),JSON.stringify({ok:true,modelExecution:false,variants:variants.length,cases},null,2));
}
