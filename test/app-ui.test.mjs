import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { initialState, reduce, activityLabel, visibleActivities, attention, coalesceRecords, effortChoices, modelSelection, scanStatus, memberActivity, toolName, permissionHistory, operationSummary } from '../ui/state.js';
class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this._scrollTop=0;this.clientHeight=100;this.classList={toggle(){},add(){},remove(){}};}
 append(...items){for(const item of items){item.remove?.();item.parent=this;this.children.push(item);}}
 replaceChildren(...items){for(const c of this.children)c.parent=null;this.children=[];this.append(...items);}
 replaceWith(other){const parent=this.parent;const next=this.nextSibling;this.remove();if(parent)parent.insertBefore(other,next);}
 remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}}
 insertBefore(item,before){item.remove();const i=before?this.children.indexOf(before):this.children.length;this.children.splice(i,0,item);item.parent=this;}
 get firstChild(){return this.children[0];} get lastChild(){return this.children.at(-1);}
 get nextSibling(){return this.parent?.children[this.parent.children.indexOf(this)+1];}
 get scrollTop(){return this._scrollTop;}
 set scrollTop(value){this._scrollTop=Math.max(0,Math.min(value,Math.max(0,this.scrollHeight-this.clientHeight)));}
 get scrollHeight(){return this.children.length*100;}
 querySelector(){return new Element('button');}
 querySelectorAll(){return this.children.flatMap(c=>[...(c.dataset.field?[c]:[]),...c.querySelectorAll()]);}
 setAttribute(key,value){this[key]=value;}
 get options(){return this.children;}
}
function harness(fetcher=async()=>[]) {
 const ids=new Map(),timers=[],observers=[],intervals=[],confirmations=[];
 const context={confirm:text=>{confirmations.push(text);return false;},prompt:()=>null,initialState,reduce,activityLabel,visibleActivities,attention,coalesceRecords,effortChoices,modelSelection,scanStatus,memberActivity,toolName,permissionHistory,operationSummary,
  ResizeObserver:class { constructor(callback){this.callback=callback;observers.push(this);} observe(target){this.target=target;} },
  markdown:text=>[{tag:'text',text}],URL,Map,Set,Promise,console,
  document:{getElementById(id){if(!ids.has(id))ids.set(id,new Element('div'));return ids.get(id);},createElement:t=>new Element(t),createTextNode:text=>Object.assign(new Element('text'),{textContent:text}),body:new Element('body')},
  location:{href:'http://localhost/'},sessionStorage:{data:new Map(),getItem(k){return this.data.get(k)??null;},setItem(k,v){this.data.set(k,v);},removeItem(k){this.data.delete(k);}},window:{},setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},
  setInterval(fn,ms){intervals.push({fn,ms});return intervals.length;},fetch:async(url,options)=>({ok:true,json:()=>fetcher(url,options)}),
 };
 const source=readFileSync(new URL('../ui/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('boot().catch(showError);','');
 vm.runInNewContext(source+`
 globalThis.testUI={showAlert,unreadCounts,readTab,renderTabs,select,renderConversation,scheduleRender,renderHead,renderPanel,renderLeft,showError,teamRow,readTeam,invalidatePanel,setTab(value){tab=value;panelDirty=false;},isDirty(){return panelDirty;},
 configure(value){state={projects:[],quota:[],...value};},getView(){return view;},
 append(e){reduce(view,e);},getSelected(){return selected;}};`,context);
 return {ui:context.testUI,ids,timers,observers,intervals,confirmations};
}
const meta=id=>({id,config:{members:[]}});
test('destructive actions live in More and cancellation prevents API calls with explicit stop warning',async()=>{
 const html=readFileSync(new URL('../ui/index.html',import.meta.url),'utf8');
 assert.match(html,/<details class="more"><summary>更多<\/summary>[^]*?<button id="stop">停止会话<\/button><\/details>/);
 const calls=[],{ui,ids,confirmations}=harness(url=>{calls.push(url);return [];});
 ui.configure({projects:[{id:'p',path:'project',git:true}],sessions:[]});ui.renderLeft();
 const more=ids.get('projects').firstChild.children.find(c=>c.className==='more');assert.equal(more.firstChild.textContent,'更多');await more.lastChild.onclick();
 await ids.get('stop').onclick();assert.equal(calls.length,0);assert.match(confirmations[0],/项目文件和会话记录会保留/);assert.match(confirmations[1],/不能再继续.*之后继续请用暂停/);
 const css=readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');assert.match(css,/:focus-within/);assert.match(css,/max-width:min\(90%,72ch\)/);
});
test('unread board and DM counts are per session, clear on click and survive switches',async()=>{
 const list=[{sequence:1,type:'board',text:'board'},{sequence:2,type:'dm',text:'private'}];
 const {ui,ids}=harness(url=>url.endsWith('/board')?{text:'board'}:list);
 ui.configure({sessions:[meta('a'),meta('b')]});await ui.select('a');await ui.renderPanel();
 assert.equal(ui.unreadCounts('a')['白板'],1);assert.equal(ui.unreadCounts('a')['私信'],1);
 const dm=ids.get('tabs').children.find(b=>b.dataset.tab==='私信');await dm.onclick();assert.equal(ui.unreadCounts('a')['私信'],0);
 await ui.select('b');assert.equal(ui.unreadCounts('b')['私信'],1);await ui.select('a');assert.equal(ui.unreadCounts('a')['私信'],0);assert.equal(ui.unreadCounts('a')['白板'],1);
 ui.append({sequence:3,type:'dm',text:'next'});ui.append({sequence:3,type:'dm',text:'duplicate'});assert.equal(ui.unreadCounts('a')['私信'],1);
});
test('interrupt controls require working member and quota warning shows remaining with observation age',async()=>{
 const config={members:[{name:'lead',role:'lead',harness:'codex',model:'x'}]};
 const {ui,ids}=harness(url=>url.endsWith('/board')?{text:''}:[{sequence:1,type:'turn-start',member:'lead'}]);
 ui.configure({sessions:[{id:'a',status:'运行中',config}],quota:[{harness:'codex',observedAt:new Date(Date.now()-180000).toISOString(),windows:[{label:'5h',usedPercent:92,resetsAt:new Date(Date.now()+3600000).toISOString()}]},{harness:'dsh',windows:[]}]});
 await ui.select('a');await ui.renderPanel();ui.renderHead();assert.equal(ids.get('interrupt').hidden,false);assert.match(ids.get('quota-warning').textContent,/剩余 8%/);
 assert.equal(ids.get('quota').children.length,2);assert.match(ids.get('quota').lastChild.children[2].textContent,/3 分钟前/);
 ui.append({sequence:2,type:'turn-end',member:'lead',status:'completed'});await ui.renderPanel();ui.renderHead();assert.equal(ids.get('interrupt').hidden,true);assert.equal(ids.get('members').firstChild.firstChild.lastChild.hidden,true);
});
test('waiting banner keeps summary on one line with full question available through dialog',async()=>{
 const text='请确认下一步？\n'+'长段落'.repeat(100),config={members:[{name:'lead',role:'lead'}]};
 const {ui,ids}=harness(()=>[{sequence:1,type:'to-user',member:'lead',text}]);ui.configure({sessions:[{id:'a',status:'空闲',config}]});await ui.select('a');ui.renderHead();
 const banner=ids.get('waiting');assert.equal(banner.children[1].textContent.length,70);assert.doesNotMatch(banner.children[1].textContent,/\n/);assert.ok(banner.children.some(b=>b.textContent==='查看全文'));assert.ok(banner.children.some(b=>b.textContent==='回答负责人'));
});
test('one runtime clock updates only member text without requests, list rendering or scroll changes',async()=>{
 const at=new Date(Date.now()-9*60000).toISOString(),calls=[];
 const events=[{sequence:1,type:'turn-start',member:'w',at},{sequence:2,type:'tool',member:'w',id:'p',command:'python alt_probe2.py | Out-String',at}];
 const {ui,ids,intervals,timers}=harness(url=>{calls.push(url);return url.endsWith('/board')?{text:''}:events;});
 ui.configure({sessions:[{id:'a',status:'运行中',config:{members:[{name:'w',role:'worker'}]}}]});
 await ui.select('a');await ui.renderPanel();ui.renderConversation();
 assert.equal(intervals.length,1);assert.equal(intervals[0].ms,1000);
 const card=ids.get('members').firstChild,action=card.children[1],records=card.lastChild;
 assert.match(action.textContent,/正在运行 alt_probe2.py · 已运行 9 分钟/);assert.equal(action.title,events[1].command);
 records.open=true;const chat=ids.get('chat');chat.scrollTop=20;const top=chat.scrollTop;
 const count=calls.length,scheduled=timers.length;
 ids.get('members').replaceChildren=()=>assert.fail('clock rebuilt member list');
 ids.get('chat').replaceChildren=()=>assert.fail('clock rebuilt conversation');
 ui.getView().members.w.activeTools.get('p').at=new Date(Date.now()-12*60000).toISOString();
 intervals[0].fn();assert.match(action.textContent,/已运行 12 分钟/);
 assert.equal(ids.get('members').firstChild,card);assert.equal(card.children[1],action);assert.equal(card.lastChild,records);assert.equal(records.open,true);
 assert.equal(calls.length,count);assert.equal(timers.length,scheduled);assert.equal(chat.scrollTop,top);
 ui.append({sequence:3,type:'turn-end',member:'w'});intervals[0].fn();assert.doesNotMatch(action.textContent,/正在运行/);
});
test('cold session restoration discards commands missing terminal events after restart',async()=>{
 const {ui,ids}=harness(url=>url.endsWith('/board')?{text:''}:[{type:'turn-start',member:'w'},{type:'tool',member:'w',id:'stale',command:'python old.py'}]);
 ui.configure({sessions:[{id:'a',status:'未加载',config:{members:[{name:'w',role:'worker'}]}}]});
 await ui.select('a');await ui.renderPanel();assert.equal(ui.getView().members.w.activeTools.size,0);
 assert.doesNotMatch(ids.get('members').firstChild.children[1].textContent,/正在运行/);
 assert.equal(ids.get('members').firstChild.firstChild.children[1].textContent,'空闲');
});
test('late selection cannot overwrite the next conversation',async()=>{
 let resolveA;const a=new Promise(r=>resolveA=r);
 const {ui}=harness(url=>url.includes('/a/')?a:[{sequence:1,type:'from-user',text:'B'}]);
 ui.configure({sessions:[meta('a'),meta('b')]});
 const pending=ui.select('a');await ui.select('b');resolveA([{sequence:1,type:'from-user',text:'A'}]);await pending;
 assert.equal(ui.getSelected(),'b');assert.equal(ui.getView().messages[0].text,'B');
});
test('conversation keeps DOM and expanded details; scrolling up stays in place; refreshes merge',async()=>{
 const {ui,ids,timers}=harness(()=>[{sequence:1,type:'from-user',text:'start'},{sequence:2,type:'tool',id:'t',title:'Read',member:'worker'}]);
 ui.configure({sessions:[meta('a')]});await ui.select('a');ui.renderConversation();
 const chat=ids.get('chat'),bubble=chat.children[0],group=chat.children[1];group.open=true;group.ontoggle();const detail=group.lastChild.firstChild;detail.open=true;
 chat.scrollTop=20;ui.append({sequence:3,type:'tool',id:'u',title:'Edit',member:'worker'});ui.renderConversation();
 assert.equal(chat.children[0],bubble);assert.equal(chat.children[1],group);assert.equal(group.open,true);assert.equal(group.lastChild.firstChild,detail);assert.equal(detail.open,true);assert.equal(chat.scrollTop,20);
 for(let i=0;i<500;i++)ui.scheduleRender();assert.equal(timers.length,1);assert.equal(timers[0].ms,250);
});
test('initial conversation mounts 200 rows, upward scroll loads earlier messages, failures expand',async()=>{
 const list=Array.from({length:300},(_,i)=>({sequence:i+1,type:'from-user',text:String(i)}));
 const {ui,ids}=harness(()=>list);ui.configure({sessions:[meta('a')]});await ui.select('a');ui.renderConversation();
 const chat=ids.get('chat');assert.equal(chat.children.length,200);chat.scrollTop=0;chat.onscroll();assert.equal(chat.children.length,300);
 ui.append({sequence:301,type:'member-failed',member:'worker',error:'failed'});ui.renderConversation();assert.equal(chat.lastChild.open,true);assert.equal(chat.lastChild.lastChild.firstChild.open,true);
});
test('logical reply updates reuse the bubble and summaries exclude internal events',async()=>{
 const list=[{sequence:1,type:'to-user',member:'lead',messageId:'l:1',text:'first'},{sequence:2,type:'tool',member:'w',id:'t',title:'Read'},{sequence:3,type:'usage',member:'w'}];
 const {ui,ids}=harness(()=>list);ui.configure({sessions:[meta('a')]});await ui.select('a');ui.renderConversation();
 const chat=ids.get('chat'),bubble=chat.firstChild;
 ui.append({sequence:4,type:'message-update',member:'lead',messageId:'l:1',text:'first second'});ui.renderConversation();
 assert.equal(chat.firstChild,bubble);assert.equal(bubble.dataset.text,'first second');assert.match(chat.lastChild.firstChild.textContent,/1 步/);assert.match(chat.lastChild.firstChild.textContent,/Read/);
});

test('drafts survive session switches and internal-only activity stays hidden',async()=>{
 const {ui,ids}=harness(()=>[{sequence:1,type:'usage',member:'lead'}]);ui.configure({sessions:[meta('a'),meta('b')]});
 await ui.select('a');ids.get('message').value='中文草稿';await ui.select('b');ids.get('message').value='另一条';await ui.select('a');assert.equal(ids.get('message').value,'中文草稿');
 ui.renderConversation();assert.equal(ids.get('chat').firstChild.hidden,true);
});
test('historical failures stay collapsed, new failures expand',async()=>{
 const {ui,ids}=harness(()=>[{sequence:1,type:'snapshot',error:'旧快照失败'}]);ui.configure({sessions:[meta('a')]});await ui.select('a');ui.renderConversation();
 const group=ids.get('chat').firstChild;assert.ok(!group.open);ui.append({sequence:2,type:'member-failed',error:'新失败'});ui.renderConversation();assert.equal(group.open,true);
});
test('waiting question and member cards remain visible when opening auxiliary tabs',async()=>{
 const m={name:'lead',role:'lead',harness:'codex',model:'fake'};
 const {ui,ids}=harness(url=>url.endsWith('/board')?{text:'**白板**'}:[{sequence:1,type:'to-user',member:'lead',text:'请确认下一步？'},{sequence:2,type:'wait-start',member:'lead'}]);
 ui.configure({sessions:[{...meta('a'),config:{members:[m]},status:'空闲'}]});await ui.select('a');ui.renderHead();await ui.renderPanel();
 assert.equal(ids.get('waiting').hidden,false);assert.match(ids.get('status').textContent,/等你回答/);assert.equal(ids.get('members').children.length,1);assert.equal(ids.get('panel').children.length,1);
});

test('quota detail stays open and errors are not overwritten; paused questions and failed cards remain',async()=>{
 const config={members:[{name:'lead',role:'lead',harness:'codex',model:'fake'},{name:'w',role:'worker',harness:'dsh',model:'local'}]};
 const {ui,ids}=harness(url=>url.endsWith('/board')?{text:''}:[{sequence:1,type:'to-user',member:'lead',text:'请确认？'},{sequence:2,type:'wait-start',member:'lead'},{sequence:3,type:'member-failed',member:'w',error:'失败原因'}]);
 const data={projects:[],sessions:[{id:'a',config,status:'已暂停'}],quota:[{harness:'codex',windows:[],exhausted:true,observedAt:'2026-11-04'}]};ui.configure(data);await ui.select('a');
 ui.renderLeft();ids.get('quota').children[1].open=true;ui.showError('接口报错');ui.renderLeft();assert.equal(ids.get('quota').children[1].open,true);assert.equal(ids.get('banner').textContent,'接口报错');
 ui.renderHead();assert.equal(ids.get('status').textContent,'已暂停');assert.equal(ids.get('waiting').hidden,false);await ui.renderPanel();assert.match(ids.get('members').children[0].firstChild.children[1].textContent,/失败/);
 ui.setTab('改动');ui.invalidatePanel('a',{type:'board'});ui.invalidatePanel('a',{type:'dm'});assert.equal(ui.isDirty(),false);
 ui.setTab('白板');ui.invalidatePanel('a',{type:'board'});assert.equal(ui.isDirty(),true);
});
test('team form permits role selection and limited snapshots do not force activity open',async()=>{
 const {ui,ids}=harness(()=>[]);ui.configure({models:{codex:{models:[{id:'fake',available:true,efforts:['high'],defaultEffort:'high'}]}},sessions:[meta('a')]});
 ui.teamRow({role:'worker',harness:'codex',model:'fake'});const role=ids.get('team').firstChild.firstChild;assert.equal(role['aria-label'],'角色');role.value='lead';role.onchange();assert.equal(ui.readTeam()[0].role,'lead');
 await ui.select('a');ui.append({sequence:1,type:'snapshot',limited:true,text:'仅保存索引已有文件'});ui.renderConversation();assert.ok(!ids.get('chat').firstChild.open);
});

const textOf = e => [e.textContent ?? '', ...e.children.map(textOf)].join('');
const walk = e => [e, ...e.children.flatMap(walk)];
test('compact member cards put failures and user questions first, with direct retry and stable records',async()=>{
 const config={members:[{name:'worker',role:'worker'},{name:'lead',role:'lead'},{name:'tester',role:'worker'}]};
 const events=[{sequence:1,type:'to-user',member:'lead',text:'请确认？'},{sequence:2,type:'wait-start',member:'lead'},{sequence:3,type:'member-failed',member:'tester',error:'失败详情'}, {sequence:4,type:'turn-start',member:'worker'}];
 const calls=[];
 const {ui,ids}=harness(url=>{calls.push(url);return url.endsWith('/board')?{text:''}:url.endsWith('/retry')?{}:events;});
 ui.configure({sessions:[{id:'a',config,status:'运行中'}]});await ui.select('a');await ui.renderPanel();
 const cards=ids.get('members').children;
 assert.deepEqual(cards.map(c=>c.dataset.member),['tester','lead','worker']);
 const failed=cards[0],retry=failed.firstChild.lastChild;
 assert.equal(retry.textContent,'重试成员');assert.equal(retry.disabled,false);
 assert.equal(failed.children.length,5);assert.equal(failed.firstChild.children[1].textContent,'失败');
 assert.equal(failed.children[1].title,'失败详情');assert.equal(failed.lastChild.open,undefined);
 await retry.onclick();assert.ok(calls.some(url=>url.endsWith('/members/tester/retry')));
 const records=failed.lastChild;records.open=true;
 ui.append({sequence:5,type:'turn-start',member:'tester'});await ui.renderPanel();
 assert.deepEqual(cards.map(c=>c.dataset.member),['lead','worker','tester']);assert.equal(cards[2],failed);assert.equal(failed.lastChild,records);assert.equal(records.open,true);
});

test('a permission request is answered on the member card, and records open below without losing the team',async()=>{
  const config={members:[{name:'lead',role:'lead'},{name:'tester',role:'worker'}]};
  const operation={command:'python run.py',cwd:'E:\\x',reason:'跑测试'};
  const events=[{sequence:1,type:'turn-start',member:'tester'},{sequence:2,type:'permission-request',id:'p1',member:'tester',operation}];
  const calls=[];
  const {ui,ids}=harness((url,options)=>{calls.push([url,options?.body]);return url.endsWith('/board')?{text:''}:url.endsWith('/permissions')?{grants:[],pending:[],recent:[],network:false,warnings:[]}:url.includes('events?member=')?[{type:'tool',id:'t',member:'tester',command:'python run.py',status:'completed'}]:events;});
  ui.configure({sessions:[{id:'a',config,status:'运行中'}]});await ui.select('a');await ui.renderPanel();
  const card=ids.get('members').children.find(c=>c.dataset.member==='tester');
  assert.equal(card.firstChild.children[1].textContent,'等你批准');assert.equal(card.children[1].hidden,true);
  const box=card.children[3],approval=box.firstChild;assert.equal(box.children.length,1);
  await ui.renderPanel();assert.equal(box.firstChild,approval,'a repaint must not rebuild an open approval');
  const buttons=approval.lastChild.children;assert.deepEqual(buttons.map(b=>b.textContent),['允许这一次','本会话允许相同命令','拒绝']);
  await buttons[0].onclick();
  assert.ok(calls.some(([url,body])=>url.endsWith('/permissions') && String(body).includes('"decision":"once"') && String(body).includes('p1')));
  await card.lastChild.onclick();
  assert.ok(calls.some(([url])=>url.includes('events?member=tester')));
  assert.equal(ids.get('members').children.length,2);
  const tabs=ids.get('tabs').children,recordTab=tabs.find(b=>b.dataset.tab==='记录');
  assert.equal(recordTab.hidden,false);assert.equal(recordTab.textContent,'tester 的记录');assert.equal(recordTab.className,'active');
  await recordTab.onclick();assert.equal(ids.get('right').className,'panel-collapsed');
  await tabs.find(b=>b.dataset.tab==='白板').onclick();assert.equal(ids.get('right').className,'');
});

test('a failed tool stays collapsed and is counted on the summary, even when it starts as running',async()=>{
  const {ui,ids}=harness(()=>[{sequence:1,type:'tool',id:'x',member:'w',command:'python a.py',status:'in_progress'}]);
  ui.configure({sessions:[{id:'a',config:{members:[{name:'w',role:'lead'}]}}]});await ui.select('a');ui.renderConversation();
  const group=ids.get('chat').firstChild;assert.ok(!group.open);
  ui.append({sequence:2,type:'tool',id:'x',member:'w',command:'python a.py',status:'failed',error:'exit 1'});ui.renderConversation();
  assert.ok(!group.open);assert.match(group.firstChild.textContent,/1 个工具失败/);
  ui.append({sequence:3,type:'tool',id:'y',member:'w',command:'python b.py',status:'failed'});ui.renderConversation();
  assert.ok(!group.open);assert.match(group.firstChild.textContent,/2 个工具失败/);
  group.open=true;ui.renderConversation();
  assert.ok(group.lastChild.children.every(row=>!row.open),'opening the group must not open the failed rows either');
});

test('a permission request never reaches the banner, so an answered one cannot linger there',async()=>{
  const {ui,ids}=harness(()=>[]);
  ui.showAlert({type:'permission-request',id:'p',member:'小千',operation:{command:'python run.py'}});
  assert.equal(ids.get('banner')?.textContent ?? '','');
  ui.showAlert({type:'member-failed',member:'小千',error:'失败详情'});
  assert.equal(ids.get('banner').textContent,'失败详情');
});

test('opening and returning pins after waiting banner layout; scrolling up survives header and resize updates',async()=>{
 const events=Array.from({length:30},(_,i)=>({sequence:i+1,type:'from-user',text:String(i)}));
 events.push({sequence:31,type:'to-user',member:'lead',text:'请确认？'},{sequence:32,type:'wait-start',member:'lead'});
 const {ui,ids,observers}=harness(()=>events);
 ui.configure({sessions:[{id:'a',config:{members:[{name:'lead',role:'lead'}]}},meta('b')]});
 const chat=ids.get('chat');let height=500;
 Object.defineProperty(chat,'clientHeight',{get:()=>height-(ids.get('waiting')?.hidden===false?162:0)});
 const gap=()=>chat.scrollHeight-chat.clientHeight-chat.scrollTop;
 await ui.select('a');ui.renderConversation();ui.renderHead();assert.ok(gap()<=1);
 await ui.select('b');ui.renderConversation();await ui.select('a');ui.renderConversation();ui.renderHead();assert.ok(gap()<=1);
 chat.onscroll();height=450;observers[0].callback();assert.ok(gap()<=1);
 chat.scrollTop=100;chat.onscroll();const top=chat.scrollTop;
 ui.renderHead();height=400;observers[0].callback();ui.renderConversation();assert.equal(chat.scrollTop,top);
});

test('selection immediately replaces old title and question while a slow request is pending, with one active row',async()=>{
 let finish;const pending=new Promise(resolve=>finish=resolve);
 const {ui,ids}=harness(url=>url.includes('/b/')?pending:[{sequence:1,type:'to-user',member:'lead',text:'旧问题？'},{sequence:2,type:'wait-start',member:'lead'}]);
 const sessions=['a','b'].map(id=>({id,projectId:'p',title:id==='a'?'旧标题':'新标题',status:'空闲',config:{members:[{name:'lead',role:'lead'}]}}));
 ui.configure({projects:[{id:'p',path:'D:/project',git:true}],sessions});
 await ui.select('a');ui.renderConversation();ui.renderHead();assert.equal(ids.get('waiting').hidden,false);
 const next=ui.select('b');
 assert.equal(ids.get('title').textContent,'新标题');assert.equal(ids.get('status').textContent,'加载中…');
 assert.equal(ids.get('waiting').hidden,true);assert.equal(ids.get('waiting').children.length,0);
 assert.equal(ids.get('chat').firstChild.textContent,'加载中…');assert.equal(ids.get('message').disabled,true);
 const rows=walk(ids.get('projects')).filter(e=>e.className?.split(' ').includes('session'));
 assert.equal(rows.filter(e=>e.className.split(' ').includes('active')).length,1);
 assert.match(textOf(rows.find(e=>e['aria-current']==='true')),/新标题/);
 // A scheduled refresh during loading must not remove the loading indicator or resurrect the old question.
 ui.renderHead();assert.equal(ids.get('waiting').hidden,true);
 finish([]);await next;ui.renderConversation();assert.equal(ids.get('message').disabled,false);assert.equal(ids.get('chat').children.length,0);
});

test('session rows have two explicit lines, relative time and ellipsis paths with full hover text',()=>{
 const {ui,ids}=harness();const path='D:/很长的项目目录/更多目录/项目';
 ui.configure({projects:[{id:'p',path,git:true}],sessions:[{id:'a',projectId:'p',title:'中文界面预览',attention:{waiting:true},lastActivity:new Date(Date.now()-180000).toISOString()}]});ui.renderLeft();
 const row=walk(ids.get('projects')).find(e=>e.className?.split(' ').includes('session'));
 assert.equal(row.children.length,2);assert.equal(row.firstChild.className,'session-title');assert.equal(row.firstChild.textContent,'● 中文界面预览');
 assert.equal(row.lastChild.className,'session-meta');assert.match(row.lastChild.textContent,/^等你回答 · 3 分钟前$/);
 const p=walk(ids.get('projects')).find(e=>e.className==='hint project-path');assert.equal(p.title,path);assert.equal(p.textContent,path);
 const css=readFileSync(new URL('../ui/style.css',import.meta.url),'utf8');
 assert.match(css,/\.session-title,\.session-meta,\.project-path[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap/s);
 assert.match(css,/@media\(min-width:951px\) and \(max-width:1200px\)[\s\S]*#right \{ display:flex;/);
 assert.match(css,/#members \{ flex:0 1 auto; max-height:65%;/);
 assert.match(css,/#members \.card \{ display:grid; grid-template-columns:minmax\(0,1fr\) auto;/);
});
