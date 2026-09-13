// Shared by the edge runtime and Node tests. No external dependencies.
export const LIMITS = Object.freeze({ images:8, bytes:8*1024*1024, rows:100, accounts:5 });
export const html = s => String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function decimal(value) {
  if (value == null || value === '' || value === '?') return null;
  let s=String(value).trim().replace(/[\s\u00a0\u202f]/g,'');
  if (s.includes(',') && s.includes('.')) throw new Error('Неоднозначный формат числа');
  s=s.replace(',','.');
  if (!/^\+?\d+(\.\d{1,18})?$/.test(s)) throw new Error('Нужно неотрицательное число без обозначения валюты');
  let [i,f='']=s.replace(/^\+/,'').split('.'); i=i.replace(/^0+(?=\d)/,''); f=f.replace(/0+$/,'');
  if (i.length>20) throw new Error('Слишком большое число');
  return i+(f?'.'+f:'');
}
export function safeUrl(value) {
  try { if(String(value).length>1000)return null;const u=new URL(value); if(u.protocol!=='https:' || u.username || u.password) return null; return u.href; } catch { return null; }
}
export function canonicalUrl(value) {
  const s=safeUrl(value); if(!s)return null; const u=new URL(s); u.hash='';
  for(const k of [...u.searchParams.keys()])if(k.startsWith('utm_')||['fbclid','gclid'].includes(k))u.searchParams.delete(k);
  return u.href.replace(/\/$/,'');
}
export function normalizeRows(rows) {
  if(!Array.isArray(rows)||!rows.length||rows.length>LIMITS.rows)throw new Error('Не найдено позиций или их больше 100');
  const map=new Map();
  for(const raw of rows){
    const r={...raw, quantity:decimal(raw.quantity), average_price:decimal(raw.average_price), observed_value:decimal(raw.observed_value)};
    if(!r.name || !r.key) throw new Error('У позиции отсутствует название');
    if(map.has(r.key)){
      const p=map.get(r.key);
      if(p.quantity!==r.quantity || (p.average_price&&r.average_price&&p.average_price!==r.average_price))
        throw new Error(`Разное количество или цена у ${r.name}. Пришлите актуальные скриншоты одного счёта.`);
      // Overlapping screenshots describe balances: never sum them.
      map.set(r.key,{...p,average_price:p.average_price??r.average_price,observed_value:p.observed_value??r.observed_value});
    }else map.set(r.key,r);
  }
  return [...map.values()];
}
// A broker can show blocked and ordinary holdings under the same display name.
// Preserve conflicting observations for review; never guess that they are one lot.
export function prepareRows(rows){
  const groups=new Map();
  for(const raw of rows){const r=normalizeRows([raw])[0];const g=groups.get(r.key)||[];g.push(r);groups.set(r.key,g);}
  const result=[];
  for(const [key,group] of groups){
    try{result.push(...normalizeRows(group));}
    catch(e){
      if(!e.message.startsWith('Разное количество'))throw e;
      const distinct=[...new Map(group.map(r=>[JSON.stringify([r.quantity,r.average_price,r.observed_value]),r])).values()];
      for(const [i,r] of distinct.entries())result.push({...r,key:`unresolved:separate:${key}:${i+1}`,verified:false,provider:null,provider_id:null,symbol:null,isin:null,
        issue:'Несколько отдельных строк с одним названием. Сохраняю отдельно; для точного определения нужен тикер или ISIN каждой строки.'});
    }
  }
  return normalizeRows(result);
}
export function mergePositions(oldRows,incoming,mode='partial'){
  if(!['partial','replace'].includes(mode))throw new Error('Неверный режим обновления');
  const rows=normalizeRows(incoming), map=new Map(mode==='partial'?oldRows.map(r=>[r.key,{...r}]):[]);
  for(const r of rows){
    if(r.quantity==='0'){map.delete(r.key);continue;}
    // Missing fields are unknown in a new observation, never silently carry old quantities.
    map.set(r.key,{...r});
  }
  return [...map.values()];
}
export function changes(oldRows,nextRows){
  const a=new Map(oldRows.map(r=>[r.key,r])),b=new Map(nextRows.map(r=>[r.key,r]));
  return {added:nextRows.filter(r=>!a.has(r.key)),removed:oldRows.filter(r=>!b.has(r.key)),changed:nextRows.filter(r=>a.has(r.key)&&JSON.stringify(a.get(r.key))!==JSON.stringify(r))};
}
export function newsWindow(kind,now=new Date()){
  const day=now.getUTCDay();
  if(kind!=='crypto'&&(day===6||day===0||(day===1&&now.getUTCHours()<12))){
    const since=new Date(now);since.setUTCDate(since.getUTCDate()-(day===6?1:day===0?2:3));since.setUTCHours(0,0,0,0);
    return {since:since.toISOString(),hours:(now-since)/3600000,label:'с '+since.toLocaleDateString('ru-RU',{timeZone:'UTC'})+', включая последнюю торговую сессию'};
  }
  return {since:new Date(now-86400000).toISOString(),hours:24,label:'за последние 24 часа'};
}
export function validateNews(items,allowedSources,now=new Date(),windowHours=24){
  const allowed=new Set(allowedSources.map(canonicalUrl).filter(Boolean));const seen=new Set();const valid=[];
  for(const n of items??[]){
    const url=canonicalUrl(n.url),d=new Date(n.published_at),event=new Date(n.event_date);
    if(!url||!allowed.has(url)||!Number.isFinite(+d)||!Number.isFinite(+event))continue;
    if(+d>+now+300000||+now-+d>windowHours*3600000||+event>+now+300000||+now-+event>Math.max(48,windowHours+24)*3600000)continue;
    if(!n.fact||!n.relevance||seen.has(url))continue;
    seen.add(url);valid.push({...n,url});
  }
  return valid.slice(0,3);
}
export function formatPositions(rows){
  return rows.map((r,i)=>`${i+1}. <b>${html(r.name)}</b>${r.symbol?' · '+html(r.symbol):''}\n${r.quantity==null?'Количество не видно':'Количество: '+html(r.quantity)}${r.observed_value!=null?' · на скриншоте: '+html(r.observed_value)+' '+html(r.currency||''):''}${r.verified?'':'\n⚠️ '+html(r.issue||'Нужен тикер или ISIN для точного определения.')}`).join('\n\n');
}
export function splitText(text,max=3800){
  const parts=[];let current='';
  for(const paragraph of text.split('\n\n')){
    // Callers only construct short HTML blocks. Never cut an HTML tag in half.
    if(paragraph.length>max)throw new Error('Слишком длинный блок сообщения');
    if(current.length+paragraph.length+2>max){parts.push(current);current='';}
    current+=(current?'\n\n':'')+paragraph;
  }if(current)parts.push(current);return parts;
}
export function jsonOutput(response){
  if(response.status && response.status!=='completed')throw new Error('Анализ не завершился');
  const text=(response.output??[]).filter(x=>x.type==='message').flatMap(x=>x.content??[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
  if(!text)throw new Error('Модель не вернула результат');return JSON.parse(text);
}
export function sourceUrls(response){
  return (response.output??[]).flatMap(x=>[
    ...(x.action?.sources??[]).map(s=>s.url),
    ...(x.content??[]).flatMap(c=>(c.annotations??[]).filter(a=>a.type==='url_citation').map(a=>a.url))
  ]).filter(Boolean);
}
export function extractFile(message){
  const p=message.photo?.at(-1)??message.document;
  if(!p)return null;
  if(message.document&&!['image/png','image/jpeg','image/webp'].includes(message.document.mime_type))throw new Error('Отправьте PNG, JPEG или WebP');
  if(p.file_size>LIMITS.bytes)throw new Error('Изображение должно быть не больше 8 МБ');
  return {file_id:p.file_id,unique_id:p.file_unique_id,mime:message.document?.mime_type??'image/jpeg'};
}
const shortDate=(value,withTime=false)=>{
  const d=new Date(value);if(!Number.isFinite(+d))return 'дата не указана';
  return d.toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',...(withTime?{hour:'2-digit',minute:'2-digit'}:{})});
};
const newsPeriod=n=>n?.checked_at&&n?.window_since?shortDate(n.window_since,true)+' — '+shortDate(n.checked_at,true)+' МСК':n?.window_label||'за последние 24 часа';
const link=(url,label)=>safeUrl(url)?`<a href="${html(url)}">${html(label)}</a>`:html(label);
export function digestText({accounts,quotes,news,market,now=new Date()}){
  const all=accounts.flatMap(a=>a.positions),assets=[...new Map(all.filter(p=>p.verified&&p.provider!=='cash').map(p=>[p.key,p])).values()];
  const unresolved=all.filter(p=>!p.verified),checked=assets.filter(p=>news[p.key]?.status==='ok'),priced=assets.filter(p=>quotes[p.key]?.price!=null);
  const lines=[`📊 <b>Ваш портфель · ${shortDate(now)}</b>\nКотировки: ${priced.length}/${assets.length} · Новости проверены: ${checked.length}/${assets.length}${unresolved.length?' · Уточнить: '+unresolved.length:''}`];
  lines.push('🌍 <b>Главное на рынке</b>\n'+html(newsPeriod(market)));
  if(market?.items?.length)for(const n of market.items)lines.push(`• ${html(n.fact)}\n${link(n.url,'Источник · '+shortDate(n.published_at))}`);
  else lines.push(market?.status==='ok'?'Значимых общерыночных новостей за этот период не найдено.':'⚠️ Общерыночные новости сейчас недоступны.');
  lines.push('💼 <b>Котировки и счета</b>');
  for(const account of accounts){
    lines.push(`<b>${html(account.name)}</b> · состав от ${shortDate(account.updated_at)}`);
    for(const p of account.positions.filter(p=>p.verified)){
      if(p.provider==='cash'){lines.push(`💵 ${html(p.name)} · ${html(p.quantity??'не указан')} ${html(p.currency??p.provider_id??'')}`);continue;}
      const q=quotes[p.key],change=Number(q?.change_pct),arrow=q?.change_pct==null?'▫️':change>0?'🟢':change<0?'🔴':'▫️';
      let block=`${arrow} <b>${html(p.name)}</b>${p.symbol?' · '+html(p.symbol):''}`;
      if(q?.price!=null){
        const price=Number(q.price).toLocaleString('ru-RU',{maximumFractionDigits:8});
        block+=`\n${html(price)} ${html(q.currency)}${q.change_pct!=null?'  |  <b>'+(change>0?'+':'')+change.toFixed(2)+'%</b>':''}\n${link(q.url,shortDate(q.as_of,true)+' МСК · котировка')}`;
      }else block+='\nКотировка временно недоступна';
      lines.push(block);
    }
  }
  const times=checked.map(p=>news[p.key].checked_at).filter(Boolean).sort();
  lines.push('📰 <b>Новости ваших активов</b>\nОбщий дневной выпуск'+(times.length?' · проверено '+shortDate(times[0],true)+(times.at(-1)!==times[0]?' — '+shortDate(times.at(-1),true):'')+' МСК':'')+'\nСобытия после проверки попадут в следующий выпуск.');
  const seen=new Set(),events=new Map();let stories=0;
  for(const p of assets){
    const n=news[p.key];if(n?.status!=='ok')continue;
    for(const item of n.items||[]){
      if(seen.has(item.url))continue;seen.add(item.url);stories++;
      const names=assets.filter(a=>news[a.key]?.status==='ok'&&news[a.key]?.items?.some(x=>x.url===item.url)).map(a=>a.symbol||a.name);
      lines.push(`<b>${html(names.join(' · ').slice(0,240))}</b>\n${html(newsPeriod(n))}\n• ${html(item.fact)}\n<b>Почему это важно:</b> ${html(item.relevance)}\n${link(item.url,'Источник · '+shortDate(item.published_at))}`);
    }
    for(const e of n.events||[])events.set(e.url+'|'+e.date,{...e,asset:p.symbol||p.name});
  }
  if(!stories&&checked.length)lines.push('Значимых новостей по проверенным активам за указанный период не найдено.');
  const gaps=assets.filter(p=>news[p.key]?.status!=='ok');
  if(gaps.length)lines.push('⚠️ Не удалось проверить новости: '+html(gaps.map(p=>p.symbol||p.name).join(', '))+'. Отсутствие данных не означает отсутствие событий.');
  if(!assets.length)lines.push('Уточните названия инструментов через /edit — после этого появятся персональные новости.');
  for(const e of market?.events||[])events.set(e.url+'|'+e.date,{...e,asset:'Рынок'});
  if(events.size){lines.push('🗓 <b>Ближайшие события</b>');for(const e of [...events.values()].sort((a,b)=>a.date.localeCompare(b.date)))lines.push(`<b>${shortDate(e.date)} · ${html(e.asset)}</b>\n${html(e.title)} · ${link(e.url,'источник')}`);}
  if(unresolved.length){
    lines.push(`🔎 <b>Нужно уточнить · ${unresolved.length}</b>\nПозиции сохранены. Для котировок и новостей нужен точный тикер или ISIN.\n/edit — выбрать строку и исправить`);
    for(const a of accounts){const entries=a.positions.map((p,i)=>({p,i})).filter(({p})=>!p.verified);for(let i=0;i<entries.length;i+=10)lines.push(`<b>${html(a.name)}</b>\n`+entries.slice(i,i+10).map(({p,i})=>`${i+1}. ${html(p.name)} · количество: ${html(p.quantity??'?')}`).join('\n'));}
  }
  lines.push('<i>Изменения: крипта — за 24 часа, бумаги — за последнюю сессию. Цены справочные, возможна задержка; доступность продажи уточняйте у брокера. Это обзор событий, а не доходность портфеля.</i>');
  return splitText(lines.join('\n\n'),3600).map((part,i)=>i?`📊 <b>Ваш портфель · продолжение ${i+1}</b>\n\n${part}`:part);
}
