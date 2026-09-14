import {html,safeUrl,canonicalUrl,splitText} from './core.js';
import {newsIdentity,newsDay} from './daily.js';
import {portfolioAssets,entitledPortfolio,upgradeOffer} from './freemium.js';

export const fullAccess=a=>['paid','trial','test'].includes(a?.tier);
export const day=d=>String(d||'').slice(0,10);
export const dateLabel=value=>{const d=new Date(value);return Number.isFinite(+d)?d.toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit'}):'дата не указана';};
const num=(n,d=2)=>Number(n).toLocaleString('ru-RU',{maximumFractionDigits:d});
const signed=n=>(n>0?'+':'')+num(n)+'%';
const link=(url,label='Источник')=>safeUrl(url)?`<a href="${html(url)}">${html(label)}</a>`:'';
const clip=(s,n)=>String(s||'').length>n?String(s).slice(0,n-1)+'…':String(s||'');
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
export const storyId=n=>(canonicalUrl(n.url)||'')+'|'+String(n.fact||'').toLowerCase().replace(/\s+/g,' ').trim()+'|'+day(n.event_date||n.published_at);

export function filterSnapshot(snapshot,access,currentAccounts=null){
 const original=portfolioAssets(snapshot.accounts||[]).map(p=>p.key);
 const current=access.tier==='free'&&currentAccounts?entitledPortfolio(currentAccounts,access).keys:original;
 const allowed=current.filter(k=>original.includes(k));
 const view=entitledPortfolio(snapshot.accounts||[],access,allowed),keys=new Set(view.keys);
 const pick=object=>Object.fromEntries(Object.entries(object||{}).filter(([key])=>keys.has(key)));
 return {...snapshot,accounts:view.accounts,quotes:pick(snapshot.quotes),news:pick(snapshot.news),facts:pick(snapshot.facts),week_change:pick(snapshot.week_change),keys:view.keys,hidden:Math.max(0,(snapshot.total_assets??original.length)-view.keys.length)};
}

export function stories(snapshot,{fresh=false}={}){
 const seen=new Set(fresh?snapshot.previous_story_ids||[]:[]),items=[];
 for(const p of portfolioAssets(snapshot.accounts||[])){
  const n=snapshot.news?.[p.key];if(n?.status!=='ok')continue;
  for(const item of n.items||[]){
   if(!safeUrl(item.url)||seen.has(storyId(item)))continue;
   seen.add(storyId(item));items.push({...item,asset:p.name,symbol:p.symbol,key:p.key});
  }
 }
 return items.sort((a,b)=>{
  const score=n=>/дефолт|банкрот|default|приостанов|санкци|отч[её]т|дивиденд|погашен|взлом|hack/i.test(n.fact)?1:0;
  return score(b)-score(a);
 });
}

export function calendarItems(snapshot,access,now=new Date()){
 const from=newsDay(now),until=day(new Date(+new Date(from)+((fullAccess(access)?30:7)*86400000))),items=[],seen=new Set();
 for(const p of portfolioAssets(snapshot.accounts||[])){
  const held=(snapshot.accounts||[]).flatMap(a=>a.positions).filter(x=>x.verified&&newsIdentity(x)===p.key);
  const quantities=held.map(x=>finite(x.quantity)),quantity=quantities.every(n=>n!==null)?quantities.reduce((a,b)=>a+b,0):null;
  for(const event of [...(snapshot.facts?.[p.key]?.events||[]),...(snapshot.news?.[p.key]?.events||[])]){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(event.date||'')||event.date<from||event.date>until||!safeUrl(event.url))continue;
   const key=p.key+'|'+event.date+'|'+(event.type||event.title);if(seen.has(key))continue;seen.add(key);
   const unit=finite(event.amount_per_unit);
   items.push({...event,asset:p.name,key:p.key,quantity,estimate:fullAccess(access)&&event.confirmed&&unit!==null&&quantity!==null&&event.currency?unit*quantity:null});
  }
 }
 return items.sort((a,b)=>a.date.localeCompare(b.date));
}

export function valuation(snapshot){
 const entries=[],missing=[],fx=snapshot.fx;
 const fxFresh=fx?.status==='ok'&&Math.abs(+new Date(day(snapshot.as_of))-+new Date(fx.as_of))<=7*86400000;
 for(const a of snapshot.accounts||[])for(const p of a.positions){
  const key=p.verified&&p.provider!=='cash'?newsIdentity(p):p.key,q=snapshot.quotes?.[key],facts=snapshot.facts?.[key]||{};
  const qty=finite(p.quantity);let value=null,currency=null,basis=null;
  if(p.provider==='cash'&&qty!==null){value=qty;currency=p.currency||p.provider_id;basis='cash';}
  else if(p.verified&&qty!==null&&q?.status==='ok'&&finite(q.price)!==null){
   const qDate=Date.parse(q.as_of),age=+new Date(snapshot.as_of)-qDate;
   if(Number.isFinite(qDate)&&age>=-86400000&&age<=7*86400000){
    if(p.kind==='bond'){
     if(finite(q.unit_price)!==null&&q.unit_currency){value=qty*Number(q.unit_price);currency=q.unit_currency;basis='quote';}
    }else if(/^[A-Z]{3}$/.test(q.currency||'')){value=qty*Number(q.price);currency=q.currency;basis='quote';}
   }
  }
  if(value===null&&finite(p.observed_value)!==null&&/^[A-Z]{3}$/.test(p.currency||'')&&+new Date(snapshot.as_of)-+new Date(a.updated_at)<=30*86400000){value=Number(p.observed_value);currency=p.currency;basis='screenshot';}
  if(value===null||!Number.isFinite(value)||value<0||!currency){missing.push(p.name);continue;}
  entries.push({key,name:p.name,value,currency,basis,kind:p.kind,issuer_id:facts.issuer_id||p.cik&&'sec:'+p.cik,issuer_name:facts.issuer_name,sector:facts.sector,converted:currency==='RUB'?value:fxFresh&&fx.rates?.[currency]?value*fx.rates[currency]:null});
 }
 const currencies=[...new Set(entries.map(e=>e.currency))];
 const unified=entries.every(e=>e.converted!==null),single=currencies.length===1;
 const eligible=unified?entries:single?entries.map(e=>({...e,converted:e.value})):entries.filter(e=>e.converted!==null);
 return {entries:eligible,total:eligible.reduce((s,e)=>s+e.converted,0),currency:unified?'RUB':single?currencies[0]:'RUB',missing:[...missing,...entries.filter(e=>!eligible.includes(e)&&!single).map(e=>e.name)],fx_used:unified&&currencies.some(c=>c!=='RUB'),screenshot_count:eligible.filter(e=>e.basis==='screenshot').length};
}
const groups=(entries,key)=>[...entries.reduce((map,e)=>map.set(key(e),(map.get(key(e))||0)+e.converted),new Map())].sort((a,b)=>b[1]-a[1]);
export function structureText(snapshot,access){
 if(!fullAccess(access))return '<b>💎 Структура портфеля</b>\n\nВ полном доступе — доли активов, валюты котировок, типы инструментов и концентрация по эмитентам.\n\n<i>Демонстрационный пример:</i>\nКрупнейший актив — 38%\nТри крупнейших актива — 71%\n\nЭти цифры условные. /subscribe — открыть анализ своего портфеля.';
 const v=valuation(snapshot);
 if(!v.total)return '<b>Структура портфеля</b>\n\nДля оценки долей пока недостаточно подтверждённых стоимостей и валют. Пришлите свежие скриншоты с полной стоимостью позиций и проверьте количество активов.';
 const lines=['<b>🧩 Структура портфеля</b>',`Оценённая часть: ≈ ${num(v.total)} ${html(v.currency)} · ${dateLabel(snapshot.as_of)}`];
 if(v.missing.length)lines.push(`Не оценено позиций: ${v.missing.length}. <b>Все доли ниже относятся только к оценённой части.</b>`);
 const names=new Map(v.entries.map(e=>[e.key,e.name])),assets=groups(v.entries,e=>e.key).map(([key,value])=>[names.get(key),value]),top3=assets.slice(0,3).reduce((sum,e)=>sum+e[1],0);
 lines.push('<b>Крупнейшие позиции</b>\n'+assets.slice(0,5).map(([label,value])=>`${html(label)} · <b>${num(value/v.total*100,1)}%</b>`).join('\n'));
 lines.push(`Три крупнейшие позиции: <b>${num(top3/v.total*100,1)}%</b>.`);
 const kinds={stock:'Акции',bond:'Облигации',crypto:'Криптовалюты',fund:'Фонды',cash:'Деньги',unknown:'Не определено'};
 lines.push('<b>Типы активов</b>\n'+groups(v.entries,e=>kinds[e.kind]||'Не определено').map(([label,value])=>`${label} · ${num(value/v.total*100,1)}%`).join('\n'));
 lines.push('<b>Валюты котировок</b>\n'+groups(v.entries,e=>e.currency).map(([label,value])=>`${html(label)} · ${num(value/v.total*100,1)}%`).join('\n')+'\nЭто валюты оценки, а не полный расчёт валютного риска.');
 const issuerNames=new Map(v.entries.filter(e=>e.issuer_id).map(e=>[e.issuer_id,e.issuer_name||e.name]));
 const issuers=groups(v.entries.filter(e=>e.issuer_id),e=>e.issuer_id);
 if(issuers.length)lines.push('<b>Известные эмитенты</b>\n'+issuers.slice(0,5).map(([id,value])=>`${html(issuerNames.get(id))} · ${num(value/v.total*100,1)}%`).join('\n'));
 lines.push('<b>Отрасли</b>\n'+groups(v.entries,e=>e.sector||'Не подтверждена').slice(0,8).map(([label,value])=>`${html(label)} · ${num(value/v.total*100,1)}%`).join('\n'));
 const metadataSources=[...new Set(Object.values(snapshot.facts||{}).flatMap(f=>[f?.metadata_source,f?.profile_source]).filter(safeUrl))].slice(0,5);
 if(metadataSources.length)lines.push(metadataSources.map((url,i)=>link(url,'Данные об эмитенте '+(i+1))).join(' · '));
 if(v.screenshot_count)lines.push(`Для ${v.screenshot_count} позиций использована стоимость с сохранённого скриншота. Это приблизительная оценка, не доходность.`);
 if(v.fx_used)lines.push(`Пересчёт по курсам ЦБ на ${dateLabel(snapshot.fx.as_of)}. ${link(snapshot.fx.source,'Курсы')}`);
 return lines.join('\n\n');
}

export function calendarText(snapshot,access,now=new Date()){
 const items=calendarItems(snapshot,access,now),lines=[`<b>🗓 Календарь · ${fullAccess(access)?30:7} дней</b>`],totals={};
 for(const e of items.slice(0,35)){
  let text=`<b>${dateLabel(e.date)} · ${html(e.asset)}</b>\n${html(clip(e.title,220))}`;
  if(e.estimate!==null&&Number.isFinite(e.estimate)){
   text+=`\nОжидаемая сумма: ≈ <b>${num(e.estimate)} ${html(e.currency)}</b> до налогов`;
   if(e.date_basis==='scheduled'&&['coupon','dividend'].includes(e.type))totals[e.currency]=(totals[e.currency]||0)+e.estimate;
  }else if(e.confirmed&&fullAccess(access))text+='\nСумма пока не определена';
  if(e.date_basis==='record')text+='\nДата реестра; день зачисления денег не подтверждён.';
  if(e.record_date)text+='\nРеестр: '+dateLabel(e.record_date)+'. Право на выплату зависит от владения на дату реестра.';
  text+='\n'+link(e.url,e.source||'Источник');lines.push(text);
 }
 if(!items.length)lines.push('В сохранённых данных нет подтверждённых событий на этот период.');
 if(Object.keys(totals).length)lines.push('<b>Объявленные купоны и дивиденды</b>\n'+Object.entries(totals).map(([c,v])=>`≈ ${num(v)} ${html(c)} до налогов`).join('\n'));
 const missing=portfolioAssets(snapshot.accounts||[]).filter(p=>['stock','bond'].includes(p.kind)&&snapshot.facts?.[p.key]?.status!=='ok');
 if(missing.length)lines.push(`Полный календарь выплат пока не подтверждён для ${missing.length} активов. Проверенные события из новостей показаны выше.`);
 lines.push('Расчёт по сохранённому количеству бумаг. Это ожидаемые выплаты; фактическое зачисление бот не видит.');
 return lines.join('\n\n');
}

export function summaryText(snapshot,access,{weekly=false}={}){
 const assets=portfolioAssets(snapshot.accounts||[]),items=stories(snapshot,{fresh:!weekly}),lines=[`<b>${weekly?'📅 Portfolius · итоги недели':'📊 Portfolius · главное за день'}</b>\n${weekly?dateLabel(snapshot.period_from)+' — ':''}${dateLabel(snapshot.as_of)}`];
 if(weekly)lines.push(`Сохранённых дневных выпусков за период: ${snapshot.days_count||1} из 7. Изменения цен считаются между доступными снимками.`);
 if(items.length)lines.push('<b>Главное по вашим активам</b>\n'+items.slice(0,2).map(n=>`• <b>${html(n.symbol||n.asset)}</b>: ${html(clip(n.fact,240))}`).join('\n'));
 else lines.push('Новых подтверждённых событий по проверенным активам в этом выпуске нет.');
 const movers=assets.map(p=>({p,change:finite(weekly?snapshot.week_change?.[p.key]:snapshot.quotes?.[p.key]?.change_pct)})).sort((a,b)=>Math.abs(b.change||0)-Math.abs(a.change||0)).slice(0,3);
 if(movers.length)lines.push('<b>Движения цен</b>\n'+movers.map(({p,change})=>`${change===null?'▫️':change>=0?'🟢':'🔴'} ${html(p.name)} · ${change===null?'нет данных':signed(change)}`).join('\n'));
 const events=calendarItems(snapshot,access,new Date(snapshot.as_of));
 if(events.length)lines.push('<b>Ближайшее событие</b>\n'+dateLabel(events[0].date)+' · '+html(events[0].asset)+' · '+html(clip(events[0].title,140)));
 if(snapshot.market?.items?.length)lines.push('<b>Рыночный фон</b>\n'+html(clip(snapshot.market.items[0].fact,230)));
 const newsCount=assets.filter(p=>snapshot.news?.[p.key]?.status==='ok').length,priced=assets.filter(p=>finite(snapshot.quotes?.[p.key]?.price)!==null).length;
 lines.push(`Проверено: новости ${newsCount}/${assets.length} · котировки ${priced}/${assets.length}.`);
 if(newsCount<assets.length||priced<assets.length)lines.push('Есть пробелы в данных — они отмечены в подробностях.');
 if(!weekly)lines.push('<i>Крипта — за 24 часа; бумаги — за последнюю сессию. Это изменения цен, не доходность портфеля.</i>');
 const offer=upgradeOffer(access,{hidden:snapshot.hidden});if(offer.text)lines.push(offer.text);
 return lines.join('\n\n');
}

export function detailText(snapshot,section,access){
 if(section==='structure')return structureText(snapshot,access);
 if(section==='calendar')return calendarText(snapshot,access,new Date(snapshot.as_of));
 if(section==='market')return '<b>🌍 Рыночный фон</b>\n\n'+(snapshot.market?.items?.map(n=>`${html(n.fact)}\n${link(n.url)}`).join('\n\n')||'Проверенные общерыночные новости отсутствуют в этом выпуске.');
 if(section==='news'){
  const items=stories(snapshot),lines=['<b>📰 Новости ваших активов</b>\nВыпуск от '+dateLabel(snapshot.as_of)];
  for(const n of items)lines.push(`<b>${html(n.asset)} · ${dateLabel(n.published_at)}</b>\n${html(n.fact)}\n<b>Почему это важно:</b> ${html(n.relevance)}\n${link(n.url)}`);
  if(!items.length)lines.push('Значимых подтверждённых новостей по проверенным активам в выпуске нет.');
  const gaps=portfolioAssets(snapshot.accounts||[]).filter(p=>snapshot.news?.[p.key]?.status!=='ok');
  if(gaps.length)lines.push('Не удалось проверить: '+gaps.map(p=>html(p.name)).join(', ')+'.');
  return lines.join('\n\n');
 }
 const lines=['<b>💼 Котировки и счета</b>\nВыпуск от '+dateLabel(snapshot.as_of)];
 for(const a of snapshot.accounts||[]){
  lines.push('<b>'+html(a.name)+'</b> · состав от '+dateLabel(a.updated_at));
  for(const p of a.positions){
   const q=snapshot.quotes?.[newsIdentity(p)],price=finite(q?.price);
   if(p.provider==='cash'){lines.push('💵 '+html(p.name)+' · '+html(p.quantity));continue;}
   const change=finite(q?.change_pct);
   lines.push(`<b>${html(p.name)}</b>\n${price===null?'Котировка недоступна':num(price,8)+' '+html(q.currency)+(change===null?'':' · '+signed(change))}\nКоличество: ${html(p.quantity??'не уточнено')}${q?.as_of?'\nПо состоянию на '+html(q.as_of.replace('T',' ').slice(0,19)):''}${q?.url?' · '+link(q.url):''}`);
  }
 }
 return lines.join('\n\n');
}

export function reportPages(report,snapshot,section,access){
 const text=section==='summary'?summaryText(snapshot,access,{weekly:report.kind==='weekly'}):detailText(snapshot,section,access);
 return splitText(text,3200);
}
export function reportKeyboard(id,section,access,page=0,pages=1){
 const button=(text,section,p=0)=>({text,callback_data:`report:${section}:${id}:${p}`});
 const keyboard=[];
 if(pages>1)keyboard.push([...(page>0?[button('← Назад',section,page-1)]:[]),...(page+1<pages?[button('Далее →',section,page+1)]:[])]);
 keyboard.push([button('💼 Активы','assets'),button('📰 Новости','news')],[button('🗓 Календарь','calendar'),button('🧩 Структура','structure')]);
 if(section!=='summary')keyboard.push([button('← Короткая сводка','summary')]);
 keyboard.push([{text:'📅 Итоги недели',callback_data:'insight:week'},{text:'🗂 Архив',callback_data:'insight:archive'}]);
 keyboard.push([button('🌍 Рынок','market'),{text:'💬 Вопрос по портфелю',callback_data:'insight:ask'}]);
 if(!fullAccess(access))keyboard.push([{text:'💎 Открыть весь портфель',callback_data:'billing:upgrade'}]);
 return keyboard;
}

export function weeklySnapshot(reports){
 const sorted=reports.toSorted((a,b)=>a.service_day.localeCompare(b.service_day)),latest=sorted.at(-1)?.snapshot;
 if(!latest)return null;
 const news={},week_change={};
 for(const p of portfolioAssets(latest.accounts||[])){
  const relevant=sorted.filter(r=>r.snapshot.news?.[p.key]),seen=new Set();
  news[p.key]={status:relevant.some(r=>r.snapshot.news[p.key].status==='ok')?'ok':'unavailable',items:[],events:latest.news?.[p.key]?.events||[]};
  for(const r of relevant)for(const item of r.snapshot.news[p.key].items||[])if(!seen.has(storyId(item))){seen.add(storyId(item));news[p.key].items.push(item);}
  const priced=sorted.filter(r=>finite(r.snapshot.quotes?.[p.key]?.price)>0),first=priced[0]?.snapshot.quotes[p.key],last=priced.at(-1)?.snapshot.quotes[p.key];
  if(priced.length>1&&first.currency===last.currency&&first.as_of!==last.as_of)week_change[p.key]=(last.price/first.price-1)*100;
 }
 return {...latest,news,week_change,days_count:new Set(sorted.map(r=>r.service_day)).size,period_from:sorted[0].service_day,previous_story_ids:[]};
}
