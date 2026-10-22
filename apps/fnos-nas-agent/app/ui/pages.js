/* ==================================================================
 * pages.js —— fnOS NAS Agent 页面层
 *
 * 职责：各页面的渲染与刷新（运行概览 / 文件管理 / 智能助手 / NAS 工具 /
 *      模型服务 / Skill 管理 / 操作审计），以及概览页统计与当前页刷新。
 *
 * 加载顺序：index.html 以传统 <script> 依次加载 core.js → pages.js，
 *          本文件必须最后加载：末尾的 init() 依赖 core.js 暴露的会话能力，
 *          也依赖本文件内的页面刷新函数。
 *
 * 约定：core.js 与 pages.js 都是传统 script（不是 ES module），共享同一个
 *      全局词法作用域，顶层 const / let / function 在两个文件之间互相可见；
 *      请勿使用 import / export，也不要重复声明对方的顶层标识符。
 * ================================================================== */

function clearModelProviderForm(){
 const form=document.querySelector("#model-provider-form");
 form.reset();
 document.querySelector("#model-provider-id").value="";
 document.querySelector("#model-provider-key").value="";
 document.querySelector("#model-provider-enabled").checked=true;
 document.querySelector("#model-provider-fallback").checked=false;
 document.querySelector("#model-provider-clear-key").checked=false;
 document.querySelector("#model-provider-preset").value="";
 document.querySelector("#model-provider-key").placeholder="添加时必填；编辑时留空表示保留已保存密钥";
 document.querySelector("#model-provider-save").textContent="添加模型服务商";
}
let cachedModelPresets = [];
async function refreshModelPresets(){
 const select=document.querySelector("#model-provider-preset");
 try{
  const response=await api("/api/models/presets"),payload=await response.json();
  if(!response.ok)throw Error(payload.error||"服务商预设读取失败");
  cachedModelPresets=Array.isArray(payload.presets)?payload.presets:[];
  select.replaceChildren();
  const customOption=document.createElement("option");customOption.value="";customOption.textContent="选择一个服务商预设…";select.append(customOption);
  for(const preset of cachedModelPresets){
   const option=document.createElement("option");option.value=preset.id;option.textContent=preset.name;select.append(option);
  }
 }catch(error){
  select.replaceChildren();
  const option=document.createElement("option");option.value="";option.textContent="预设暂不可用，可手动填写";select.append(option);
  document.querySelector("#model-provider-preset-help").textContent=errorText(error,"可直接填写自定义 HTTPS Endpoint。");
 }
}
document.querySelector("#model-provider-preset").addEventListener("change",()=>{
 const select=document.querySelector("#model-provider-preset"),preset=cachedModelPresets.find(item=>item.id===select.value);
 if(!preset)return;
 const editing=Boolean(document.querySelector("#model-provider-id").value);
 if(!editing&&preset.id!=="custom")document.querySelector("#model-provider-name").value=preset.name;
 document.querySelector("#model-provider-endpoint").value=preset.endpoint||"";
 document.querySelector("#model-provider-model").value="";
 document.querySelector("#model-provider-model").placeholder=preset.modelPlaceholder||"填写服务商提供的模型 ID";
 document.querySelector("#model-provider-preset-help").textContent=preset.description+(preset.docsUrl?" · 官方文档："+preset.docsUrl:"");
 document.querySelector("#model-provider-key").placeholder=preset.id==="ollama-local"?"本机 Ollama 通常忽略 API Key；填入占位值 ollama 即可":"添加时必填；编辑时留空表示保留已保存密钥";
 document.querySelector("#model-provider-error").textContent="";
 if(preset.endpoint)document.querySelector("#model-provider-key").focus();
});
async function refreshModels(){
 const host=document.querySelector("#model-provider-list"),status=document.querySelector("#model-provider-status"),error=document.querySelector("#model-provider-error");
  const renderToken=beginRender(host);
 host.replaceChildren();error.textContent="";
 try{
  const r=await api("/api/models"),data=await r.json();
   if(!renderIsCurrent(host,renderToken))return;
  if(!r.ok)throw Error(data.error||"读取模型配置失败");
  const active=data.providers.find(item=>item.id===data.activeProviderId);
  status.textContent=active
   ?"当前默认模型："+active.name+" / "+active.model+(data.modelStatus?.fallbackProviders?"；备用模型 "+data.modelStatus.fallbackProviders+" 个":"")
   :data.modelStatus?.enabled
    ?"当前使用服务端环境变量配置的模型："+(data.modelStatus.model||"未命名")
    :"当前没有启用的大模型；规则匹配功能仍可使用。";
  const totals=data.metrics?.totals||{};
  const average=(data.metrics?.providers||[]).filter(item=>item.averageLatencyMs!==null);
  const avg=average.length?Math.round(average.reduce((sum,item)=>sum+item.averageLatencyMs,0)/average.length):null;
  document.querySelector("#model-provider-metrics").textContent=
   "模型调用（当前进程）："+(totals.requests||0)+" 次；成功 "+(totals.successes||0)+"；失败 "+(totals.failures||0)+"；重试 "+(totals.retries||0)+
   "；Token（服务商有返回时统计）输入 "+(totals.inputTokens||0)+" / 输出 "+(totals.outputTokens||0)+" / 合计 "+(totals.totalTokens||0)+
   (avg===null?"":"；各模型平均耗时约 "+avg+" ms")+"。不估算费用；重启服务后统计清零。";
  if(!data.providers.length){
   const p=document.createElement("p");p.className="muted";p.textContent="尚未添加模型服务商。填写上方表单即可添加。";host.append(p);return;
  }
  for(const item of data.providers){
   // The card carries the classes of the model settings stylesheet, so the
   // Marvis look applies to the real page as well.
   const card=document.createElement("div");card.className="card model-settings__card";
   const labels=[item.isDefault?"当前默认":item.enabled?"已启用":"已停用",item.fallback?"备用模型":""].filter(Boolean).join(" · ");
   const heading=document.createElement("strong");heading.className="model-settings__card-title";heading.textContent=item.name+" · "+labels;card.append(heading);
   const meta=document.createElement("p");meta.className="muted model-settings__card-meta";meta.textContent="模型："+item.model+"；API Key："+(item.hasApiKey?"已加密保存":"未配置")+"；Endpoint："+item.endpoint;card.append(meta);
   const helpers=window.ModelSettings;
   if(helpers){
    const credential=helpers.describeCredentialState({hasKey:item.hasApiKey===true,lastTestOk:Boolean(item.lastTest&&item.lastTest.ok),lastTestAt:item.lastTest&&item.lastTest.at});
    const credentialLine=document.createElement("p");
    credentialLine.className="model-settings__card-credential model-settings__card-credential--"+(credential.keyTone||"muted");
    credentialLine.textContent=credential.keyLabel;
    card.append(credentialLine);
   }
   if(item.lastTest){
    const last=document.createElement("p");last.className=item.lastTest.ok?"muted model-settings__card-test":"error model-settings__card-test model-settings__card-test--failed";
    last.textContent=(item.lastTest.ok?"最近连接测试成功：":"最近连接测试失败：")+item.lastTest.message+(item.lastTest.at?"（"+formatDateTime(item.lastTest.at)+"）":"")+(Number.isSafeInteger(item.lastTest.durationMs)?" · 耗时 "+formatDurationMs(item.lastTest.durationMs):"")+(Number.isInteger(item.lastTest.statusCode)?" · HTTP "+item.lastTest.statusCode:"");card.append(last);
   }else{
    const last=document.createElement("p");last.className="muted model-settings__card-test";last.textContent="尚未测试连接。";card.append(last);
   }
   const actions=document.createElement("div");
   const edit=document.createElement("button");edit.type="button";edit.textContent="编辑";
   edit.addEventListener("click",()=>{
    document.querySelector("#model-provider-id").value=item.id;
    document.querySelector("#model-provider-name").value=item.name;
    document.querySelector("#model-provider-endpoint").value=item.endpoint;
    document.querySelector("#model-provider-model").value=item.model;
    document.querySelector("#model-provider-model").placeholder="填写服务商提供的模型 ID";
    document.querySelector("#model-provider-key").value="";
    document.querySelector("#model-provider-key").placeholder=item.hasApiKey?"留空保留已保存的 API Key":"请输入 API Key";
    document.querySelector("#model-provider-enabled").checked=item.enabled;
    document.querySelector("#model-provider-fallback").checked=item.fallback===true;
    document.querySelector("#model-provider-clear-key").checked=false;
    document.querySelector("#model-provider-preset").value="";
    document.querySelector("#model-provider-preset-help").textContent="正在编辑已有服务商；留空 API Key 可以保留原值。";
    document.querySelector("#model-provider-key").dataset.hasStoredKey=String(Boolean(item.hasApiKey));
    document.querySelector("#model-provider-save").textContent="保存修改";
    document.querySelector("#model-provider-error").textContent="";
    document.querySelector("#model-provider-name").focus();
   });
   const discoverButton=document.createElement("button");discoverButton.type="button";discoverButton.textContent="发现可用模型";discoverButton.disabled=!item.hasApiKey;
   discoverButton.addEventListener("click",async()=>{
    discoverButton.disabled=true;discoverButton.textContent="读取中…";
    try{
     const response=await api("/api/models/"+encodeURIComponent(item.id)+"/catalog",{method:"POST"});
     const payload=await response.json();if(!response.ok)throw Error(payload.error||"读取模型列表失败");
     if(!payload.ok)throw Error(payload.message||"服务商不支持模型列表接口");
     const choices=payload.models||[];
     if(!choices.length){document.querySelector("#model-provider-error").textContent="连接成功，但服务商未返回可用模型 ID。";return;}
     actions.querySelector(".model-catalog-picker")?.remove();
     const picker=document.createElement("div");picker.className="model-catalog-picker";
     const search=document.createElement("input");search.type="search";search.maxLength=160;
     search.placeholder="搜索模型 ID 或提供方";search.setAttribute("aria-label","搜索模型 ID 或提供方");
     const label=document.createElement("label");label.textContent="选择服务商模型";
     const select=document.createElement("select");select.setAttribute("aria-label","选择服务商模型");
     const count=document.createElement("p");count.className="muted";
     const apply=document.createElement("button");apply.type="button";apply.textContent="使用所选模型";
     const renderChoices=()=>{
      const previous=select.value||item.model,query=search.value.trim().toLocaleLowerCase();
      const filtered=choices.slice(0,100).filter(model=>(model.id+" "+(model.owned_by||"")).toLocaleLowerCase().includes(query));
      select.replaceChildren();
      for(const model of filtered){
       const option=document.createElement("option");option.value=model.id;
       option.textContent=model.id+(model.owned_by?" — "+model.owned_by:"");
       option.selected=model.id===previous;select.append(option);
      }
      if(!filtered.some(model=>model.id===previous))select.selectedIndex=0;
      count.textContent="显示 "+filtered.length+" / "+Math.min(choices.length,100)+" 个模型"+(choices.length>100?"（仅显示前 100 个）":"");
      apply.disabled=filtered.length===0;
    };
     search.addEventListener("input",renderChoices);
     label.append(select);picker.append(search,label,count,apply);
     renderChoices();
     apply.addEventListener("click",()=>{
      const modelId=select.value;
      if(!choices.slice(0,100).some(model=>model.id===modelId)){document.querySelector("#model-provider-error").textContent="请选择目录中返回的模型。";return;}
      document.querySelector("#model-provider-id").value=item.id;
      document.querySelector("#model-provider-name").value=item.name;
      document.querySelector("#model-provider-endpoint").value=item.endpoint;
      document.querySelector("#model-provider-model").value=modelId;
      document.querySelector("#model-provider-key").value="";
      document.querySelector("#model-provider-key").placeholder=item.hasApiKey?"留空保留已保存的 API Key":"请输入 API Key";
      document.querySelector("#model-provider-enabled").checked=item.enabled;
      document.querySelector("#model-provider-fallback").checked=item.fallback===true;
      document.querySelector("#model-provider-clear-key").checked=false;
      document.querySelector("#model-provider-preset").value="";
      document.querySelector("#model-provider-preset-help").textContent="已从服务商目录选择模型；点击保存修改以应用。";
      document.querySelector("#model-provider-save").textContent="保存修改";
      document.querySelector("#model-provider-error").textContent="已选择模型 "+modelId+"，尚未保存。";
      document.querySelector("#model-provider-model").focus();
      picker.remove();
     });
     const dismiss=document.createElement("button");dismiss.type="button";dismiss.textContent="取消";
     dismiss.addEventListener("click",()=>picker.remove());
     picker.append(apply,dismiss);
     actions.append(picker);
    }catch(error){document.querySelector("#model-provider-error").textContent=errorText(error,"读取模型列表失败");}
    finally{discoverButton.disabled=false;discoverButton.textContent="发现可用模型";}
   });
   const testButton=document.createElement("button");testButton.type="button";testButton.textContent="测试连接";testButton.disabled=!item.hasApiKey;
   testButton.addEventListener("click",async()=>{
    testButton.disabled=true;testButton.textContent="测试中…";
    try{
     const result=await api("/api/models/"+encodeURIComponent(item.id)+"/test",{method:"POST"});
     const payload=await result.json();if(!result.ok)throw Error(payload.error||"连接测试失败");
     document.querySelector("#model-provider-error").textContent=(payload.test?.ok?"连接测试成功：":"连接测试失败：")+(payload.test?.message||"未知结果");
     await refreshModels();await refreshAgentStatus();
    }catch(error){document.querySelector("#model-provider-error").textContent=errorText(error,"连接测试失败");}
    finally{testButton.disabled=false;testButton.textContent="测试连接";}
   });
   const makeDefault=document.createElement("button");makeDefault.type="button";makeDefault.textContent="设为默认";makeDefault.disabled=item.isDefault||!item.enabled||!item.hasApiKey;
   makeDefault.addEventListener("click",async()=>{
    makeDefault.disabled=true;
    try{const response=await api("/api/models/"+encodeURIComponent(item.id)+"/default",{method:"POST"});const payload=await response.json();if(!response.ok)throw Error(payload.error||"设置默认模型失败");await refreshModels();await refreshAgentStatus();}
    catch(error){document.querySelector("#model-provider-error").textContent=errorText(error,"设置默认模型失败");makeDefault.disabled=false;}
   });
   const toggle=document.createElement("button");toggle.type="button";toggle.textContent=item.enabled?"停用":"启用";
   toggle.disabled=!item.hasApiKey&&!item.enabled;
   toggle.addEventListener("click",async()=>{
    toggle.disabled=true;
    try{
     const response=await api("/api/models/"+encodeURIComponent(item.id),{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({name:item.name,endpoint:item.endpoint,model:item.model,enabled:!item.enabled})});
     const payload=await response.json();if(!response.ok)throw Error(payload.error||"更新模型状态失败");
     await refreshModels();await refreshAgentStatus();
    }catch(error){document.querySelector("#model-provider-error").textContent=errorText(error,"更新模型状态失败");toggle.disabled=false;}
   });
   const remove=document.createElement("button");remove.type="button";remove.textContent="删除";
   remove.addEventListener("click",async()=>{
    if(!(await confirmAction("确定删除模型服务商“"+item.name+"”？加密保存的 API Key 也会被移除。")))return;
    remove.disabled=true;
    try{const response=await api("/api/models/"+encodeURIComponent(item.id),{method:"DELETE"});const payload=await response.json();if(!response.ok)throw Error(payload.error||"删除模型失败");if(document.querySelector("#model-provider-id").value===item.id)clearModelProviderForm();await refreshModels();await refreshAgentStatus();}
    catch(error){document.querySelector("#model-provider-error").textContent=errorText(error,"删除模型失败");remove.disabled=false;}
   });
   actions.append(edit,discoverButton,testButton,makeDefault,toggle,remove);card.append(actions);host.append(card);
  }
 }catch(error){
  status.textContent="无法读取大模型配置。";
  const p=document.createElement("p");p.className="error";p.textContent=errorText(error,"检查 Agent 私有数据目录配置。");host.append(p);
 }
}
/* --- Phase 154: Marvis style form helpers ---------------------------- */
const MODEL_FIELD_IDS={name:"#model-provider-name",baseUrl:"#model-provider-endpoint",apiKey:"#model-provider-key",modelId:"#model-provider-model",presetId:"#model-provider-preset"};
function showModelProviderFieldErrors(errors){
 const map=errors||{};
 for(const [field,selector] of Object.entries(MODEL_FIELD_IDS)){
  const element=document.querySelector(selector);if(!element)continue;
  const message=map[field]||"";
  // The shared style marks the field container, the fallback rule of the
  // model settings stylesheet marks the control itself. Both are set, so the
  // error is visible in either style.
  const container=element.closest(".field")||element.parentElement||element;
  container.classList.toggle("field--invalid",Boolean(message));
  element.classList.toggle("field--invalid",Boolean(message));
  element.setAttribute("aria-invalid",message?"true":"false");
  let hint=container.querySelector(".field__error");
  if(!hint){hint=document.createElement("p");hint.className="field__error error";container.append(hint);}
  hint.textContent=message;
 }
}
function renderModelProviderWizard(){
 const host=document.querySelector("#model-provider-wizard");if(!host)return;
 const helpers=window.ModelSettings;if(!helpers){return;}
 const id=document.querySelector("#model-provider-id").value;
 const storedKey=Boolean(document.querySelector("#model-provider-key").dataset.hasStoredKey);
 const values={
  presetId:document.querySelector("#model-provider-preset").value,
  name:document.querySelector("#model-provider-name").value,
  baseUrl:document.querySelector("#model-provider-endpoint").value,
  apiKey:document.querySelector("#model-provider-key").value,
  modelId:document.querySelector("#model-provider-model").value
 };
 const steps=helpers.buildProviderWizardSteps(values,{requireApiKey:!id||!storedKey,hasStoredKey:storedKey});
 const summary=helpers.summarizeWizard(steps);
 host.replaceChildren();
 const title=document.createElement("p");title.className="model-settings__wizard-title";
 title.textContent="配置向导："+(steps[summary.stepIndex]?steps[summary.stepIndex].title:"确认保存")+"（第 "+(summary.stepIndex+1)+"/"+summary.totalSteps+" 步）";
 host.append(title);
 const list=document.createElement("ol");list.className="model-settings__wizard-steps";
 for(const step of steps){
  const item=document.createElement("li");
  // The class names are the ones of the model settings stylesheet, so the
  // state of a step is visible.
  item.className="model-settings__wizard-step"+(step.valid?" model-settings__wizard-step--done":" model-settings__wizard-step--current");
  item.textContent=step.title+(step.valid?" ✓":"");
  list.append(item);
 }
 host.append(list);
}
const modelProviderForm=document.querySelector("#model-provider-form");
// The module of the model settings publishes itself when it is ready. The
// wizard is drawn again at that moment, so the first screen is never empty.
if(typeof window!=="undefined")window.addEventListener("model-settings-ready",()=>renderModelProviderWizard());
renderModelProviderWizard();
if(modelProviderForm){
 modelProviderForm.addEventListener("input",()=>{showModelProviderFieldErrors({});renderModelProviderWizard();});
 modelProviderForm.addEventListener("submit",async event=>{
 event.preventDefault();
 const error=document.querySelector("#model-provider-error"),save=document.querySelector("#model-provider-save");
 error.textContent="";save.disabled=true;
 try{
  const id=document.querySelector("#model-provider-id").value;
  const apiKey=document.querySelector("#model-provider-key").value;
  const clearApiKey=document.querySelector("#model-provider-clear-key").checked;
  const body={
   name:document.querySelector("#model-provider-name").value,
   endpoint:document.querySelector("#model-provider-endpoint").value,
   model:document.querySelector("#model-provider-model").value,
   enabled:document.querySelector("#model-provider-enabled").checked,
   fallback:document.querySelector("#model-provider-fallback").checked
  };
  // Phase 154: the field level check of Marvis. It runs before the request, so
  // a wrong endpoint or a missing key is reported on the field itself.
  const helpers=window.ModelSettings;
  if(helpers){
   const storedKey=Boolean(document.querySelector("#model-provider-key").dataset.hasStoredKey);
   const check=helpers.validateProviderForm({
    name:body.name,baseUrl:body.endpoint,apiKey,modelId:body.model,
    presetId:document.querySelector("#model-provider-preset").value
   },{requireApiKey:!id||!storedKey,hasStoredKey:storedKey});
   if(!check.valid){
    showModelProviderFieldErrors(check.errors);
    throw Object.assign(new Error("请先修正表单中标红的字段。"),{statusCode:400});
   }
  }
  if(apiKey)body.apiKey=apiKey;
  if(clearApiKey)body.clearApiKey=true;
  const response=await api(id?"/api/models/"+encodeURIComponent(id):"/api/models",{method:id?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const payload=await response.json();if(!response.ok)throw Error(payload.error||"保存模型配置失败");
  clearModelProviderForm();await refreshModels();await refreshAgentStatus();
  error.textContent="模型配置已安全保存。";
 }catch(error){document.querySelector("#model-provider-error").textContent=errorText(error,"保存模型配置失败");}
 finally{save.disabled=false;}
 });
}
let modelBatchTestOffset = 0;
async function runModelProviderBatchTest(){
 const button=document.querySelector("#model-provider-test-batch");
 const status=document.querySelector("#model-provider-test-batch-status");
 button.disabled=true;
 try{
  const response=await api("/api/models"),data=await response.json();
  if(!response.ok)throw Error(data.error||"读取模型配置失败");
  const enabled=(data.providers||[]).filter(item=>item.enabled&&item.hasApiKey);
  if(!enabled.length){status.textContent="没有可测试的模型；请先添加模型并启用、配置 API Key。";return;}
  const start=modelBatchTestOffset>=enabled.length?0:modelBatchTestOffset;
  const batch=enabled.slice(start,start+5);
  const results=[];
  for(let index=0;index<batch.length;index++){
   const item=batch[index];
   status.textContent="正在测试第 "+(index+1)+" / "+batch.length+" 个模型："+item.name+"…";
   try{
    const result=await api("/api/models/"+encodeURIComponent(item.id)+"/test",{method:"POST"});
    const payload=await result.json();
    if(!result.ok)throw Error(payload.error||"连接测试请求失败");
    results.push({name:item.name,ok:payload.test?.ok===true,message:payload.test?.message||"未返回测试结果",durationMs:Number.isSafeInteger(payload.test?.durationMs)?payload.test.durationMs:null});
   }catch(error){results.push({name:item.name,ok:false,message:error.message||"连接测试请求失败"});}
  }
  modelBatchTestOffset=start+batch.length>=enabled.length?0:start+batch.length;
  await refreshModels();
  const passed=results.filter(item=>item.ok).length;
  const failed=results.length-passed;
  const details=results.map(item=>(item.ok?"✓ ":"✗ ")+item.name+"："+item.message+(Number.isSafeInteger(item.durationMs)?"（"+formatDurationMs(item.durationMs)+"）":"")).join("；");
  const remaining=enabled.length-(start+batch.length);
  status.textContent="本批完成：成功 "+passed+"，失败 "+failed+"。"+(remaining>0?"还有 "+remaining+" 个未测试，继续点击测试下一批。":"已覆盖当前所有启用模型。")+(details?" "+details:"");
 }catch(error){status.textContent=errorText(error,"批量连接测试失败。");}
 finally{button.disabled=false;}
}
document.querySelector("#model-provider-test-batch").addEventListener("click",runModelProviderBatchTest);
document.querySelector("#model-provider-reset").addEventListener("click",clearModelProviderForm);
document.querySelector("#model-provider-refresh").addEventListener("click",refreshModels);

let generatedTrimCliCommand = "";
const trimHostInput=document.querySelector("#trim-cli-host"),trimPortInput=document.querySelector("#trim-cli-port"),trimSchemeInput=document.querySelector("#trim-cli-scheme");
let trimPortEdited=false;
trimPortInput.addEventListener("input",()=>{trimPortEdited=true;});
function updateDefaultTrimCliPort(){
 if(trimPortEdited)return;
 const host=trimHostInput.value.trim().replace(/^\[|\]$/g,"");
 const isIp=host.includes(":")||/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
 trimPortInput.value=trimSchemeInput.value==="http"?"5666":isIp?"5667":"443";
}
trimHostInput.addEventListener("change",updateDefaultTrimCliPort);
trimSchemeInput.addEventListener("change",updateDefaultTrimCliPort);
document.querySelector("#trim-cli-command").addEventListener("click",async()=>{
 const out=document.querySelector("#trim-cli-command-output"),copy=document.querySelector("#trim-cli-copy"),button=document.querySelector("#trim-cli-command");
 generatedTrimCliCommand="";copy.disabled=true;button.disabled=true;out.textContent="正在生成命令…";
 try{
  const body={
   host:document.querySelector("#trim-cli-host").value,
   port:Number(document.querySelector("#trim-cli-port").value),
   scheme:document.querySelector("#trim-cli-scheme").value,
   allowSelfSigned:document.querySelector("#trim-cli-self-signed").checked,
   flow:document.querySelector("#trim-cli-flow").value
  };
  const r=await api("/api/agent/trim-cli/login-command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const payload=await r.json();if(!r.ok)throw Error(payload.error||"无法生成登录命令");
  generatedTrimCliCommand=payload.command;out.textContent=generatedTrimCliCommand;copy.disabled=false;
 }catch(error){out.textContent=errorText(error,"无法生成登录命令");}
 finally{button.disabled=false;}
});
document.querySelector("#trim-cli-copy").addEventListener("click",async()=>{
 if(!generatedTrimCliCommand)return;
 const out=document.querySelector("#trim-cli-command-output");
 try{
  if(navigator.clipboard&&navigator.clipboard.writeText)await navigator.clipboard.writeText(generatedTrimCliCommand);
  else throw Error("Clipboard API unavailable");
  out.textContent="命令已复制到剪贴板。\\n\\n"+generatedTrimCliCommand;
 }catch{
  const area=document.createElement("textarea");area.value=generatedTrimCliCommand;area.setAttribute("readonly","");area.style.position="absolute";area.style.left="-9999px";document.body.append(area);area.select();
  try{if(!document.execCommand("copy"))throw Error();out.textContent="命令已复制到剪贴板。\\n\\n"+generatedTrimCliCommand;}
  catch{out.textContent="请长按选择并复制命令：\\n\\n"+generatedTrimCliCommand;}
  area.remove();
 }
});
document.querySelector("#trim-cli-test").addEventListener("click",async()=>{
 const button=document.querySelector("#trim-cli-test"),result=document.querySelector("#trim-cli-test-result");
 button.disabled=true;result.textContent="正在执行只读连接探测…";
 try{
  const r=await api("/api/agent/trim-cli/test",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
  const body=await r.json();
  if(!r.ok){
   result.textContent=(body.error||"连接探测失败")+(body.nextAction?" 下一步："+body.nextAction:"");
   return;
  }
  result.textContent="连接成功（"+formatDateTime(body.checkedAt)+"）。官方 CLI 已完成只读系统信息查询，OAuth 授权与 API 连通性已验证。";
 }catch(error){result.textContent=errorText(error,"连接探测失败");}
 finally{await refreshAgentStatus();button.disabled=false;}
});

async function refreshAgentStatus(){
 try{
  const r=await api("/api/agent/status");const x=await r.json();if(!r.ok)throw Error(x.error||"状态读取失败");
  const cli=x.trimCli||{};
  const statuses={
   not_ready:"未就绪",not_tested:"尚未测试",stale:"检测结果已过期",connected:"连接正常",
   auth_required:"需要重新登录",scope_missing:"授权范围不足",tls_error:"HTTPS 证书错误",
   timeout:"请求超时",network_error:"网络不可达",rate_limited:"请求过于频繁",
   profile_unavailable:"Profile 配置不可用",failed:"连接失败"
  };
  const statusLabel=statuses[cli.connectionStatus]||"状态未知";
  const install=cli.available?"CLI 已安装且可执行":cli.configured?"CLI 路径已配置但不可执行":"官方 CLI 尚未安装";
  document.querySelector("#agent-status").textContent="规则优先；模型："+(x.model.enabled?"已启用（"+(x.model.providerName||x.model.model)+" / "+x.model.model+"）":"未配置")+"；可用工具："+x.availableTools+"；官方 CLI："+install+"；连接状态："+statusLabel+"；任意命令执行：关闭。";
  const detail=document.querySelector("#trim-cli-connection-detail");
  const parts=[cli.message||cli.note||"尚无连接状态信息。"];
  if(cli.checkedAt)parts.push("上次检测："+formatDateTime(cli.checkedAt));
  if(cli.errorCategory)parts.push("错误类别："+cli.errorCategory);
  if(cli.nextAction)parts.push("建议："+cli.nextAction);
  detail.textContent=parts.join(" ");
  const testButton=document.querySelector("#trim-cli-test");if(testButton)testButton.disabled=!cli.available;
 }catch(e){
  document.querySelector("#agent-status").textContent="Agent 状态暂不可用";
  document.querySelector("#trim-cli-connection-detail").textContent="无法获取连接状态；请刷新页面后重试。";
 }
}
let conversationContext = [];
function refreshConversationContextStatus(){
 const label=document.querySelector("#agent-context-status");
 if(label)label.textContent="对话上下文："+conversationContext.length+" 条消息（最多 8 条），仅在当前页面内存中保留；不会写入 NAS 任务历史。";
}

document.querySelector("#agent-clear-context").addEventListener("click",async()=>{
  const confirmed=await confirmAction("确定清空当前页面的对话上下文吗？该操作只清除浏览器内存中的上下文，不会写入 NAS 任务历史。");
  if(!confirmed)return;
  conversationContext=[];
  refreshConversationContextStatus();
  showToast("对话上下文已清空。","ok");
});

/* ---------------------------------------------------------------- chat window */
const CHAT_TERMINAL_STATUS=new Set(["completed","failed","cancelled"]);
const CHAT_STREAM_EVENT_TYPES=["progress","tool","approval","done","error"];
let chatActiveTaskId="";
const chatApprovalNodes=new Map();
function chatTimeText(){return formatDateTime(new Date().toISOString());}
function chatScrollToBottom(){const host=document.querySelector("#agent-history");if(host)host.scrollTop=host.scrollHeight;}
function chatPart(bubble,selector){return bubble&&bubble.querySelector?bubble.querySelector(selector):null;}
function chatSetStatus(text){const el=document.querySelector("#agent-stream-status");if(el)el.textContent=text;}
function chatSetStopVisible(taskId){
 const button=document.querySelector("#agent-stop");if(!button)return;
 chatActiveTaskId=taskId||"";
 button.hidden=!taskId;
 button.disabled=!taskId;
}
function chatAutoGrowInput(field){
 if(!field)return;
 field.style.height="auto";
 const full=field.scrollHeight||0;
 field.style.height=Math.min(full,400)+"px";
 field.style.overflowY=full>400?"auto":"hidden";
}
function chatRenderInline(target,text){
 const parts=String(text===null||text===undefined?"":text).split(/`([^`\n]+)`/g);
 for(let i=0;i<parts.length;i++){
  if(i%2===1){const code=document.createElement("code");code.className="chat__code-inline";code.textContent=parts[i];target.append(code);}
  else if(parts[i])target.append(document.createTextNode(parts[i]));
 }
}
function chatCodeBlock(source){
 const pre=document.createElement("pre");pre.className="chat__code";
 const code=document.createElement("code");code.textContent=source;pre.append(code);
 return pre;
}
function chatRenderMarkdown(source){
 const fragment=document.createDocumentFragment();
 const lines=String(source===null||source===undefined?"":source).split(/\r?\n/);
 let paragraph=[],codeLines=null;
 const flushParagraph=()=>{if(!paragraph.length)return;const p=document.createElement("p");chatRenderInline(p,paragraph.join("\n"));fragment.append(p);paragraph=[];};
 for(const line of lines){
  if(codeLines){if(/^\s*```\s*$/.test(line)){fragment.append(chatCodeBlock(codeLines.join("\n")));codeLines=null;}else codeLines.push(line);continue;}
  if(/^\s*```/.test(line)){flushParagraph();codeLines=[];continue;}
  if(!line.trim()){flushParagraph();continue;}
  paragraph.push(line);
 }
 if(codeLines)fragment.append(chatCodeBlock(codeLines.join("\n")));
 flushParagraph();
 return fragment;
}
function renderAgentTurn(role, body, meta){
 const host=document.querySelector("#agent-history");if(!host)return null;
 const info=meta&&typeof meta==="object"?meta:{};
 const isUser=role==="user"||role==="你";
 const bubble=document.createElement("div");
 bubble.className="chat__bubble "+(isUser?"chat__bubble--user":"chat__bubble--agent");
 if(info.taskId)bubble.dataset.taskId=String(info.taskId);
 const time=document.createElement("div");time.className="chat__time";time.textContent=chatTimeText();
 const content=document.createElement("div");content.className="chat__content";
 content.append(chatRenderMarkdown(body===null||body===undefined?"":body));
 const tools=document.createElement("div");tools.className="chat__tools";
 const approvals=document.createElement("div");approvals.className="chat__approval";
 bubble.append(time,content,tools,approvals);
 host.append(bubble);chatScrollToBottom();
 return bubble;
}
function chatSetTurnContent(bubble,body){
 const content=chatPart(bubble,".chat__content");if(!content)return;
 content.replaceChildren(chatRenderMarkdown(body===null||body===undefined?"":body));
 chatScrollToBottom();
}
function chatSetTurnMeta(bubble,text){
 if(!bubble)return;
 const previous=bubble.querySelector("[data-chat-meta]");if(previous)previous.remove();
 const meta=document.createElement("p");meta.className="muted";meta.dataset.chatMeta="1";meta.textContent=text;
 bubble.append(meta);chatScrollToBottom();
}
function chatToolCard(item,index){
 const details=document.createElement("details");details.className="chat__tool";
 const summary=document.createElement("summary");summary.className="chat__tool__summary";
 const name=item&&item.tool?String(item.tool):(item&&item.name?String(item.name):"未命名工具");
 summary.textContent="工具 "+(index+1)+" · "+name;
 const body=document.createElement("pre");body.className="chat__tool__body";
 let serialized="";
 try{serialized=formatOutputJson(item?item.result:null);}catch{serialized="结果无法显示。";}
 if(!serialized)serialized="（无返回内容）";
 body.textContent=serialized.length>8000?serialized.slice(0,8000)+"\n…（结果已截断）":serialized;
 details.append(summary,body);
 return details;
}
function chatRenderToolCards(host,results){
 if(!host)return;
 host.replaceChildren();
 const list=Array.isArray(results)?results:[];
 for(let i=0;i<list.length;i++)host.append(chatToolCard(list[i],i));
 chatScrollToBottom();
}
function chatEnsureProgress(bubble){
 if(!bubble)return null;
 let progress=chatPart(bubble,".chat__progress");
 if(progress)return progress;
 progress=document.createElement("div");progress.className="chat__progress";
 const bar=document.createElement("progress");bar.max=100;bar.value=0;bar.setAttribute("aria-label","任务进度");
 const label=document.createElement("span");label.className="muted";label.textContent="正在处理…";
 progress.append(bar,label);bubble.append(progress);
 return progress;
}
function chatUpdateProgress(bubble,payload){
 const progress=chatEnsureProgress(bubble);if(!progress)return;
 const raw=payload&&typeof payload==="object"?payload:{};
 const number=Number(raw.progress);
 let percent=Number.isFinite(number)?Math.max(0,Math.min(100,number)):null;
 if(percent!==null&&percent>0&&percent<=1)percent=Math.round(percent*100);
 const bar=progress.querySelector("progress"),label=progress.querySelector("span");
 if(bar&&percent!==null)bar.value=percent;
 if(label){const stage=raw.stage||raw.message||raw.status;label.textContent=(stage?stage+" · ":"")+(percent!==null?Math.round(percent)+"%":"处理中…");}
}
function chatRemoveProgress(bubble){
 const progress=chatPart(bubble,".chat__progress");
 if(progress)progress.remove();
}
function chatFindTurn(taskId){
 if(!taskId)return null;
 const bubbles=document.querySelectorAll(".chat__bubble");
 for(const bubble of bubbles){if(bubble.dataset.taskId===String(taskId))return bubble;}
 return null;
}
let taskRefreshTimer=null,taskHistoryOffset=0;
 const taskHistoryPageSize=10;
 async function refreshRecentTasks(){
 const stats=document.querySelector("#task-stats");
 try{const sr=await api("/api/tasks/status"),sd=await sr.json();if(!sr.ok)throw Error();stats.textContent="运行中 "+sd.running+" · 排队 "+sd.queued+" · 保留历史 "+sd.retained+" · 并发上限 "+sd.concurrency;}catch{stats.textContent="队列状态暂不可用";}
 const host=document.querySelector("#agent-recent-tasks");
 try{
  const params=new URLSearchParams({limit:String(taskHistoryPageSize),offset:String(taskHistoryOffset)});
  const status=document.querySelector("#task-history-status").value;if(status)params.set("status",status);
  const search=document.querySelector("#task-history-search").value.trim();if(search)params.set("q",search);
  const r=await api("/api/tasks?"+params.toString()),data=await r.json();if(!r.ok)throw Error(data.error||"读取失败");
  document.querySelector("#task-history-count").textContent="匹配 "+data.total+" 个 · 显示 "+(data.total?data.offset+1:0)+"–"+Math.min(data.offset+data.tasks.length,data.total);
  document.querySelector("#task-history-prev").disabled=data.offset<=0;
  document.querySelector("#task-history-next").disabled=data.offset+data.tasks.length>=data.total;
  host.replaceChildren();
  if(!data.tasks.length){const p=document.createElement("p");p.className="muted";p.textContent="暂无符合条件的任务记录。";host.append(p);if(taskRefreshTimer){clearTimeout(taskRefreshTimer);taskRefreshTimer=null;}return;}
  let hasActive=false;
  for(const task of data.tasks){
   const card=document.createElement("div");card.className="card";
   const title=document.createElement("strong");title.textContent=task.taskId+" · "+task.status;card.append(title);
   const info=document.createElement("p");info.className="muted";info.textContent="创建："+formatDateTime(task.createdAt)+(task.completedAt?"；完成："+formatDateTime(task.completedAt):"");card.append(info);
   if(task.status==="queued"||task.status==="running"){
    hasActive=true;
    const stage=document.createElement("p");stage.className="muted";stage.textContent=(task.stage||(task.status==="queued"?"排队中":"执行中"))+" · "+Math.max(0,Math.min(100,Number(task.progress)||0))+"%";card.append(stage);
    const bar=document.createElement("progress");bar.max=100;bar.value=Math.max(0,Math.min(100,Number(task.progress)||0));bar.setAttribute("aria-label","任务进度");bar.style.width="100%";bar.style.height="12px";card.append(bar);
   }else if(task.status==="completed"){
    const stage=document.createElement("p");stage.className="muted";stage.textContent=(task.stage||"已完成")+" · 100%";card.append(stage);
   }
   if(task.result?.message){const message=document.createElement("p");message.textContent=task.result.message;card.append(message);}
   if(task.result?.truncated){const note=document.createElement("p");note.className="muted";note.textContent="任务结果过大，已在服务端限制保留内容。";card.append(note);}
   if(Array.isArray(task.result?.results)&&task.result.results.length){
    const details=document.createElement("details");const summary=document.createElement("summary");summary.textContent="查看执行结果（"+task.result.results.length+" 项）";details.append(summary);
    const pre=document.createElement("pre");let serialized="";
    try{serialized=formatOutputJson(task.result.results.slice(0,10));}catch{serialized="结果无法显示";}
    pre.textContent=serialized.length>12000?serialized.slice(0,12000)+"\n…（结果已截断）":serialized;
    pre.style.maxHeight="320px";pre.style.overflow="auto";details.append(pre);
    if(task.result.results.length>10){const note=document.createElement("p");note.className="muted";note.textContent="仅显示前 10 项。";details.append(note);}
    card.append(details);
   }
   if(task.status==="queued"||task.status==="running"){
    const cancel=document.createElement("button");cancel.type="button";
    cancel.textContent=task.status==="queued"?"取消排队任务":task.cancelRequested?"等待当前工具结束…":"请求停止";
    cancel.disabled=task.status==="running"&&task.cancelRequested;
    cancel.addEventListener("click",async()=>{
     cancel.disabled=true;
     try{
      const cr=await api("/api/tasks/"+encodeURIComponent(task.taskId)+"/cancel",{method:"POST"});const cb=await cr.json();if(!cr.ok)throw Error(cb.error||"取消失败");
      if(cb.cancelRequested)document.querySelector("#agent-error").textContent="已请求停止；当前工具会先完成，不会启动后续工具。";
      await refreshRecentTasks();
     }catch(error){cancel.disabled=false;showToast(errorText(error,"取消失败"),"error");}
    });
    card.append(cancel);
   }
   if(task.error){const error=document.createElement("p");error.className="error";error.textContent=task.error;card.append(error);}
   host.append(card);
  }
  if(hasActive){if(taskRefreshTimer)clearTimeout(taskRefreshTimer);taskRefreshTimer=setTimeout(refreshRecentTasks,1200);}
  else if(taskRefreshTimer){clearTimeout(taskRefreshTimer);taskRefreshTimer=null;}
 }catch{host.textContent="任务历史暂不可用。";}
}
async function refreshPendingActions(){
 const host=document.querySelector("#pending-actions");if(!host)return;host.replaceChildren();
  const renderToken=beginRender(host);
 try{
  const r=await api("/api/actions/pending"),data=await r.json();if(!r.ok)throw Error(data.error||"读取待确认操作失败");
   if(!renderIsCurrent(host,renderToken))return;
  const pending=new Set();
  for(const action of data.actions){
   const id=String(action.id);pending.add(id);
   const previous=chatApprovalNodes.get(id);if(previous)previous.remove();
   const card=document.createElement("div");card.className="card warning";
   const title=document.createElement("strong");title.textContent=action.title+" · 需要确认";card.append(title);
   const target=document.createElement("p");target.textContent="目标："+(action.target||formatOutputJson(action.args));card.append(target);
   const desc=document.createElement("p");desc.textContent=action.description+"；确认截止："+formatDateTime(action.expiresAt);card.append(desc);
   const args=document.createElement("pre");args.textContent=formatOutputJson(action.args);card.append(args);
   const confirmButton=document.createElement("button");confirmButton.type="button";confirmButton.textContent="确认执行此操作";
   confirmButton.addEventListener("click",async()=>{if(!(await confirmAction("请再次确认：执行“"+action.title+"”，目标为“"+(action.target||formatOutputJson(action.args))+"”。此操作可能造成数据丢失。")))return;confirmButton.disabled=true;try{const cr=await api("/api/actions/"+encodeURIComponent(action.id)+"/confirm",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const result=await cr.json();if(!cr.ok)throw Error(result.error||"确认执行失败");const out=document.querySelector("#tool-result");out.textContent="已执行确认操作：\\n"+formatOutputJson(result.result);await refreshFiles(currentFilePath);await refreshPendingActions();}catch(error){showToast(errorText(error,"确认执行失败"),"error");confirmButton.disabled=false;}});
   const denyButton=document.createElement("button");denyButton.type="button";denyButton.textContent="拒绝";
   denyButton.addEventListener("click",async()=>{denyButton.disabled=true;try{const dr=await api("/api/actions/"+encodeURIComponent(action.id)+"/deny",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});const result=await dr.json();if(!dr.ok)throw Error(result.error||"拒绝失败");await refreshPendingActions();}catch(error){showToast(errorText(error,"拒绝失败"),"error");denyButton.disabled=false;}});
   const bubble=chatFindTurn(action.taskId);
   const inline=bubble?chatPart(bubble,".chat__approval"):null;
   if(inline){inline.append(card);chatScrollToBottom();}
   else host.append(card);
   chatApprovalNodes.set(id,card);
  }
  for(const [id,node] of Array.from(chatApprovalNodes.entries())){
   if(pending.has(id))continue;
   if(node)node.remove();
   chatApprovalNodes.delete(id);
  }
  if(!host.childElementCount){const p=document.createElement("p");p.className="muted";p.textContent=data.actions.length?"待确认操作已显示在上方对话中。":"没有待确认操作。";host.append(p);}
 }catch(error){const p=document.createElement("p");p.className="error";p.textContent=errorText(error,"待确认操作读取失败");host.append(p);}
}
document.querySelector("#refresh-pending-actions").addEventListener("click",refreshPendingActions);
document.querySelector("#task-history-status").addEventListener("change",()=>{taskHistoryOffset=0;refreshRecentTasks();});
document.querySelector("#task-history-search").addEventListener("change",()=>{taskHistoryOffset=0;refreshRecentTasks();});
document.querySelector("#task-history-prev").addEventListener("click",()=>{taskHistoryOffset=Math.max(0,taskHistoryOffset-taskHistoryPageSize);refreshRecentTasks();});
document.querySelector("#task-history-next").addEventListener("click",()=>{taskHistoryOffset+=taskHistoryPageSize;refreshRecentTasks();});
document.querySelector("#agent-refresh-tasks").addEventListener("click",refreshRecentTasks);
const chatStopButton=document.querySelector("#agent-stop");
if(chatStopButton)chatStopButton.addEventListener("click",async()=>{
 if(chatDirectController){
  chatStopButton.disabled=true;
  try{chatDirectController.abort();}catch{}
  chatSetStatus("已停止");
  return;
 }
 const taskId=chatActiveTaskId;if(!taskId||chatStopButton.disabled)return;
 chatStopButton.disabled=true;
 try{
  const cr=await api("/api/tasks/"+encodeURIComponent(taskId)+"/cancel",{method:"POST"});
  const cb=await cr.json();if(!cr.ok)throw Error(cb.error||"停止失败");
  chatSetStatus(cb.cancelRequested?"已请求停止，等待当前工具结束":"任务已取消");
  showToast(cb.cancelRequested?"已请求停止；当前工具会先完成，不会启动后续工具。":"任务已取消。","ok");
 }catch(error){chatStopButton.disabled=false;showToast(errorText(error,"停止失败"),"error");}
});
const chatInputField=document.querySelector("#agent-input");
if(chatInputField){
 chatInputField.addEventListener("input",()=>chatAutoGrowInput(chatInputField));
 chatInputField.addEventListener("keydown",event=>{
  if(event.key!=="Enter")return;
  if(event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||event.isComposing)return;
  event.preventDefault();
  const form=document.querySelector("#agent-form");
  if(!form)return;
  if(typeof form.requestSubmit==="function")form.requestSubmit();
  else form.dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));
 });
 chatAutoGrowInput(chatInputField);
}
document.querySelector("#task-history-clear").addEventListener("click",async()=>{
 if(!(await confirmAction("清理已完成、失败和已取消的任务记录？排队中和运行中的任务会保留，不会被取消。")))return;
 const button=document.querySelector("#task-history-clear");button.disabled=true;
 try{
  const response=await api("/api/tasks/clear-history",{method:"POST"});const result=await response.json();
  if(!response.ok)throw Error(result.error||"清理任务历史失败");
  document.querySelector("#agent-error").textContent="已清理 "+result.removed+" 条已结束任务；保留 "+result.retained+" 条任务。";
  taskHistoryOffset=0;await refreshRecentTasks();
 }catch(error){document.querySelector("#agent-error").textContent=errorText(error,"清理任务历史失败");}
 finally{button.disabled=false;}
});

function chatOpenStream(taskId,bubble,state){
 if(typeof EventSource!=="function")return null;
 let source=null;
 try{source=new EventSource("/api/tasks/"+encodeURIComponent(taskId)+"/events");}
 catch{return null;}
 const handle=event=>chatHandleStreamEvent(event,bubble,state);
 source.addEventListener("message",handle);
 for(const type of CHAT_STREAM_EVENT_TYPES)source.addEventListener(type,handle);
 source.addEventListener("error",()=>{state.streamFailed=true;try{source.close();}catch{}});
 return source;
}
function chatHandleStreamEvent(event,bubble,state){
 let payload={};
 try{payload=JSON.parse(event.data||"{}");}catch{payload={};}
 if(!payload||typeof payload!=="object")payload={};
 const type=String(payload.type||event.type||"");
 if(!CHAT_STREAM_EVENT_TYPES.includes(type))return;
 const data=payload.data&&typeof payload.data==="object"?payload.data:payload;
 if(type==="progress"){chatUpdateProgress(bubble,data);chatSetStatus(data.stage||data.message||data.status||"处理中…");}
 else if(type==="tool")chatAppendStreamTool(bubble,data);
 else if(type==="approval")refreshPendingActions();
 else if(type==="done"){state.finalTask=data.task||data;state.streamDone=true;}
 else if(type==="error"){state.streamError=String(data.message||data.error||"任务失败");chatSetStatus(state.streamError);}
}
function chatAppendStreamTool(bubble,payload){
 const tools=chatPart(bubble,".chat__tools");if(!tools)return;
 const item={tool:payload.tool||payload.name||"工具",result:payload.result!==undefined?payload.result:payload};
 tools.append(chatToolCard(item,tools.childElementCount));
 chatScrollToBottom();
}
async function chatAwaitTask(taskId,bubble,initialTask){
 const state={finalTask:null,streamDone:false,streamFailed:false,streamError:""};
 const stream=chatOpenStream(taskId,bubble,state);
 chatSetStatus(stream?"已连接流式进度…":"流式不可用，已回退到 750ms 轮询…");
 let task=initialTask||null;
 try{
  for(let i=0;i<120;i++){
   if(task&&CHAT_TERMINAL_STATUS.has(task.status))break;
   if(state.finalTask&&CHAT_TERMINAL_STATUS.has(state.finalTask.status)){task=state.finalTask;break;}
   await new Promise(resolve=>setTimeout(resolve,750));
   const poll=await api("/api/tasks/"+encodeURIComponent(taskId));const body=await poll.json();
   if(!poll.ok)throw Error(body.error||"任务状态读取失败");
   task=body.task;
   chatUpdateProgress(bubble,task);
   if(task.status==="awaiting-approval")refreshPendingActions();
  }
 }finally{if(stream){try{stream.close();}catch{}}}
 if(state.finalTask&&(!task||!CHAT_TERMINAL_STATUS.has(task.status)))task=state.finalTask;
 return task;
}
function chatFinalizeTask(taskId,task,bubble){
 chatRemoveProgress(bubble);
 if(!bubble)return;
 if(!task){chatSetTurnContent(bubble,"任务状态未知。任务 ID："+taskId);return;}
 if(task.status==="completed"&&task.result){
  const result=task.result;
  chatSetTurnContent(bubble,result.message||"（无返回内容）");
  chatRenderToolCards(chatPart(bubble,".chat__tools"),result.results||[]);
  chatSetTurnMeta(bubble,"任务："+taskId+"；模式："+(result.mode||"—")+"；状态："+(result.status||task.status));
 }else if(task.status==="failed"){
  chatSetTurnContent(bubble,"任务失败："+(task.error||"未知错误"));
  chatSetTurnMeta(bubble,"任务："+taskId+"；状态：failed");
 }else if(task.status==="cancelled"){
  chatSetTurnContent(bubble,"任务已取消。");
  chatSetTurnMeta(bubble,"任务："+taskId+"；状态：cancelled");
 }else{
  chatSetTurnContent(bubble,"任务仍在执行。任务 ID："+taskId+"。可在“最近任务”中刷新查看。");
  chatSetTurnMeta(bubble,"任务："+taskId+"；状态："+(task.status||"running"));
 }
}
/* ------------------------------------------------------ direct chat mode --- */
const CHAT_MODE_KEY="fnos-nas-agent.chat-mode";
let chatMode="task";
let chatDirectController=null;
let chatDirectStreamText="";
let chatStopDirect=false;
function chatReadStoredMode(){
 try{const stored=localStorage.getItem(CHAT_MODE_KEY);if(stored==="direct"||stored==="task")return stored;}catch{}
 return "task";
}
function chatApplyMode(mode,persist){
 const next=mode==="direct"?"direct":"task";
 chatMode=next;
 if(persist!==false){try{localStorage.setItem(CHAT_MODE_KEY,next);}catch{}}
 const taskButton=document.querySelector("#chat-mode-task");
 const directButton=document.querySelector("#chat-mode-direct");
 if(taskButton)taskButton.setAttribute("aria-pressed",next==="task"?"true":"false");
 if(directButton)directButton.setAttribute("aria-pressed",next==="direct"?"true":"false");
 const root=document.querySelector("#agent-chat");
 if(root)root.dataset.chatMode=next;
 const pendingCard=document.querySelector("#agent-pending-card");
 if(pendingCard)pendingCard.hidden=next==="direct";
 const queueCard=document.querySelector("#agent-task-queue-card");
 if(queueCard)queueCard.hidden=next==="direct";
 const hint=document.querySelector("#agent-mode-hint");
 if(hint)hint.textContent=next==="direct"?"对话模式：与模型直接对话，不执行任何 NAS 工具。":"任务模式：执行 NAS 工具任务，可被审批与停止。";
 const field=document.querySelector("#agent-input");
 if(field)field.placeholder=next==="direct"?"直接和模型对话，例如：解释一下 NAS 的存储池设计":"例如：查看系统状态 / 然后打开刚才的目录";
 chatSetStatus(next==="direct"?"对话模式":"任务模式");
}
function chatSetStopDirect(active){
 const button=document.querySelector("#agent-stop");if(!button)return;
 chatStopDirect=!!active;
 button.hidden=!active;
 button.disabled=!active;
}
function chatParseSseFrame(frame){
 const lines=String(frame).split(/\r?\n/);
 let event="message";const data=[];
 for(const line of lines){
  if(line.startsWith("event:"))event=line.slice(6).trim();
  else if(line.startsWith("data:"))data.push(line.slice(5).trim());
 }
 if(!data.length)return null;
 const raw=data.join("\n");
 let payload={raw};
 try{payload=JSON.parse(raw);}catch{payload={raw};}
 if(!payload||typeof payload!=="object")payload={raw};
 return {event,data:payload};
}
function chatSplitSseFrames(buffer){
 const frames=[];let rest=String(buffer===null||buffer===undefined?"":buffer);
 const pattern=/\r\n\r\n|\n\n|\r\r/;
 let match;
 while((match=pattern.exec(rest))!==null){
  frames.push(rest.slice(0,match.index));
  rest=rest.slice(match.index+match[0].length);
 }
 return {frames,rest};
}
async function chatReadSseStream(response,onFrame){
 if(!response||!response.body||typeof response.body.getReader!=="function")return;
 const reader=response.body.getReader();
 const decoder=new TextDecoder();
 let buffer="";let stopped=false;
 while(!stopped){
  const chunk=await reader.read();
  if(chunk.done)break;
  buffer+=decoder.decode(chunk.value,{stream:true});
  const split=chatSplitSseFrames(buffer);buffer=split.rest;
  for(const frame of split.frames){
   const parsed=chatParseSseFrame(frame);
   if(!parsed)continue;
   if(onFrame(parsed)===false){stopped=true;break;}
  }
 }
 if(!stopped&&buffer.trim()){
  const parsed=chatParseSseFrame(buffer);
  if(parsed)onFrame(parsed);
 }
 try{await reader.cancel();}catch{}
}
function chatDirectAppend(content,text){
 if(!content||!text)return;
 let target=content.lastElementChild;
 if(!target||target.dataset.chatDirect!=="1"){
  target=document.createElement("p");target.dataset.chatDirect="1";content.append(target);
 }
 target.append(document.createTextNode(text));
 chatScrollToBottom();
}
function chatDirectFinalize(content,text){
 if(!content)return;
 content.replaceChildren();
 if(text)content.append(document.createTextNode(text));
 chatScrollToBottom();
}
async function chatSendDirect(text){
 const field=document.querySelector("#agent-input"),send=document.querySelector("#agent-send"),err=document.querySelector("#agent-error");
 err.textContent="";
 let status=null;
 try{
  const statusResponse=await api("/api/chat/status");
  status=await statusResponse.json();
 }catch(error){err.textContent=errorText(error,"对话模式状态读取失败");chatSetStatus("对话模式状态读取失败");return;}
 if(!status||status.enabled!==true){
  err.textContent="尚未配置可用的模型服务商";
  chatSetStatus("尚未配置可用的模型服务商");
  showToast("尚未配置可用的模型服务商","error");
  return;
 }
 renderAgentTurn("user",text);
 field.value="";chatAutoGrowInput(field);
 send.disabled=true;send.textContent="生成中…";
 const bubble=renderAgentTurn("agent","");
 const content=chatPart(bubble,".chat__content");
 const controller=new AbortController();
 chatDirectController=controller;chatDirectStreamText="";
 chatSetStopDirect(true);chatSetStatus("正在生成…");
 let finalText="";
 try{
  const response=await api("/api/chat/message",{method:"POST",headers:{"content-type":"application/json","accept":"text/event-stream"},body:JSON.stringify({messages:[{role:"user",content:text}]}),signal:controller.signal});
  if(!response.ok){
   let detail={};
   try{detail=await response.json();}catch{}
   throw Error(detail.message||detail.error||"直聊请求失败（HTTP "+response.status+"）");
  }
  await chatReadSseStream(response,frame=>{
   if(frame.event==="delta"){
    const piece=typeof frame.data.text==="string"?frame.data.text:"";
    if(piece){finalText+=piece;chatDirectStreamText=finalText;chatDirectAppend(content,piece);}
    return true;
   }
   if(frame.event==="done"){
    const full=typeof frame.data.text==="string"&&frame.data.text?frame.data.text:finalText;
    finalText=full;chatDirectStreamText=full;chatDirectFinalize(content,full);
    return true;
   }
   if(frame.event==="error"){
    const message=String(frame.data.message||"直聊失败");
    err.textContent=message;chatSetStatus(message);
    return false;
   }
   return true;
  });
  if(finalText)chatDirectFinalize(content,finalText);
  if(!err.textContent)chatSetStatus("就绪");
 }catch(error){
  if(error&&error.name==="AbortError"){
   chatDirectFinalize(content,chatDirectStreamText||"（已停止）");
   chatSetStatus("已停止");
  }else{
   err.textContent=errorText(error,"直聊失败");
   chatSetStatus("直聊失败");
  }
 }finally{
  chatDirectController=null;
  chatSetStopDirect(false);
  send.disabled=false;send.textContent="发送";field.focus();
 }
}
const chatModeTaskButton=document.querySelector("#chat-mode-task");
const chatModeDirectButton=document.querySelector("#chat-mode-direct");
if(chatModeTaskButton)chatModeTaskButton.addEventListener("click",()=>chatApplyMode("task"));
if(chatModeDirectButton)chatModeDirectButton.addEventListener("click",()=>chatApplyMode("direct"));
chatApplyMode(chatReadStoredMode(),false);
document.querySelector("#agent-form").addEventListener("submit",async e=>{
 e.preventDefault();const field=document.querySelector("#agent-input"),send=document.querySelector("#agent-send"),err=document.querySelector("#agent-error");
 const text=field.value.trim();if(!text)return;err.textContent="";
 if(chatMode==="direct"){await chatSendDirect(text);return;}
 renderAgentTurn("user",text);field.value="";chatAutoGrowInput(field);send.disabled=true;send.textContent="已提交…";
 try{
  const r=await api("/api/agent/message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text,history:conversationContext})});
  const accepted=await r.json();if(!r.ok)throw Error(accepted.error||"请求失败");
  const taskId=accepted.task.taskId;
  const bubble=renderAgentTurn("agent","正在处理…",{taskId});
  chatEnsureProgress(bubble);
  chatSetStopVisible(taskId);
  const task=await chatAwaitTask(taskId,bubble,accepted.task);
  chatFinalizeTask(taskId,task,bubble);
  if(task&&task.status==="completed"&&task.result&&task.result.status==="completed"){
   const result=task.result;
   const contextParts=[result.message||"已完成请求。"];
   for(const item of result.results||[])contextParts.push("工具 "+item.tool+"："+JSON.stringify(item.result).slice(0,320));
   conversationContext=[...conversationContext,{role:"user",content:text},{role:"assistant",content:contextParts.join("\n").slice(0,1200)}].slice(-8);
   refreshConversationContextStatus();
  }
  await refreshRecentTasks();await refreshPendingActions();
 }catch(error){err.textContent=errorText(error,"请求失败");chatSetStatus("请求失败");}
 finally{send.disabled=false;send.textContent="发送";field.focus();chatSetStopVisible("");chatSetStatus("就绪");}
});
let currentFilePath="",currentFileOffset=0;
async function refreshFiles(pathValue=currentFilePath,pageOffset=0){
 const host=document.querySelector("#file-list"),roots=document.querySelector("#file-roots"),err=document.querySelector("#file-error"),parent=document.querySelector("#file-parent"),field=document.querySelector("#file-path");
  const renderToken=beginRender(host);
 err.textContent="";host.replaceChildren();roots.replaceChildren();
 try{
  const params=new URLSearchParams({limit:"100",offset:String(pageOffset),sort:document.querySelector("#file-sort").value,type:document.querySelector("#file-type-filter").value,q:document.querySelector("#file-search").value.trim()});if(pathValue)params.set("path",pathValue);
  const r=await api("/api/files?"+params.toString()),data=await r.json();if(!r.ok)throw Error(data.error||"目录读取失败");
   if(!renderIsCurrent(host,renderToken))return;
  currentFilePath=data.path||"";currentFileOffset=data.offset||0;field.value=currentFilePath;parent.disabled=!data.parentPath;
  document.querySelector("#file-page-info").textContent="匹配 "+(data.totalEntries||0)+" 项 / 目录共 "+(data.totalDirectoryEntries||0)+" 项 · 显示 "+(data.totalEntries?currentFileOffset+1:0)+"–"+Math.min(currentFileOffset+(data.entries||[]).length,data.totalEntries||0);
  document.querySelector("#file-page-prev").disabled=currentFileOffset<=0;
  document.querySelector("#file-page-next").disabled=currentFileOffset+(data.entries||[]).length>=(data.totalEntries||0);
  parent.onclick=()=>{if(data.parentPath)refreshFiles(data.parentPath);};
  for(const root of data.roots||[]){const btn=document.createElement("button");btn.type="button";btn.textContent=root.name;btn.addEventListener("click",()=>refreshFiles(root.path));roots.append(btn);}
   const rootsCount=document.querySelector("#file-roots-count");if(rootsCount)rootsCount.textContent=(data.roots||[]).length?"共 "+(data.roots||[]).length+" 个":"";
  const breadcrumbs=document.querySelector("#file-breadcrumbs");breadcrumbs.replaceChildren();
  const matchingRoot=(data.roots||[]).filter(root=>currentFilePath===root.path||currentFilePath.startsWith(root.path.replace(/\/+$/,"")+"/")).sort((a,b)=>b.path.length-a.path.length)[0];
  if(matchingRoot){
   const parts=[{name:matchingRoot.name,path:matchingRoot.path}];let accumulated=matchingRoot.path.replace(/\/+$/,"");
   const relative=currentFilePath.slice(matchingRoot.path.length).split("/").filter(Boolean);
   for(const part of relative){accumulated+="/"+part;parts.push({name:part,path:accumulated});}
   for(let index=0;index<parts.length;index++){if(index){const sep=document.createElement("span");sep.textContent=" / ";sep.setAttribute("aria-hidden","true");breadcrumbs.append(sep);}const crumb=parts[index];if(index===parts.length-1){const current=document.createElement("strong");current.textContent=crumb.name;current.setAttribute("aria-current","location");breadcrumbs.append(current);}else{const button=document.createElement("button");button.type="button";button.textContent=crumb.name;button.addEventListener("click",()=>refreshFiles(crumb.path));breadcrumbs.append(button);}}
  }
  const searchTerm=document.querySelector("#file-search").value.trim().toLocaleLowerCase();
  const typeFilter=document.querySelector("#file-type-filter").value;
  const sortMode=document.querySelector("#file-sort").value;
  const visibleEntries=data.entries.filter(item=>(typeFilter==="all"||item.type===typeFilter)&&(!searchTerm||item.name.toLocaleLowerCase().includes(searchTerm)));
  visibleEntries.sort((a,b)=>{
   if(sortMode==="size-desc")return (b.sizeBytes??-1)-(a.sizeBytes??-1)||a.name.localeCompare(b.name);
   if(sortMode==="modified-desc")return String(b.modifiedAt||"").localeCompare(String(a.modifiedAt||""))||a.name.localeCompare(b.name);
   return sortMode==="name-desc"?b.name.localeCompare(a.name):a.name.localeCompare(b.name);
  });
  if(!visibleEntries.length){const p=document.createElement("p");p.className="muted";p.textContent=data.entries.length?"没有符合筛选条件的项目。":(data.roots?.length?"此目录为空。":"未发现存储卷。请检查 fnOS 卷路径，或通过 AGENT_FILE_ROOTS 配置允许的绝对路径。");host.append(p);}
  for(const item of visibleEntries){
   const row=document.createElement("div");row.className="card";
   if(item.type==="directory"){const btn=document.createElement("button");btn.type="button";btn.textContent="📁 "+item.name;btn.addEventListener("click",()=>refreshFiles(item.path));row.append(btn);}
   else{const name=document.createElement("strong");name.textContent="📄 "+item.name;row.append(name);}
   const meta=document.createElement("p");meta.className="muted";meta.textContent=(item.type==="directory"?"文件夹":"文件")+" · "+(item.sizeBytes===null?"—":formatBytes(item.sizeBytes))+" · "+item.modifiedAt;row.append(meta);
   const actions=document.createElement("div");actions.className="file-row-actions";
   const actionButton=(label,fn)=>{const b=document.createElement("button");b.type="button";b.textContent=label;b.addEventListener("click",fn);actions.append(b);};
   if(item.type==="file"){
    actionButton("预览",async()=>{try{const r=await api("/api/files/preview?path="+encodeURIComponent(item.path));const data=await r.json();if(!r.ok)throw Error(data.error||"预览失败");const pre=document.querySelector("#file-preview");pre.classList.remove("hidden");pre.textContent="文件："+data.name+"（"+formatBytes(data.sizeBytes)+"）\\n\\n"+data.content;}catch(e){err.textContent=errorText(e,"预览失败");}});
    actionButton("下载",()=>{const a=document.createElement("a");a.href="/api/files/download?path="+encodeURIComponent(item.path);a.download=item.name;document.body.append(a);a.click();a.remove();});
    actionButton("计算 SHA-256",async()=>{
     err.textContent="";
     try{
      const response=await api("/api/files/checksum?path="+encodeURIComponent(item.path)),result=await response.json();
      if(!response.ok)throw Error(result.error||"SHA-256 计算失败");
      const pre=document.querySelector("#file-preview");pre.classList.remove("hidden");
      pre.textContent="文件："+result.name+"（"+formatBytes(result.sizeBytes)+"）\\n算法："+result.algorithm+"\\nSHA-256："+result.sha256+"\\n\\n"+(result.note||"按流式分块读取，未将文件整体载入内存。");
     }catch(error){err.textContent=errorText(error,"SHA-256 计算失败");}
    });
   }
   actionButton("重命名",async()=>{const name=await promptAction("输入新的名称",item.name);if(name&&name!==item.name)try{await runFileOperation({action:"rename",path:item.path,name});}catch{}});
   actionButton("移动",async()=>{const destination=await promptAction("输入目标文件夹的完整路径",currentFilePath);if(destination)try{await runFileOperation({action:"move",path:item.path,destination});}catch{}});
   actionButton("删除",async()=>{if(await confirmAction("确定删除“"+item.name+"”？文件夹仅能删除空目录。删除还需要在「待确认的危险操作」中再次确认。"))try{await runFileOperation({action:"delete",path:item.path});}catch{}});
   row.append(actions);host.append(row);
  }

 }catch(e){err.textContent=errorText(e,"目录读取失败");host.textContent="无法读取此目录。";}
}
document.querySelector("#file-form").addEventListener("submit",e=>{e.preventDefault();refreshFiles(document.querySelector("#file-path").value.trim());});
let fileSearchTimer=null;
document.querySelector("#file-search").addEventListener("input",()=>{clearTimeout(fileSearchTimer);fileSearchTimer=setTimeout(()=>refreshFiles(currentFilePath),180);});
for(const id of ["#file-type-filter","#file-sort"])document.querySelector(id).addEventListener("change",()=>refreshFiles(currentFilePath));
document.querySelector("#file-page-prev").addEventListener("click",()=>refreshFiles(currentFilePath,Math.max(0,currentFileOffset-100)));
document.querySelector("#file-page-next").addEventListener("click",()=>refreshFiles(currentFilePath,currentFileOffset+100));
async function runFileOperation(payload){const err=document.querySelector("#file-error"),status=document.querySelector("#file-operation-status");err.textContent="";status.textContent="";try{const r=await api("/api/files/operation",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});const data=await r.json();if(r.status===202&&data.approvalRequired){status.textContent="该操作需要确认，已加入「待确认的危险操作」，请在列表中再次确认后再执行。";await refreshPendingActions().catch(()=>{});return data;}if(!r.ok)throw Error(data.error||"文件操作失败");document.querySelector("#file-preview").classList.add("hidden");await refreshFiles(currentFilePath);return data;}catch(e){err.textContent=errorText(e,"文件操作失败");throw e;}}
document.querySelector("#file-mkdir").addEventListener("click",async()=>{const name=await promptAction("新文件夹名称");if(name)try{await runFileOperation({action:"mkdir",path:currentFilePath,name});}catch{}});
let activeUploadXhr=null;
function uploadFileWithProgress(url,file,onProgress,onXhr){
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();onXhr(xhr);xhr.open("POST",url);xhr.withCredentials=true;xhr.setRequestHeader("content-type","application/octet-stream");
  xhr.upload.addEventListener("progress",event=>{if(event.lengthComputable)onProgress(Math.max(0,Math.min(100,Math.round(event.loaded/event.total*100))));});
  xhr.addEventListener("load",()=>{let data={};try{data=JSON.parse(xhr.responseText||"{}");}catch{}if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(Error(data.error||"上传失败（HTTP "+xhr.status+"）"));});
  xhr.addEventListener("error",()=>reject(Error("网络中断，上传结果尚未确认。")));
  xhr.addEventListener("abort",()=>reject(Error("上传已中止。")));
  xhr.send(file);
 });
}
document.querySelector("#file-upload-cancel").addEventListener("click",()=>{if(activeUploadXhr)activeUploadXhr.abort();});
document.querySelector("#file-upload-button").addEventListener("click",async()=>{
 const field=document.querySelector("#file-upload"),files=Array.from(field.files||[]),err=document.querySelector("#file-error");
 const button=document.querySelector("#file-upload-button"),cancel=document.querySelector("#file-upload-cancel"),progress=document.querySelector("#file-upload-progress"),status=document.querySelector("#file-upload-status");
 err.textContent="";status.textContent="";
 if(!files.length){err.textContent="请先选择文件";return;}
 if(files.length>20){err.textContent="每批最多上传 20 个文件，请分批选择";return;}
 const oversized=files.find(file=>file.size>25*1024*1024);if(oversized){err.textContent="文件“"+oversized.name+"”超过 25 MiB，未开始上传";return;}
 button.disabled=true;cancel.disabled=false;progress.classList.remove("hidden");progress.value=0;let completed=0;
 try{
  for(let index=0;index<files.length;index++){
   const file=files[index],url="/api/files/upload?path="+encodeURIComponent(currentFilePath)+"&name="+encodeURIComponent(file.name);
   status.textContent="正在上传第 "+(index+1)+" / "+files.length+" 个文件："+file.name+"（0%）";
   await uploadFileWithProgress(url,file,percent=>{progress.value=Math.round(((index+percent/100)/files.length)*100);status.textContent="正在上传第 "+(index+1)+" / "+files.length+" 个文件："+file.name+"（"+percent+"%）";},xhr=>{activeUploadXhr=xhr;});
   completed++;progress.value=Math.round(completed/files.length*100);
  }
  field.value="";status.textContent="上传完成，正在刷新目录…";await refreshFiles(currentFilePath);status.textContent="已成功上传 "+completed+" 个文件。";
 }catch(error){
  err.textContent=(error.message||"上传失败")+(completed?"；此前已成功上传 "+completed+" 个文件。":"");
  if(error.message==="上传已中止。"){status.textContent="已发送取消请求，正在刷新目录确认文件状态…";await refreshFiles(currentFilePath);status.textContent="上传请求已中止；请检查目录确认文件是否存在。已完成 "+completed+" / "+files.length+" 个。";}
  else status.textContent="上传停止：已完成 "+completed+" / "+files.length+" 个；请确认目录状态后再重试。";
  if(completed)await refreshFiles(currentFilePath);
 }finally{activeUploadXhr=null;button.disabled=false;cancel.disabled=true;}
});

/* ------------------------------------------------------------------ *
 * 工具页：按来源分组折叠 + 关键字搜索。
 * 40+ 个工具全部平铺会让移动端页面高到无法浏览，
 * 因此改为 <details> 分组折叠，参数表单只在展开单个工具时渲染。
 * ------------------------------------------------------------------ */
const TOOL_GROUP_LABELS={"local.files":"文件浏览","local.system":"本机状态","local.files-write":"文件写入","local.files-destructive":"危险操作","fnos.system":"fnOS 系统","fnos.file":"fnOS 文件","fnos.app":"fnOS 应用","fnos.docker":"Docker 容器","fnos.download":"下载任务","fnos.monitor":"运行监控","fnos.storage":"存储池","fnos.user":"用户管理","fnos.photos":"相册","fnos.other":"其它 fnOS 工具"};
const TOOL_GROUP_ORDER=["local.files","local.system","local.files-write","local.files-destructive","fnos.system","fnos.file","fnos.app","fnos.docker","fnos.download","fnos.monitor","fnos.storage","fnos.user","fnos.photos","fnos.other"];
const TOOL_GROUP_DEFAULT_OPEN=new Set(["local.files","local.system"]);
let toolCatalog=[];
let toolFilterText="";
function toolGroupKey(item){
 const id=String(item.id||"");
 if(id.startsWith("fnos.")){const segment=id.slice(5).split(".")[0]||"other";return "fnos."+segment;}
 if(id.startsWith("files.")){if(item.risk==="destructive")return "local.files-destructive";if(item.risk==="write")return "local.files-write";return "local.files";}
 return "local.system";
}
function toolGroupRank(key){const index=TOOL_GROUP_ORDER.indexOf(key);return index<0?TOOL_GROUP_ORDER.length:index;}
function toolMatchesQuery(item,query){
 if(!query)return true;
 const haystack=[item.id,item.title,item.description].filter(Boolean).join(" ").toLowerCase();
 return haystack.indexOf(query)>=0;
}
function toolRiskBadge(item){
 const badge=document.createElement("span");
 badge.className="badge "+(item.risk==="write"?"badge--warn":item.risk==="destructive"?"badge--danger":"badge--ok");
 badge.textContent=item.risk==="write"?"常规写入":item.risk==="destructive"?"需要确认":"只读";
 return badge;
}
function buildToolForm(item){
 const schema=item.inputSchema||{},properties=schema.properties||{};
 const wrap=document.createElement("div");wrap.className="stack";
 const description=document.createElement("p");description.className="muted";description.textContent=item.description;wrap.append(description);
 const form=document.createElement("form");form.className="tool-args stack";
 for(const [name,rule] of Object.entries(properties)){
  const label=document.createElement("label");label.className="field";label.textContent=name+(rule.type==="integer"?"（整数）":"");label.htmlFor="tool-"+item.id.replace(/[^a-zA-Z0-9_-]/g,"-")+"-"+name;
  const input=document.createElement("input");input.className="input";input.id=label.htmlFor;input.name=name;input.type=rule.type==="integer"?"number":"text";input.autocomplete="off";
  if(rule.minLength!==undefined)input.minLength=rule.minLength;
  if(rule.maxLength!==undefined)input.maxLength=rule.maxLength;
  if(rule.minimum!==undefined)input.min=String(rule.minimum);
  if(rule.maximum!==undefined)input.max=String(rule.maximum);
  if(rule.type==="integer")input.step="1";
  input.required=(schema.required||[]).includes(name);
  input.placeholder=input.required?"必填":"可选";
  label.append(input);form.append(label);
 }
 const btn=document.createElement("button");btn.className="btn btn--primary";btn.type="submit";btn.textContent=item.risk==="write"?"执行文件操作":item.risk==="destructive"?"请通过助手请求确认":"运行只读查询";if(item.risk==="destructive")btn.disabled=true;if(item.providerAvailable===false){btn.disabled=true;btn.textContent="先安装官方 CLI";const availability=document.createElement("p");availability.className="muted";availability.textContent="此工具需要已审核、已安装并启用的官方 fnOS CLI；其他本地只读工具仍可使用。";wrap.append(availability);}form.append(btn);
 form.addEventListener("submit",async event=>{
  event.preventDefault();if(!form.reportValidity())return;
  const args={};
  for(const [name,rule] of Object.entries(properties)){
   const field=form.elements.namedItem(name);if(field.value==="")continue;
   args[name]=rule.type==="integer"?Number(field.value):field.value;
  }
  const out=document.querySelector("#tool-result");out.textContent="正在读取 "+item.id+"…";btn.disabled=true;
  try{const result=await api("/api/tools/"+encodeURIComponent(item.id)+"/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(args)});const payload=await result.json();if(!result.ok){out.textContent=(payload.error||"工具调用失败")+(payload.nextAction?"\n\n建议："+payload.nextAction:"");return;}out.textContent=formatOutputJson(payload.result);}
  catch(error){out.textContent=errorText(error,"工具调用失败");}
  finally{btn.disabled=false;if(item.id.startsWith("fnos."))await refreshAgentStatus();}
 });
 wrap.append(form);
 return wrap;
}
function buildToolEntry(item){
 const entry=document.createElement("details");entry.className="card card--flat";
 const summary=document.createElement("summary");summary.className="card__head";
 const title=document.createElement("h4");title.className="card__title";title.textContent=item.title||item.id;
 const meta=document.createElement("p");meta.className="card__sub row row--wrap";
 const idEl=document.createElement("code");idEl.className="mono";idEl.textContent=item.id;
 meta.append(idEl,toolRiskBadge(item));
 summary.append(title,meta);
 entry.append(summary);
 const body=document.createElement("div");body.className="card__body";
 entry.append(body);
 let rendered=false;
 entry.addEventListener("toggle",()=>{
  if(!entry.open||rendered)return;
  rendered=true;
  body.append(buildToolForm(item));
 });
 return entry;
}
function renderToolGroups(){
 const host=document.querySelector("#tool-list");if(!host)return;
 host.replaceChildren();
 const query=toolFilterText;
 const matched=toolCatalog.filter(item=>toolMatchesQuery(item,query));
 const groups=new Map();
 for(const item of matched){
  const key=toolGroupKey(item);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(item);
 }
 const keys=Array.from(groups.keys()).sort((a,b)=>toolGroupRank(a)-toolGroupRank(b));
 for(const key of keys){
  const items=groups.get(key);
  const group=document.createElement("details");group.className="card card--flat";
  if(query||TOOL_GROUP_DEFAULT_OPEN.has(key))group.open=true;
  const summary=document.createElement("summary");summary.className="card__head";
  const title=document.createElement("h3");title.className="card__title";title.textContent=TOOL_GROUP_LABELS[key]||key;
  const sub=document.createElement("p");sub.className="card__sub";sub.textContent=items.length+" 个工具";
  summary.append(title,sub);
  group.append(summary);
  const body=document.createElement("div");body.className="card__body";
  for(const item of items)body.append(buildToolEntry(item));
  group.append(body);
  host.append(group);
 }
 if(!matched.length){const p=document.createElement("p");p.className="muted";p.textContent=query?"没有匹配的工具":"没有可用工具";host.append(p);}
 setText("#tool-count",toolCatalog.length?"共 "+toolCatalog.length+" 个工具，匹配 "+matched.length+" 个":"没有可用工具");
}
function ensureToolSearchBox(){
 const host=document.querySelector("#tool-list");if(!host)return null;
 const parent=host.parentElement;if(!parent)return null;
 let input=document.querySelector("#tool-search");
 if(!input){
  const field=document.createElement("div");field.className="field";
  const label=document.createElement("label");label.className="field__label";label.htmlFor="tool-search";label.textContent="搜索工具";
  input=document.createElement("input");input.className="input";input.id="tool-search";input.type="search";input.placeholder="搜索工具 ID、标题或描述";input.autocomplete="off";
  const hint=document.createElement("p");hint.className="field__hint";hint.id="tool-count";hint.textContent="";
  field.append(label,input,hint);
  parent.insertBefore(field,host);
  input.addEventListener("input",debounce(()=>{toolFilterText=input.value.trim().toLowerCase();renderToolGroups();},180));
 }
 return input;
}
async function refreshTools(){
 const host=document.querySelector("#tool-list");if(!host)return;
 host.replaceChildren();
 ensureToolSearchBox();
 try{
  const r=await api("/api/tools");const data=await r.json();if(!r.ok)throw Error(data.error||"工具清单读取失败");
  toolCatalog=Array.isArray(data.tools)?data.tools:[];
  renderToolGroups();
 }catch(error){const p=document.createElement("p");p.className="error";p.textContent=errorText(error,"工具清单读取失败");host.append(p);}
}

let skillPageOffset=0;
const selectedSkillIds=new Set();
function updateSkillSelectionUi(){document.querySelector("#skill-selected-count").textContent="已选择 "+selectedSkillIds.size+" 个";document.querySelector("#skill-batch-apply").disabled=selectedSkillIds.size===0;}
async function refreshSkills(){
 const host=document.querySelector("#skill-list");host.replaceChildren();
 try{
  const params=new URLSearchParams({limit:"50",offset:String(skillPageOffset)});
  const q=document.querySelector("#skill-search").value.trim(),state=document.querySelector("#skill-state-filter").value;
  if(q)params.set("q",q);if(state)params.set("state",state);
  const r=await api("/api/skills?"+params.toString());if(!r.ok)throw Error("Skill 列表读取失败（HTTP "+r.status+"）");
  const data=await r.json();
  document.querySelector("#skill-count").textContent="匹配 "+data.total+" 个；显示第 "+(data.total?skillPageOffset+1:0)+"–"+Math.min(skillPageOffset+data.skills.length,data.total)+" 个";
  document.querySelector("#skill-page-prev").disabled=skillPageOffset<=0;
  document.querySelector("#skill-page-next").disabled=skillPageOffset+data.limit>=data.total;
  if(!data.skills.length){const p=document.createElement("p");p.className="muted";p.textContent="没有匹配的 Skill 记录";host.append(p);return;}
  for(const item of data.skills){
   const card=document.createElement("div");card.className="card";
   const pickLabel=document.createElement("label");const pick=document.createElement("input");pick.type="checkbox";pick.checked=selectedSkillIds.has(item.id);pick.dataset.skillId=item.id;pick.setAttribute("aria-label","选择 "+item.name);pick.addEventListener("change",()=>{if(pick.checked)selectedSkillIds.add(item.id);else selectedSkillIds.delete(item.id);updateSkillSelectionUi();});pickLabel.append(pick,document.createTextNode(" 选择此 Skill"));card.append(pickLabel);
   const title=document.createElement("strong");title.textContent=item.name+" · "+item.state;card.append(title);
   const meta=document.createElement("p");meta.className="muted";meta.textContent="版本："+(item.version||"未填写")+"；SHA-256："+item.archiveSha256+(item.quarantineFile?"；隔离归档："+formatBytes(item.archiveSizeBytes)+" / "+item.archiveEntryCount+" 个条目":"；仅登记元数据");card.append(meta);
   if(item.manifestReview){const review=document.createElement("p");review.className=item.manifestReview.findings?.length?"warning":"muted";review.textContent="静态清单："+(item.manifestReview.name||"未识别名称")+"；"+(item.manifestReview.description||"无描述")+"；源码扫描 "+(item.manifestReview.sourceFilesScanned||0)+" 个 / "+formatBytes(item.manifestReview.sourceBytesScanned||0)+(item.manifestReview.sourceReviewIncomplete?"（部分源码未扫描）":"")+"；发现："+((item.manifestReview.findings||[]).join("、")||"未发现规则提示")+"。此结果仅供人工审核，不代表安全认证。";card.append(review);}if(item.packageReview&&typeof item.packageReview==="object"){const pack=document.createElement("p");pack.className=item.packageReview.status==="ok"?"muted":"warning";const verdict=item.packageReview.status==="ok"?"结构完整":item.packageReview.status==="incomplete"?"结构不完整":"结构不可用";const parts=["references "+(item.packageReview.references||0),"scripts "+(item.packageReview.scripts||0),"tests "+(item.packageReview.tests||0)];const rules=(item.packageReview.findings||[]).map(entry=>entry.rule).filter(Boolean);if(rules.length)parts.push("问题："+rules.join("、"));pack.textContent="包结构："+verdict+"；"+parts.join("；")+"。";card.append(pack);}
   if(item.reviewNote){const note=document.createElement("p");note.textContent="审核备注："+item.reviewNote;card.append(note);}
   if(item.quarantineFile){
    const sourceDetails=document.createElement("details");
    const sourceSummary=document.createElement("summary");sourceSummary.textContent="只读查看隔离源码";sourceDetails.append(sourceSummary);
    const sourceNote=document.createElement("p");sourceNote.className="muted";sourceNote.textContent="以纯文本预览归档内的受支持文件，单文件上限 64 KiB；不会解压到磁盘或执行。预览内容仅显示在当前页面。";sourceDetails.append(sourceNote);
    const sourceLoad=document.createElement("button");sourceLoad.type="button";sourceLoad.textContent="加载文件清单";sourceDetails.append(sourceLoad);
    const sourceSelectLabel=document.createElement("label");sourceSelectLabel.textContent="选择要预览的归档文件";
    const sourceSelect=document.createElement("select");sourceSelect.disabled=true;sourceSelectLabel.append(sourceSelect);sourceDetails.append(sourceSelectLabel);
    const sourcePreviewButton=document.createElement("button");sourcePreviewButton.type="button";sourcePreviewButton.textContent="预览选中文件";sourcePreviewButton.disabled=true;sourceDetails.append(sourcePreviewButton);
    const sourceStatus=document.createElement("p");sourceStatus.className="muted";sourceStatus.setAttribute("role","status");sourceStatus.textContent="文件清单尚未加载。";sourceDetails.append(sourceStatus);
    const sourceMeta=document.createElement("p");sourceMeta.className="muted";sourceDetails.append(sourceMeta);
    const sourceOutput=document.createElement("pre");sourceOutput.className="skill-source-preview";sourceOutput.style.whiteSpace="pre-wrap";sourceOutput.style.overflowWrap="anywhere";sourceOutput.style.maxHeight="28rem";sourceOutput.style.overflow="auto";sourceOutput.textContent="";sourceDetails.append(sourceOutput);
    sourceLoad.addEventListener("click",async()=>{
     sourceLoad.disabled=true;sourceStatus.textContent="正在检查隔离归档…";sourceOutput.textContent="";sourceMeta.textContent="";
     try{
      const response=await api("/api/skills/"+encodeURIComponent(item.id)+"/source-files?limit=100"),data=await response.json();
      if(!response.ok)throw Error(data.error||"读取源文件清单失败");
      sourceSelect.replaceChildren();
      for(const file of data.files||[]){
       const option=document.createElement("option");option.value=file.path;option.textContent=file.path+" · "+formatBytes(file.sizeBytes)+(file.previewable?"":" · 超出预览上限");option.disabled=!file.previewable;sourceSelect.append(option);
      }
      const available=(data.files||[]).some(file=>file.previewable);
      sourceSelect.disabled=!available;sourcePreviewButton.disabled=!available;
      sourceStatus.textContent="找到 "+data.total+" 个可识别的文本/源码文件；单文件预览上限 "+formatBytes(data.maxPreviewBytes)+"。"+(data.total>data.files.length?" 当前显示 "+data.files.length+" 项。":"");
      if(!available)sourceStatus.textContent+=" 没有可预览的文件。";
     }catch(error){sourceStatus.className="error";sourceStatus.textContent=errorText(error,"读取源文件清单失败");}
     finally{sourceLoad.disabled=false;}
    });
    sourcePreviewButton.addEventListener("click",async()=>{
     const path=sourceSelect.value;if(!path)return;
     sourcePreviewButton.disabled=true;sourceStatus.className="muted";sourceStatus.textContent="正在读取选中文件…";sourceOutput.textContent="";sourceMeta.textContent="";
     try{
      const response=await api("/api/skills/"+encodeURIComponent(item.id)+"/source-preview?path="+encodeURIComponent(path)),data=await response.json();
      if(!response.ok)throw Error(data.error||"源码预览失败");
      sourceMeta.textContent=data.path+" · "+formatBytes(data.bytes);
      sourceOutput.textContent=data.content;
      sourceStatus.textContent=data.note||"已读取隔离归档文本。";
     }catch(error){sourceStatus.className="error";sourceStatus.textContent=errorText(error,"源码预览失败");}
     finally{sourcePreviewButton.disabled=false;}
    });
    card.append(sourceDetails);
   }
   const officialPackage=item.manifestReview?.reviewedBy==="server"&&item.manifestReview?.name?.toLowerCase()==="fnos"&&item.manifestReview?.archiveSha256===item.archiveSha256;
   if(officialPackage){
    const badge=document.createElement("span");badge.className="badge badge--ok";badge.textContent="官方 fnOS 包";card.append(badge);
   }
   if(officialPackage&&item.quarantineFile&&["approved","enabled"].includes(item.state)){
    const install=document.createElement("button");install.type="button";install.textContent="安装官方 CLI（当前平台）";
    install.addEventListener("click",async()=>{if(!(await confirmAction("仅提取官方 Skill 包中与当前 Linux 架构匹配的 trim-cli 二进制；不会解压其他文件，也不会执行 Skill 指令。继续安装？")))return;install.disabled=true;try{const ir=await api("/api/skills/"+item.id+"/install-cli",{method:"POST"});const result=await ir.json();if(!ir.ok)throw Error(result.error||"CLI 安装失败");showToast("CLI 已安装："+result.installation.platform+"，"+formatBytes(result.installation.sizeBytes)+"。请启用 Skill 后再使用官方只读工具。","ok");await refreshSkills();}catch(error){document.querySelector("#skill-error").textContent=errorText(error,"CLI 安装失败");}finally{install.disabled=false;}});
    card.append(install);
   }
   const choices={pending_review:[["approved","批准"],["rejected","拒绝"]],approved:[["enabled","启用"],["disabled","停用"],["rejected","拒绝"]],enabled:[["disabled","停用"]],disabled:[["approved","重新批准"],["rejected","拒绝"]],rejected:[]};
   for(const [state,label] of (choices[item.state]||[])){
    const btn=document.createElement("button");btn.type="button";btn.textContent=label;
    btn.addEventListener("click",async()=>{const note=(await promptAction("填写审核备注（可留空）",""))||"";try{const tr=await api("/api/skills/"+item.id+"/transition",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({state,note})});const result=await tr.json();if(!tr.ok)throw Error(result.error||"状态更新失败");await refreshSkills();}catch(e){document.querySelector("#skill-error").textContent=errorText(e,"状态更新失败");}});
    card.append(btn);
   }
   if(item.state==="rejected"){
    const remove=document.createElement("button");remove.type="button";remove.textContent="彻底移除";
    remove.addEventListener("click",async()=>{if(!(await confirmAction("确定移除已拒绝的 Skill 记录及其隔离 ZIP（如果没有其他记录引用）？此操作不可撤销。")))return;remove.disabled=true;try{const rr=await api("/api/skills/"+item.id,{method:"DELETE"});const result=await rr.json();if(!rr.ok)throw Error(result.error||"移除失败");await refreshSkills();document.querySelector("#skill-error").textContent=result.archiveRemoved?"Skill 记录和隔离归档已移除。":"Skill 记录已移除。";}catch(e){remove.disabled=false;document.querySelector("#skill-error").textContent=errorText(e,"移除失败");}});
    card.append(remove);
   }
   host.append(card);
  }
 }catch(e){const p=document.createElement("p");p.className="error";p.textContent=errorText(e,"Skill 列表读取失败");host.append(p);}
}
document.querySelector("#skill-select-visible").addEventListener("change",event=>{
 for(const checkbox of document.querySelectorAll("#skill-list input[type=checkbox][data-skill-id]")){if(event.target.checked)selectedSkillIds.add(checkbox.dataset.skillId);else selectedSkillIds.delete(checkbox.dataset.skillId);}
 updateSkillSelectionUi();
});
document.querySelector("#skill-batch-apply").addEventListener("click",async()=>{
 const ids=[...selectedSkillIds];if(!ids.length)return;
 const state=document.querySelector("#skill-batch-state").value;
 if(state==="rejected"&&!(await confirmAction("批量拒绝所选 Skill？拒绝后的记录不能重新启用。")))return;
 const button=document.querySelector("#skill-batch-apply");button.disabled=true;button.textContent="处理中…";
 try{
  const response=await api("/api/skills/transitions/batch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:ids.map(id=>({id,state,note:document.querySelector("#skill-batch-note").value}))})});
  const payload=await response.json();if(!response.ok)throw Error(payload.error||"批量审核失败");
  for(const result of payload.results||[])if(result.ok)selectedSkillIds.delete(result.id);
  document.querySelector("#skill-error").textContent="批量处理完成：成功 "+payload.succeeded+" 个，失败 "+payload.failed+" 个。失败项仍保留选择，可调整状态后重试。";
  await refreshSkills();
 }catch(error){document.querySelector("#skill-error").textContent=errorText(error,"批量审核失败");}
 finally{button.textContent="执行批量变更";updateSkillSelectionUi();}
});
document.querySelector("#skill-filter-apply").addEventListener("click",()=>{skillPageOffset=0;refreshSkills();});
document.querySelector("#skill-search").addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();skillPageOffset=0;refreshSkills();}});
document.querySelector("#skill-state-filter").addEventListener("change",()=>{skillPageOffset=0;refreshSkills();});
document.querySelector("#skill-page-prev").addEventListener("click",()=>{skillPageOffset=Math.max(0,skillPageOffset-50);refreshSkills();});
document.querySelector("#skill-page-next").addEventListener("click",()=>{skillPageOffset+=50;refreshSkills();});
let activeSkillUploadXhr=null;
function uploadSkillArchive(url,file,headers,onProgress,onXhr){
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();onXhr(xhr);xhr.open("POST",url,true);xhr.withCredentials=true;
  for(const [name,value] of Object.entries(headers))xhr.setRequestHeader(name,value);
  xhr.upload.addEventListener("progress",event=>{if(event.lengthComputable)onProgress(Math.max(0,Math.min(100,Math.round(event.loaded/event.total*100))));});
  xhr.addEventListener("load",()=>{let payload={};try{payload=JSON.parse(xhr.responseText||"{}");}catch{}if(xhr.status>=200&&xhr.status<300)resolve(payload);else reject(new Error(payload.error||"导入失败（HTTP "+xhr.status+"）"));});
  xhr.addEventListener("error",()=>reject(new Error("上传连接失败，请检查网络后重试。")));
  xhr.addEventListener("abort",()=>reject(new Error("已取消 Skill ZIP 上传。")));
  xhr.send(file);
 });
}
document.querySelector("#skill-import-form").addEventListener("submit",async e=>{
 e.preventDefault();const err=document.querySelector("#skill-error"),button=document.querySelector("#skill-import-submit"),progress=document.querySelector("#skill-import-progress"),status=document.querySelector("#skill-import-status"),cancel=document.querySelector("#skill-import-cancel");err.textContent="";
 const files=Array.from(document.querySelector("#skill-archive").files||[]);if(!files.length){err.textContent="请选择一个或多个 ZIP 文件";return;}
 const oversized=files.find(file=>file.size>25*1024*1024);if(oversized){err.textContent="文件“"+oversized.name+"”超过 25 MiB，未开始上传";return;}
 const baseName=document.querySelector("#import-skill-name").value.trim();
 const version=document.querySelector("#import-skill-version").value;
 const source=document.querySelector("#import-skill-source").value;
 const results=[];let completed=0;
 button.disabled=true;cancel.disabled=false;progress.classList.remove("hidden");progress.value=0;
 try{
  for(let index=0;index<files.length;index++){
   const file=files[index],suffix=file.name.replace(/\.zip$/i,"").slice(0,70);
   const skillName=files.length===1?baseName:(baseName+" - "+suffix).slice(0,100);
   const headers={"content-type":"application/zip","x-skill-name":skillName,"x-skill-version":version,"x-skill-source":source};
   status.textContent="正在上传第 "+(index+1)+" / "+files.length+" 个 Skill ZIP： "+file.name+"（0%）";
   const result=await uploadSkillArchive("/api/skills/import",file,headers,percent=>{progress.value=Math.round(((index+percent/100)/files.length)*100);status.textContent="正在上传第 "+(index+1)+" / "+files.length+" 个 Skill ZIP： "+file.name+"（"+percent+"%）";},xhr=>{activeSkillUploadXhr=xhr;});
   results.push(result.skill);completed++;progress.value=Math.round(completed/files.length*100);
    if(result.skill&&result.skill.archiveSha256){const hashEl=document.querySelector("#skill-hash");if(hashEl&&!hashEl.value)hashEl.value=result.skill.archiveSha256;}
  }
  e.target.reset();await refreshSkills();status.textContent="已隔离 "+completed+" 个归档；尚未解压或执行。";
  showToast("已隔离 "+completed+" 个 Skill ZIP；尚未解压或执行。","ok");
 }catch(error){
  err.textContent=(error.message||"导入失败")+(completed?"；此前已成功隔离 "+completed+" 个归档，请刷新列表核对。":"");
  status.textContent="处理停止：已完成 "+completed+" / "+files.length+" 个。";
  if(completed)await refreshSkills();
 }finally{activeSkillUploadXhr=null;button.disabled=false;cancel.disabled=true;}
});
document.querySelector("#skill-remote-import-form").addEventListener("submit",async e=>{
 e.preventDefault();
 const button=document.querySelector("#skill-remote-import-submit"),status=document.querySelector("#skill-remote-import-status");
 button.disabled=true;status.className="muted";status.textContent="正在解析 GitHub 仓库并下载 ZIP…";
 try{
  const body={url:document.querySelector("#skill-remote-url").value.trim(),name:document.querySelector("#skill-remote-name").value.trim(),version:document.querySelector("#skill-remote-version").value.trim()};
  const response=await api("/api/skills/import-remote",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw Error(result.error||"GitHub Skill 导入失败");
  e.target.reset();await refreshSkills();
  status.textContent="已隔离 "+result.repository+(result.branch?" · "+(result.refType==="tags"?"标签 ":"分支 ")+result.branch:"")+"（"+formatBytes(result.archiveBytes)+"）"+(result.commitSha?" · commit "+result.commitSha.slice(0,12):"")+"；尚未解压或执行，请在列表中审核。";
 }catch(error){status.className="error";status.textContent=errorText(error,"GitHub Skill 导入失败");}
 finally{button.disabled=false;}
});
document.querySelector("#skill-remote-batch-form").addEventListener("submit",async e=>{
 e.preventDefault();
 const button=document.querySelector("#skill-remote-batch-submit"),status=document.querySelector("#skill-remote-batch-status");
 const urls=document.querySelector("#skill-remote-batch-urls").value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
 if(!urls.length||urls.length>5){status.className="error";status.textContent="请填写 1 到 5 个 GitHub 地址，每行一个。";return;}
 button.disabled=true;status.className="muted";status.textContent="正在按顺序解析、固定 commit 并下载；总大小不超过 25 MiB…";
 try{
  const version=document.querySelector("#skill-remote-batch-version").value.trim();
  const response=await api("/api/skills/import-remote-batch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:urls.map(url=>({url,version}))})});
  const result=await response.json();if(!response.ok)throw Error(result.error||"批量 Skill 导入失败");
  await refreshSkills();
  const lines=(result.results||[]).map(item=>item.index+". "+(item.ok?"成功：":"失败：")+(item.skill?.name||item.repository||"此项目")+" — "+(item.ok?("commit "+(item.commitSha||"未知").slice(0,12)+"，"+formatBytes(item.archiveBytes)+"，状态 "+item.skill.state):item.error));
  status.textContent="批量结束：成功 "+result.importedCount+" / "+result.total+"，失败或跳过 "+result.failedCount+"；累计下载 "+formatBytes(result.downloadedBytes)+"。\n"+lines.join("\n");
  if(result.importedCount>0)e.target.reset();
 }catch(error){status.className="error";status.textContent=errorText(error,"批量 Skill 导入失败");}
 finally{button.disabled=false;}
});
document.querySelector("#skill-import-cancel").addEventListener("click",()=>{if(activeSkillUploadXhr){document.querySelector("#skill-import-cancel").disabled=true;activeSkillUploadXhr.abort();}});

document.querySelector("#skill-form").addEventListener("submit",async e=>{
 e.preventDefault();const err=document.querySelector("#skill-error");err.textContent="";
 try{
  const body={name:document.querySelector("#skill-name").value,version:document.querySelector("#skill-version").value,archiveSha256:document.querySelector("#skill-hash").value,sourceLabel:document.querySelector("#skill-source").value};
  const r=await api("/api/skills",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const result=await r.json();if(!r.ok)throw Error(result.error||"登记失败");
  e.target.reset();await refreshSkills();
 }catch(error){err.textContent=errorText(error,"登记失败");}
});

let auditOffset=0;
/* ------------------------------------------------------------------ *
 * 执行模式控制台的版本降级：
 * 旧服务端没有 /api/health 的 executionMode 字段，也没有 /api/execution-mode 接口，
 * 此时隐藏控制区并给出说明，避免按钮点了没反应。
 * ------------------------------------------------------------------ */
const EXECUTION_MODE_UNSUPPORTED_TEXT="当前服务端版本不支持在线切换执行模式";
function setExecutionModeConsoleVisible(visible){
 const modeEl=document.querySelector("#execution-mode");
 const applyEl=document.querySelector("#execution-mode-apply");
 const row=applyEl&&applyEl.parentElement?applyEl.parentElement:null;
 const label=modeEl?document.querySelector('label[for="execution-mode"]'):null;
 for(const el of [label,row]){
  if(!el)continue;
  el.classList.toggle("hidden",!visible);
  el.hidden=!visible;
  el.style.display=visible?"":"none";
 }
 if(!visible){
  const statusEl=document.querySelector("#execution-mode-status");
  if(statusEl)statusEl.textContent=EXECUTION_MODE_UNSUPPORTED_TEXT;
 }
}
document.querySelector("#execution-mode-apply").addEventListener("click",async()=>{const el=document.querySelector("#execution-mode"),st=document.querySelector("#execution-mode-status");if(!el||!st)return;st.textContent="正在切换…";try{const r=await api("/api/execution-mode",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mode:el.value})});if(r.status===404||r.status===405){setExecutionModeConsoleVisible(false);return;}let x={};try{x=await r.json();}catch(e){}if(!r.ok)throw Error(x.error||"切换失败（HTTP "+r.status+"）");st.textContent="已切换执行模式。";await refresh();}catch(e){st.textContent=errorText(e,"切换失败");}});

async function refreshAudit(){
 const out=document.querySelector("#audit-output");out.classList.remove("hidden");out.textContent="正在读取操作记录…";
 try{
  const params=new URLSearchParams({limit:"20",offset:String(auditOffset)});
  const outcome=document.querySelector("#audit-outcome").value,route=document.querySelector("#audit-route").value.trim();
  if(outcome)params.set("outcome",outcome);if(route)params.set("route",route);
  const r=await api("/api/audit?"+params.toString());const data=await r.json();if(!r.ok)throw Error(data.error||"读取失败");
  document.querySelector("#audit-count").textContent="匹配 "+data.total+" 条 · 显示 "+(data.total?data.offset+1:0)+"–"+Math.min(data.offset+data.events.length,data.total);
  document.querySelector("#audit-prev").disabled=data.offset<=0;
  document.querySelector("#audit-next").disabled=data.offset+data.events.length>=data.total;
  out.textContent=data.events.length?data.events.map(e=>formatDateTime(e.at)+" · "+e.method+" "+e.route+" · "+e.statusCode+" · "+e.outcome).join("\n"):"暂无符合条件的操作记录";
 }catch(e){out.textContent=errorText(e,"读取操作记录失败");}
}
document.querySelector("#show-audit").addEventListener("click",()=>{
  if(currentRouteId()==="audit-card"){refreshAudit();return;}
  location.hash="#audit-card";
});
document.querySelector("#audit-apply").addEventListener("click",()=>{auditOffset=0;refreshAudit();});
document.querySelector("#audit-outcome").addEventListener("change",()=>{auditOffset=0;refreshAudit();});
document.querySelector("#audit-prev").addEventListener("click",()=>{auditOffset=Math.max(0,auditOffset-20);refreshAudit();});
document.querySelector("#audit-next").addEventListener("click",()=>{auditOffset+=20;refreshAudit();});
document.querySelector("#audit-route").addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();auditOffset=0;refreshAudit();}});

/* ------------------------------------------------------------------ *
 * 运行状态 / 安全巡检 / 模型用量（Phase 166 只读观察面）
 * 三个接口都是只读的：这里只读数据、只写文本，不改任何配置。
 * 渲染一律使用 textContent，不做 HTML 字符串拼接。
 * ------------------------------------------------------------------ */
const INSIGHT_SECTION_LABELS={ok:"正常",unknown:"未采集",unavailable:"接口不可用"};
function insightSectionLines(sections){
 if(!Array.isArray(sections)||!sections.length)return ["暂无数据。"];
 return sections.map(section=>{
  const title=section.title||section.id||"未命名段落";
  const status=INSIGHT_SECTION_LABELS[section.status]||section.status||"未知状态";
  const note=section.note?"："+section.note:"";
  const values=section.values&&typeof section.values==="object"
   ?Object.entries(section.values).slice(0,6).map(pair=>pair[0]+"="+String(pair[1])).join(" "):"";
  return "- "+title+"："+status+note+(values?"（"+values+"）":"");
 });
}
async function insightRead(path){
 try{
  const response=await api(path);
  if(!response.ok){
   const body=await response.json().catch(()=>({}));
   return {error:(body&&body.error)||("HTTP "+response.status)};
  }
  return await response.json();
 }catch(e){return {error:errorText(e,"读取失败")};}
}
async function refreshInsights(){
 const statusEl=document.querySelector("#insights-status");
 const systemEl=document.querySelector("#insights-system");
 const securityEl=document.querySelector("#insights-security");
 const usageEl=document.querySelector("#insights-usage");
 if(!systemEl||!securityEl||!usageEl)return;
 if(statusEl)statusEl.textContent="正在读取观察数据…";
 const results=await Promise.all([insightRead("/api/system/snapshot"),insightRead("/api/security/inspection"),insightRead("/api/models/usage")]);
 const snapshot=results[0],inspection=results[1],usage=results[2];
 if(snapshot&&snapshot.error){systemEl.textContent="读取失败："+snapshot.error;}
 else{
  const score=(snapshot&&snapshot.score)||{};
  const lines=["生成时间："+((snapshot&&snapshot.generatedAt)||"-"),
   "健康评分："+(typeof score.value==="number"?score.value:"-")+" 分（等级 "+(score.grade||"-")+" · 覆盖率 "+Math.round((Number(score.coverage)||0)*100)+"%）"]
   .concat(insightSectionLines(snapshot&&snapshot.sections));
  if(snapshot&&Array.isArray(snapshot.uncovered)&&snapshot.uncovered.length)
   lines.push("未覆盖项："+snapshot.uncovered.map(item=>item.id).join("、"));
  systemEl.textContent=lines.join("\n");
 }
 if(inspection&&inspection.error){securityEl.textContent="读取失败："+inspection.error;}
 else{
  const summary=(inspection&&inspection.summary)||{};
  const lines=["生成时间："+((inspection&&inspection.generatedAt)||"-"),
   "待处理：严重 "+(summary.critical||0)+" · 警告 "+(summary.warning||0)+" · 提示 "+(summary.info||0)+" · 合计 "+(summary.total||0)]
   .concat(insightSectionLines(inspection&&inspection.sections).map(line=>line.replace(/^-\s*/,"")));
  const permissions=inspection&&Array.isArray(inspection.toolPermissions)?inspection.toolPermissions:[];
  if(permissions.length)lines.push("工具权限表："+permissions.length+" 个工具");
  const audit=inspection&&inspection.auditSummary;
  if(audit)lines.push("审计摘要：共 "+(audit.total||0)+" 条 · 错误 "+(audit.errors||0)+" 条");
  securityEl.textContent=lines.join("\n");
 }
 if(usage&&usage.error){usageEl.textContent="读取失败："+usage.error;}
 else{
  const summary=(usage&&usage.summary)||{};
  const privacy=(usage&&usage.privacy)||{};
  const lines=["请求 "+(summary.requests||0)+" · 成功 "+(summary.ok||0)+" · 失败 "+(summary.error||0),
   "输入 token "+(summary.promptTokens||0)+" · 输出 token "+(summary.completionTokens||0)+" · 平均延迟 "+(summary.averageLatencyMs||0)+" ms",
   "本地请求 "+(summary.localRequests||0)+" · 云端请求 "+(summary.cloudRequests||0)+" · 计价："+(summary.priced?"已计价":"未计价（价格未知，不估算）"),
   "隐私模式："+(privacy.enabled?"已开启":"未开启")+"（enforced="+(privacy.enforced===true?"true":"false")+"）"];
  const models=usage&&Array.isArray(usage.byModel)?usage.byModel:[];
  if(models.length)for(const model of models.slice(0,8))lines.push("- "+model.provider+" / "+model.model+"："+model.requests+" 次 · 失败 "+model.error+" 次");
  usageEl.textContent=lines.join("\n");
 }
 if(statusEl)statusEl.textContent="已更新于 "+formatDateTime(new Date().toISOString());
}
document.querySelector("#insights-refresh").addEventListener("click",()=>{refreshInsights();});


/* ------------------------------------------------------------------ *
 * 概览页：工作流计划、运行手册与诊断证据（只读）。
 * 三个请求并行，任一失败只影响对应区块，不会让整页报错；
 * 渲染一律 textContent，不拼 HTML。
 * ------------------------------------------------------------------ */
async function refreshPlaybooks(){
 const statusEl=document.querySelector("#playbooks-status");
 const workflowEl=document.querySelector("#playbooks-workflows");
 const runbookEl=document.querySelector("#playbooks-runbooks");
 const evidenceEl=document.querySelector("#playbooks-evidence");
 if(!workflowEl||!runbookEl||!evidenceEl)return;
 if(statusEl)statusEl.textContent="正在读取工作流、运行手册与诊断证据…";
 const results=await Promise.all([
  insightRead("/api/workflows"),
  insightRead("/api/runbooks?limit=20"),
  insightRead("/api/diagnostics/evidence")
 ]);
 const workflows=results[0],runbooks=results[1],evidence=results[2];
 if(workflows&&workflows.error){workflowEl.textContent="读取失败："+workflows.error;}
 else{
  const list=workflows&&Array.isArray(workflows.workflows)?workflows.workflows:[];
  const lines=["工作流 "+list.length+" 个"];
  for(const item of list.slice(0,10))lines.push("- "+item.name+"（"+item.id+"）："+item.stepCount+" 步");
  if(!list.length)lines.push("尚未注册工作流计划。");
  workflowEl.textContent=lines.join("\n");
 }
 if(runbooks&&runbooks.error){runbookEl.textContent="读取失败："+runbooks.error;}
 else{
  const entries=runbooks&&Array.isArray(runbooks.entries)?runbooks.entries:[];
  const total=runbooks&&typeof runbooks.total==="number"?runbooks.total:entries.length;
  const lines=["运行手册 "+total+" 条"];
  for(const entry of entries.slice(0,10)){
   const tags=Array.isArray(entry.tags)&&entry.tags.length?" ["+entry.tags.join("、")+"]":"";
   lines.push("- "+entry.title+tags);
  }
  if(!total)lines.push("还没有写入运行手册。");
  runbookEl.textContent=lines.join("\n");
 }
 if(evidence&&evidence.error){evidenceEl.textContent="读取失败："+evidence.error;}
 else{
  const items=evidence&&Array.isArray(evidence.evidence)?evidence.evidence:[];
  const count=evidence&&typeof evidence.count==="number"?evidence.count:items.length;
  const bySource={};
  for(const item of items)bySource[item.source]=(bySource[item.source]||0)+1;
  const lines=["证据 "+count+" 条"];
  const sources=Object.entries(bySource).map(pair=>pair[0]+" "+pair[1]+" 条");
  if(sources.length)lines.push("来源："+sources.join(" · "));
  for(const item of items.slice(0,8))lines.push("- ["+item.source+"] "+item.detail);
  if(!count)lines.push("当前没有可用证据。");
  evidenceEl.textContent=lines.join("\n");
 }
 if(statusEl)statusEl.textContent="已更新于 "+formatDateTime(new Date().toISOString());
}
const playbooksRefreshBtn=document.querySelector("#playbooks-refresh");
if(playbooksRefreshBtn)playbooksRefreshBtn.addEventListener("click",()=>{refreshPlaybooks();});


/* ------------------------------------------------------------------ *
 * 概览页统计：优先用 /api/overview 一次性取回全部头条指标，
 * 快照不可用时（旧服务端没有该接口）回退到各个明细接口；
 * 存储始终来自 /api/diagnostics。
 * 每一块都独立容错，任何一个子请求失败都不影响其它统计块。
 * ------------------------------------------------------------------ */
function setStatText(valueId,hintId,value,hint){
  const valueEl=document.querySelector("#"+valueId);
  if(valueEl)valueEl.textContent=value===null||value===undefined?"":String(value);
  const hintEl=document.querySelector("#"+hintId);
  if(hintEl)hintEl.textContent=hint===null||hint===undefined?"":String(hint);
}
async function loadOverviewHealth(){
  try{
    const r=await api("/api/health");
    if(!r.ok)return null;
    const h=await r.json();
    return h&&typeof h==="object"?h:null;
  }catch(e){return null;}
}
async function loadOverviewSnapshot(){
  try{
    const r=await api("/api/overview");
    if(!r.ok)return null;
    const x=await r.json();
    return x&&x.health?x:null;
  }catch(e){return null;}
}
async function loadOverviewTasks(){
  try{
    const r=await api("/api/tasks/status");
    if(!r.ok)return null;
    const x=await r.json();
    return {queued:Number(x.queued)||0,running:Number(x.running)||0};
  }catch(e){return null;}
}
async function loadOverviewModels(){
  try{
    const r=await api("/api/models");
    if(!r.ok)return null;
    const x=await r.json();
    const providers=Array.isArray(x.providers)?x.providers:[];
    return {providerCount:providers.length,hasDefaultProvider:providers.some(item=>item&&item.isDefault)||Boolean(x.activeProviderId)};
  }catch(e){return null;}
}
async function loadOverviewSkills(){
  try{
    const r=await api("/api/skills?limit=1");
    if(!r.ok)return null;
    const x=await r.json();
    return {skillTotal:Number(x.total)||0};
  }catch(e){return null;}
}
async function loadOverviewStorage(){
  try{
    const r=await api("/api/diagnostics");
    if(!r.ok)return null;
    const x=await r.json();
    const storage=Array.isArray(x.storage)&&x.storage.length?x.storage[0]:null;
    if(!storage)return null;
    return {used:formatBytes(storage.usedBytes),total:formatBytes(storage.totalBytes)};
  }catch(e){return null;}
}
async function refreshOverviewStats(){
  const stats={ok:null,version:"",degraded:false,degradedComponents:[],mode:"",modeSource:"",modeSupported:false,healthKnown:false,queued:0,running:0,providerCount:0,hasDefaultProvider:false,skillTotal:0};
  const storagePromise=loadOverviewStorage();
  const snapshot=await loadOverviewSnapshot();
  if(snapshot){
    const h=snapshot.health||{};
    stats.healthKnown=true;
    stats.ok=h.ok!==false;
    stats.degraded=Boolean(h.degraded);
    stats.degradedComponents=Array.isArray(h.degradedComponents)?h.degradedComponents:[];
    if(snapshot.app&&snapshot.app.version)stats.version=snapshot.app.version;
    const execution=snapshot.execution||{};
    if(execution.mode){stats.mode=execution.mode;stats.modeSupported=true;}
    if(execution.source)stats.modeSource=execution.source;
    const tasks=snapshot.tasks||{};
    stats.queued=Number(tasks.queued)||0;
    stats.running=Number(tasks.running)||0;
    const models=snapshot.models||{};
    stats.providerCount=Number(models.providerCount)||0;
    stats.hasDefaultProvider=Boolean(models.activeProviderId)||Boolean(models.enabled);
    const skills=snapshot.skills||{};
    stats.skillTotal=Number(skills.total)||0;
  }else{
    // 概览快照不可用（旧服务端没有 /api/overview）时回退到各个明细接口。
    // 四个请求互相独立，任一失败都不会影响其它统计块。
    const [health,tasks,models,skills]=await Promise.allSettled([loadOverviewHealth(),loadOverviewTasks(),loadOverviewModels(),loadOverviewSkills()]);
    if(health.status==="fulfilled"&&health.value){
      const h=health.value;
      stats.healthKnown=true;
      stats.ok=h.ok!==false;
      stats.version=h.version||"";
      stats.degraded=Boolean(h.degraded);
      stats.degradedComponents=Array.isArray(h.degradedComponents)?h.degradedComponents:[];
      stats.mode=h.executionMode||"";
      stats.modeSource=h.executionModeSource||"";
      stats.modeSupported=typeof h.executionMode==="string"&&h.executionMode!=="";
    }
    if(tasks.status==="fulfilled"&&tasks.value){stats.queued=tasks.value.queued;stats.running=tasks.value.running;}
    if(models.status==="fulfilled"&&models.value){stats.providerCount=models.value.providerCount;stats.hasDefaultProvider=models.value.hasDefaultProvider;}
    if(skills.status==="fulfilled"&&skills.value)stats.skillTotal=skills.value.skillTotal;
  }
  const storage=await storagePromise;
  if(storage)setStatText("stat-storage","stat-storage-hint",storage.used,"总容量 "+storage.total);
  if(stats.ok!==null){
    setStatText("stat-service","stat-service-hint",stats.ok?"运行正常":"状态异常","版本 "+(stats.version||"—"));
    const connectionPill=document.querySelector("#connection-pill");
    const connectionText=document.querySelector("#connection-text");
    if(connectionText)connectionText.textContent=stats.ok?"已连接":"连接异常";
    if(connectionPill){connectionPill.classList.remove("pill--ok","pill--warn","pill--danger","pill--neutral");connectionPill.classList.add(stats.ok?"pill--ok":"pill--danger");}
  }
  const modeEl=document.querySelector("#execution-mode");
  const fallbackMode=modeEl&&modeEl.value?modeEl.value:"";
  const mode=stats.mode||fallbackMode;
  const modeLabel={normal:"正常","read-only":"只读",halted:"停机"}[mode]||mode||"未知";
  setStatText("stat-mode","stat-mode-hint",modeLabel,"来源："+(stats.modeSource||"default"));
  const modeText=document.querySelector("#mode-pill-text");
  if(modeText)modeText.textContent=modeLabel;
  // 旧服务端没有执行模式接口：隐藏控制区并说明原因。
  if(stats.healthKnown&&!stats.modeSupported)setExecutionModeConsoleVisible(false);
  else if(stats.healthKnown)setExecutionModeConsoleVisible(true);
  const banner=document.querySelector("#degraded-banner");
  const list=document.querySelector("#degraded-list");
  if(stats.degraded){
    if(banner){banner.hidden=false;banner.classList.remove("hidden");}
    if(list){
      const components=stats.degradedComponents;
      list.textContent=components.length?"降级组件："+components.join("、"):"部分能力处于降级状态，请查看下方诊断信息。";
    }
  }else{
    if(banner){banner.hidden=true;banner.classList.add("hidden");}
    if(list)list.textContent="";
  }
  setStatText("stat-tasks","stat-tasks-hint",String(stats.queued+stats.running),"排队 "+stats.queued+" · 运行 "+stats.running);
  setStatText("stat-models","stat-models-hint",String(stats.providerCount),stats.hasDefaultProvider?"已配置默认服务商":"尚未设置默认服务商");
  setStatText("stat-skills","stat-skills-hint",String(stats.skillTotal),"已登记 Skill");
}


/* ------------------------------------------------------------------ *
 * 知识库与通知中心（Phase 179 的页面层接线）
 *
 * 两个 ES module（/ui/knowledge-panel.js、/ui/notifications.js）把纯函数与
 * 渲染函数挂到 window.KnowledgePanel / window.Notifications；它们在
 * DOMContentLoaded 之后才可能有 window 对象，因此这里不假设已就绪，
 * 由 knowledge-panel-ready / notifications-ready 事件触发首次渲染。
 *
 * 数据只经 GET 接口读取；所有文本交给渲染函数用 textContent 写入，
 * 本文件不拼 HTML。任一接口失败只让本区块显示错误，不影响其它页面。
 * ------------------------------------------------------------------ */
const knowledgePageState={
 entries:[],
 view:null,
 query:"",
 source:"",
 loaded:false
};
const notificationPageState={
 items:[],
 summary:null,
 filter:{},
 readIds:[],
 loaded:false
};

function setKnowledgeStatus(text){
 const node=document.querySelector("#knowledge-status");
 if(node)node.textContent=text;
}
function setNotifyStatus(text){
 const node=document.querySelector("#notify-status");
 if(node)node.textContent=text;
}

async function refreshKnowledgePanel(){
 const lib=window.KnowledgePanel,container=document.querySelector("#knowledge-panel");
 if(!lib||!container){setKnowledgeStatus("知识库面板尚未就绪。");return;}
 setKnowledgeStatus("正在读取知识库…");
 try{
  const params=new URLSearchParams();
  const keyword=knowledgePageState.query.trim();
  if(keyword)params.set("q",keyword);
  if(knowledgePageState.source)params.set("source",knowledgePageState.source);
  const suffix=params.toString();
  const response=await api("/api/knowledge"+(suffix?"?"+suffix:""));
  const payload=await response.json();
  if(!response.ok)throw Error(payload.error||"知识库读取失败");
  const entries=Array.isArray(payload.entries)?payload.entries:[];
  knowledgePageState.entries=entries;
  knowledgePageState.view=lib.buildKnowledgeView(entries);
  lib.renderKnowledgePanel(container,knowledgePageState.view);
  const total=Number.isFinite(payload.total)?payload.total:entries.length;
  setKnowledgeStatus(entries.length?"已加载 "+entries.length+" 条，共 "+total+" 条。":"没有匹配的知识条目。");
  knowledgePageState.loaded=true;
 }catch(error){
  knowledgePageState.view=null;
  lib.renderKnowledgePanel(container,null);
  setKnowledgeStatus(error&&error.message?error.message:"知识库读取失败");
 }
}

async function refreshAppInventory(){
 const lib=window.KnowledgePanel,container=document.querySelector("#app-inventory");
 if(!lib||!container)return;
 try{
  const response=await api("/api/system/snapshot");
  const snapshot=await response.json();
  if(!response.ok)throw Error(snapshot.error||"系统快照读取失败");
  lib.renderAppInventory(container,lib.buildAppInventoryView(snapshot));
 }catch(error){
  lib.renderAppInventory(container,null);
 }
}

async function refreshNotifications(){
 const lib=window.Notifications,container=document.querySelector("#notification-center");
 if(!lib||!container){setNotifyStatus("通知中心尚未就绪。");return;}
 setNotifyStatus("正在汇总通知…");
 // 三路事件各自失败都不该让通知中心整体空白，因此用 allSettled。
 const [exceptions,approvals,tasks]=await Promise.allSettled([
  api("/api/audit?outcome=error&limit=20").then(r=>r.json()),
  api("/api/actions/pending").then(r=>r.json()),
  api("/api/tasks?limit=20").then(r=>r.json())
 ]);
 const sources={
  exceptions:exceptions.status==="fulfilled"&&Array.isArray(exceptions.value.entries)
   ?exceptions.value.entries.map(entry=>({
    id:"audit:"+(entry.at||"")+":"+(entry.route||""),
    type:"exception",
    title:(entry.route||"接口")+" 返回 HTTP "+(entry.statusCode||"?"),
    detail:entry.method||"",
    at:entry.at||"",
    source:"audit"
   }))
   :[],
  approvals:approvals.status==="fulfilled"&&Array.isArray(approvals.value.actions)
   ?approvals.value.actions.map(action=>({
    id:"approval:"+String(action.id||""),
    kind:"approval",
    title:action.title||action.toolId||"待确认操作",
    detail:action.description||"",
    at:action.createdAt||"",
    source:"actions"
   }))
   :[],
  tasks:tasks.status==="fulfilled"&&Array.isArray(tasks.value.tasks)
   ?tasks.value.tasks.map(task=>({
    id:"task:"+String(task.taskId||""),
    kind:"task",
    title:(task.prompt||task.taskId||"任务")+" · "+(task.status||""),
    detail:task.error||"",
    at:task.completedAt||task.createdAt||"",
    source:"tasks"
   }))
   :[]
 };
 try{
  const {items}=lib.collectNotifications(sources);
  notificationPageState.items=items;
  notificationPageState.summary=lib.summarizeNotifications(items);
  lib.renderNotificationCenter(container,{
   items:notificationPageState.items,
   summary:notificationPageState.summary,
   filter:notificationPageState.filter
  });
  const failed=[exceptions,approvals,tasks].filter(r=>r.status!=="fulfilled").length;
  setNotifyStatus(items.length
   ?"共 "+items.length+" 条通知，未读 "+(notificationPageState.summary.unread||0)+" 条"+(failed?"（"+failed+" 个来源读取失败）":"")+"。"
   :"暂无通知。");
  notificationPageState.loaded=true;
 }catch(error){
  lib.renderNotificationCenter(container,null);
  setNotifyStatus(error&&error.message?error.message:"通知汇总失败");
 }
}

function bindKnowledgeControls(){
 const search=document.querySelector("#knowledge-search");
 const refreshButton=document.querySelector("#knowledge-refresh");
 const query=document.querySelector("#knowledge-query");
 const source=document.querySelector("#knowledge-source");
 if(search&&!search.dataset.bound){
  search.dataset.bound="1";
  search.addEventListener("click",()=>{
   knowledgePageState.query=query?query.value:"";
   knowledgePageState.source=source?source.value:"";
   refreshKnowledgePanel();
  });
 }
 if(refreshButton&&!refreshButton.dataset.bound){
  refreshButton.dataset.bound="1";
  refreshButton.addEventListener("click",()=>{refreshKnowledgePanel();refreshAppInventory();refreshNotifications();});
 }
 if(query&&!query.dataset.bound){
  query.dataset.bound="1";
  query.addEventListener("keydown",event=>{
   if(event.key!=="Enter")return;
   event.preventDefault();
   knowledgePageState.query=query.value;
   knowledgePageState.source=source?source.value:"";
   refreshKnowledgePanel();
  });
 }
 const filters=[
  ["#notify-filter-all",{}],
  ["#notify-filter-exception",{type:"exception"}],
  ["#notify-filter-approval",{type:"approval"}],
  ["#notify-filter-task",{type:"task"}]
 ];
 for(const [selector,filter] of filters){
  const button=document.querySelector(selector);
  if(!button||button.dataset.bound)continue;
  button.dataset.bound="1";
  button.addEventListener("click",()=>{
   notificationPageState.filter=filter;
   for(const [other] of filters){
    const node=document.querySelector(other);
    if(node)node.setAttribute("aria-pressed",other===selector?"true":"false");
   }
   const container=document.querySelector("#notification-center");
   if(container&&window.Notifications){
    window.Notifications.renderNotificationCenter(container,{
     items:notificationPageState.items,
     summary:notificationPageState.summary,
     filter:notificationPageState.filter
    });
   }
  });
 }
 const markAll=document.querySelector("#notify-mark-all");
 if(markAll&&!markAll.dataset.bound){
  markAll.dataset.bound="1";
  markAll.addEventListener("click",()=>{
   if(!window.Notifications)return;
   const ids=notificationPageState.items.map(item=>item.id);
   const marked=window.Notifications.markNotificationsRead(notificationPageState.items,ids);
   notificationPageState.items=Array.isArray(marked)?marked:notificationPageState.items;
   notificationPageState.summary=window.Notifications.summarizeNotifications(notificationPageState.items);
   const container=document.querySelector("#notification-center");
   if(container)window.Notifications.renderNotificationCenter(container,{
    items:notificationPageState.items,
    summary:notificationPageState.summary,
    filter:notificationPageState.filter
   });
   setNotifyStatus("已把 "+ids.length+" 条通知标为已读（仅本次会话内有效）。");
  });
 }
 const clearRead=document.querySelector("#notify-clear-read");
 if(clearRead&&!clearRead.dataset.bound){
  clearRead.dataset.bound="1";
  clearRead.addEventListener("click",()=>{
   if(!window.Notifications)return;
   const before=notificationPageState.items.length;
   const kept=window.Notifications.clearReadNotifications(notificationPageState.items);
   notificationPageState.items=Array.isArray(kept)?kept:[];
   notificationPageState.summary=window.Notifications.summarizeNotifications(notificationPageState.items);
   const container=document.querySelector("#notification-center");
   if(container)window.Notifications.renderNotificationCenter(container,{
    items:notificationPageState.items,
    summary:notificationPageState.summary,
    filter:notificationPageState.filter
   });
   setNotifyStatus("已移除 "+(before-notificationPageState.items.length)+" 条已读通知（仅本次会话内有效）。");
  });
 }
}
async function refreshKnowledgePage(){
 bindKnowledgeControls();
 await Promise.all([refreshKnowledgePanel(),refreshAppInventory(),refreshNotifications()]);
}

window.addEventListener("knowledge-panel-ready",()=>{
 if(currentRouteId()==="knowledge-card")refreshKnowledgePage();
});
window.addEventListener("notifications-ready",()=>{
 if(currentRouteId()==="knowledge-card")refreshNotifications();
});

/* ------------------------------------------------------------------ *
 * 当前页刷新：顶栏 #refresh、页面内 [data-action="refresh"] 与路由切换共用。
 * ------------------------------------------------------------------ */
async function refreshCurrentPage(){
  const id=currentRouteId();
  try{
    if(id==="status-card"){await refresh();await refreshOverviewStats();await refreshInsights();await refreshPlaybooks();}
    else if(id==="files-card")await refreshFiles(currentFilePath,currentFileOffset);
    else if(id==="agent-card"){await refreshAgentStatus();await refreshRecentTasks();await refreshPendingActions();}
    else if(id==="tools-card")await refreshTools();
    else if(id==="models-card"){await refreshModelPresets();await refreshModels();}
    else if(id==="skills-card")await refreshSkills();
    else if(id==="audit-card")await refreshAudit();
    else if(id==="knowledge-card")await refreshKnowledgePage();
  }catch(e){
    // 单页刷新失败不阻塞其它页面。
  }
}

/* 启动：外壳已经就绪，这里开始拉取会话与首屏数据。 */
init();


/* ---------- Phase 186：文件查找重复 + 设备能力体检 ---------- */
(function(){
  const duplicateButton=document.querySelector("#file-duplicates");
  const duplicateStatus=document.querySelector("#file-duplicates-status");
  const duplicateResult=document.querySelector("#file-duplicates-result");
  if(duplicateButton&&duplicateResult){
    duplicateButton.addEventListener("click",async()=>{
      duplicateButton.disabled=true;
      duplicateResult.textContent="";
      if(duplicateStatus)duplicateStatus.textContent="正在按大小与 SHA-256 比对当前目录…";
      try{
        const params=new URLSearchParams({limit:"200"});
        if(currentFilePath)params.set("path",currentFilePath);
        const response=await api("/api/files/duplicates?"+params.toString());
        const data=await response.json();
        if(!response.ok)throw Error(data.error||("扫描失败（HTTP "+response.status+"）"));
        const groups=Array.isArray(data.groups)?data.groups:[];
        if(!groups.length){
          duplicateResult.textContent="当前目录没有内容相同的重复文件。";
          if(duplicateStatus)duplicateStatus.textContent="已比对 "+(data.scanned||0)+" 个文件，没有可回收的重复空间。";
        }else{
          const lines=[];
          let wasted=0;
          groups.forEach((group,index)=>{
            const size=Number(group.size)||0;
            wasted+=Number(group.wastedBytes)||size*(group.paths.length-1);
            lines.push("#"+(index+1)+"  "+formatBytes(size)+" × "+group.paths.length+" 个");
            for(const filePath of group.paths)lines.push("    "+filePath);
          });
          duplicateResult.textContent=lines.join("\n");
          if(duplicateStatus)duplicateStatus.textContent="发现 "+groups.length+" 组重复，可回收约 "+formatBytes(wasted)+"（只比对当前目录，不递归）。";
        }
        if(data.truncated&&duplicateStatus)duplicateStatus.textContent+=" 结果已截断，请缩小目录范围。";
      }catch(error){
        if(duplicateStatus)duplicateStatus.textContent=(error&&error.message)?error.message:"扫描失败";
      }finally{
        duplicateButton.disabled=false;
      }
    });
  }

  const capabilityStatus=document.querySelector("#capability-status");
  const capabilityResult=document.querySelector("#capability-result");
  async function loadDeviceCapability(profile){
    if(!capabilityResult)return;
    capabilityResult.textContent="";
    if(capabilityStatus)capabilityStatus.textContent="正在读取本机环境…";
    try{
      const response=await api("/api/system/capabilities?profile="+encodeURIComponent(profile));
      const data=await response.json();
      if(!response.ok)throw Error(data.error||("读取失败（HTTP "+response.status+"）"));
      const verdict=data.verdict==="ready"?"满足运行要求":data.verdict==="partial"?"部分满足":"不满足";
      const lines=[verdict+"　"+String(data.profile||"")+"（"+String(data.passed)+"/"+String(data.total)+" 项通过）"];
      for(const item of data.dimensions||[]){
        const mark=item.passed===true?"✔":(item.passed===false?"✘":"?");
        lines.push(mark+" "+item.label+"：需要 "+item.required+"，当前 "+item.actual);
      }
      if(data.recommendation)lines.push("结论："+data.recommendation);
      if(data.note)lines.push(data.note);
      capabilityResult.textContent=lines.join("\n");
      if(capabilityStatus)capabilityStatus.textContent="";
    }catch(error){
      if(capabilityStatus)capabilityStatus.textContent=(error&&error.message)?error.message:"读取失败";
    }
  }
  for(const button of document.querySelectorAll("[data-capability-profile]")){
    button.addEventListener("click",()=>{
      loadDeviceCapability(button.getAttribute("data-capability-profile")||"agent-host");
    });
  }
})();
