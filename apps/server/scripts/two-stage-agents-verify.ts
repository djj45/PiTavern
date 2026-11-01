import assert from 'node:assert/strict';
import {createTavernAgent} from '../src/agent/engine.ts';
import {createNarrativeAgent,settlementTools} from '../src/agent/narrative.ts';
import {buildPlayerWorldView} from '../src/world/knowledge.ts';
import {createNarrative} from '../src/session/narrative.ts';
import {resolveModel} from '../src/providers/models.ts';
import {twoStageFixture,submit,proposal} from './two-stage-fixture.ts';
const f=await twoStageFixture();let checks=0;const check=(s:string)=>{checks++;console.log('✓ '+s)};
try{
 const chat=f.chat(),state=f.chats.readWorld(chat.id)!,view=buildPlayerWorldView(state.snapshot,state.template),model=resolveModel(f.models,f.config),controller=new AbortController();
 const options={models:f.models,model,chatId:chat.id,thinkingLevel:'off' as const};
 f.plan('plain text is not settlement',[{text:'直接写正文'}]);let tools=settlementTools([],()=>view,controller.signal);
 let agent=createTavernAgent({...options,tools:tools.tools,completion:'settlement',settlementComplete:tools.complete});await agent.prompt('结算');assert.ok(agent.state.errorMessage);assert.throws(tools.result);assert.equal(f.count(),1);check('普通文本不能结束结算');
 f.plan('valid plan',[{calls:[submit]}]);tools=settlementTools([],()=>view,controller.signal);agent=createTavernAgent({...options,tools:tools.tools,completion:'settlement',settlementComplete:tools.complete});await agent.prompt('结算');assert.ok(!agent.state.errorMessage);assert.deepEqual(tools.result(),proposal);check('专用计划动作结束结算并校验引用');
 let executed=0;const mutator={...tools.tools[0],name:'mutate',execute:async()=>{executed++;return {content:[],details:{}}}};
 f.plan('sealed',[{calls:[submit,{name:'mutate',args:proposal}]}]);tools=settlementTools([mutator],()=>view,controller.signal);agent=createTavernAgent({...options,tools:tools.tools,completion:'settlement',settlementComplete:tools.complete});await agent.prompt('结算');assert.throws(tools.result);assert.equal(executed,0);check('计划提交后同批次工具不能继续修改状态');
 const packet=createNarrative({turnId:'turn',metadata:f.chats.readMetadata(chat.id),source:[],before:view,view,plan:proposal,writing:{settings:'中文，简洁',input:'问路',direction:''}});
 for(const output of [{text:'掌柜点头。'},{calls:[{name:'mutate',args:proposal}]},{text:''},{text:'被截断',length:true}]){
  f.plan('render',[{...output,inspect:body=>{assert.ok(!body.tools?.length);assert.ok(!body.tool_choice);assert.ok(!JSON.stringify(body).includes(f.raw.facts[1].text));assert.ok(!JSON.stringify(body).includes(f.raw.interactions[0].description));}}]);
  agent=createNarrativeAgent({...options,packet,view,history:[]});await agent.continue();assert.equal(f.count(),1);assert.equal(executed,0);
  if(output.calls||output.length)assert.ok(agent.state.errorMessage);
 }
 check('正文真实请求无工具/私密字段，非法调用和截断失败且不执行工具');
 assert.deepEqual(f.problems,[]);
}finally{await f.close();}
console.log(`${checks} 组双阶段代理检查通过：${f.run}`);
