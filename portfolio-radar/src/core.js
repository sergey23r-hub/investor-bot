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
export function validateNews(items,allowedSources,now=new Date()){
  const allowed=new Set(allowedSources.map(canonicalUrl).filter(Boolean));const seen=new Set();const valid=[];
  for(const n of items??[]){
    const url=canonicalUrl(n.url),d=new Date(n.published_at),event=new Date(n.event_date);
    if(!url||!allowed.has(url)||!Number.isFinite(+d)||!Number.isFinite(+event))continue;
    if(+d>+now+300000||+now-+d>24*3600000||+event>+now+300000||+now-+event>48*3600000)continue;
    if(!n.fact||!n.relevance||seen.has(url))continue;
    seen.add(url);valid.push({...n,url});
  }
  return valid.slice(0,3);
}
export function formatPositions(rows){
  return rows.map((r,i)=>`${i+1}. <b>${html(r.name)}</b>${r.symbol?' · '+html(r.symbol):''}\n${r.quantity==null?'Количество не видно — только новости':'Количество: '+html(r.quantity)}${r.verified?'':'\n⚠️ Инструмент не определён: '+html(r.issue||'уточните название')}`).join('\n\n');
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
export function digestText({accounts,quotes,news,market,now=new Date()}){
  const lines=[`<b>Ваш портфель · ${now.toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'})}</b>`];
  if(market?.items?.length)lines.push('<b>Рынок за последние 24 часа</b>\n'+market.items.map(n=>`${html(n.fact)}\n<a href="${html(n.url)}">Источник</a>`).join('\n'));
  else lines.push(market?.status==='ok'?'Значимых общерыночных новостей за последние 24 часа не найдено.':'Общерыночные новости сейчас недоступны.');
  const seenNews=new Set();
  for(const account of accounts){
    lines.push(`<b>${html(account.name)}</b> · состав обновлён ${new Date(account.updated_at).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow'})}`);
    for(const p of account.positions){
      if(p.provider==='cash'){lines.push(`<b>${html(p.name)}</b> · денежный остаток: ${html(p.quantity??'не указан')} ${html(p.currency??p.provider_id??'')}`);continue;}
      const q=quotes[p.key],n=news[p.key];let block=`<b>${html(p.name)}</b>`;
      if(q?.price!=null)block+=` · ${html(q.price)} ${html(q.currency)}${q.change_pct!=null?' ('+(Number(q.change_pct)>0?'+':'')+Number(q.change_pct).toFixed(2)+'%)':''}\nКотировка: ${html(q.as_of)} · ${html(q.basis)}`;
      else block+='\nСвежая котировка недоступна.';
      if(!p.verified){block+='\nУточните инструмент в портфеле — персональные новости пока не подбираются.';}
      else if(n?.status==='ok'){
        const fresh=n.items.filter(x=>!seenNews.has(x.url));
        if(fresh.length)block+='\n'+fresh.map(x=>{seenNews.add(x.url);return `${html(x.fact)}\nЗначение: ${html(x.relevance)}\n<a href="${html(x.url)}">Источник · ${html(x.published_at.slice(0,10))}</a>`;}).join('\n\n');
        else block+='\n'+(n.items.length?'Связанная новость уже приведена выше.':'Значимых новостей за последние 24 часа не найдено.');
        if(n.events?.length)block+='\nБлижайшее: '+n.events.map(e=>`${html(e.date)} — ${html(e.title)} <a href="${html(e.url)}">источник</a>`).join('; ');
      }else block+='\nНе удалось проверить новости; это не означает отсутствие событий.';
      lines.push(block);
    }
  }
  lines.push('Состав — по последним подтверждённым скриншотам. Крипта: изменение за 24 часа; биржевые бумаги: за торговую сессию. Это обзор событий, а не расчёт полной доходности.');
  return splitText(lines.join('\n\n'));
}
