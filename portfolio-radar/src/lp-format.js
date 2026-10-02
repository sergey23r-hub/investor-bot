import {html} from './core.js';
import {ranked,comparison,resolvePosition,fresh,positive,normalizePosition,venueSuggestions,positionCandidates,candidateToken} from './lp-data.js';
export const LP_BUTTON=[{text:'💧 Доходность xStocks / USDC',callback_data:'lp:home:0'}];
export const lpPaid=access=>access?.tier==='paid';
const pct=n=>n===null||n===undefined?'нет данных':Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2})+'%';
const usd=n=>'$'+Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2});
const date=t=>t?new Date(t).toLocaleString('ru-RU',{timeZone:'UTC',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+' UTC':'не указано';
const snapshotDate=p=>(p?.positions||[]).map(r=>r.captured_at).filter(Boolean).sort()[0]||p?.updated_at;
const link=p=>`<a href="${html(p.url)}">${html(p.platform)} · ${html(p.network)}</a>`;
export const LP_CAVEAT='APR — индикатор комиссий всего пула: комиссии за 24 ч / текущий TVL × 365. До удержаний протокола, без капитализации и наград. Это не доходность вашей LP-позиции. Диапазон цены, изменение стоимости токена, IL, газ, проскальзывание и мосты меняют результат. Награды показаны отдельно; xPoints не оценены в долларах.';
export function teaser(pools,now=Date.now()){
 const p=ranked(pools,null,now).filter(p=>p.tvl>=50000&&p.fee_apr24h>0&&p.fee_apr24h<=300)[0];
 if(!p)return '💧 <b>xStocks / USDC</b>\nВ платной подписке — сравнение пулов и мониторинг ваших LP-позиций. Свежих сопоставимых данных для числового примера пока нет.';
 const dollars=1000*p.fee_apr24h/100*30/365;
 return `💧 <b>Потенциал xStocks / USDC</b>\n${html(p.asset)}: ${pct(p.fee_apr24h)} APR комиссий пула по данным за 24 ч. Условный пример на $1 000 — ${usd(dollars)} за 30 дней, если темп и доля комиссий сохранятся, до удержаний и расходов. Проверено ${date(p.observed_at)}.\n<i>Это сценарий, а не упущенная прибыль: LP меняет риск и состав вложения; возможен убыток.</i>\nПлатная подписка покажет площадки и сравнит ваши пулы.`;
}
export function poolLine(p,i,now=Date.now()){
 return `${i}. <b>${html(p.asset)} / USDC</b>${p.wrapped?' · обёртка':''}\n${link(p)}\n${fresh(p,now)?'APR комиссий 24 ч: <b>'+pct(p.fee_apr24h)+'</b>':'⚠️ Данные устарели'} · 7 д: ${pct(p.fee_apr7d)}\nНаграды: ${pct(p.reward_apr24h)} APR · TVL ${usd(p.tvl||0)}${p.estimated_fees?'\nКомиссии оценены: оборот × фиксированная ставка пула.':''}\nПроверено ${date(p.observed_at)}${p.provider_at?' · источник '+date(p.provider_at):''}\n<a href="${html(p.source)}">Данные</a>${p.fee_source?' · <a href="'+html(p.fee_source)+'">Ставка комиссии</a>':''} · <code>${html(p.address||p.key)}</code>`;
}
export function positionLine(row,pools,i,now=Date.now()){
 row=normalizePosition(row);
 const c=comparison(row,pools,now),amount=positive(row.capital_usd),lines=[`<b>${i}. ${html(row.symbol||'Актив не определён')} / USDC</b>`,`${html(row.platform||'Площадка не указана')} · ${html(row.network||'Сеть не указана')} · ${amount===null?'сумма неизвестна':usd(amount)}`];
 if(row.shown_rate!==null&&row.shown_rate!==undefined)lines.push(`На скриншоте: ${pct(row.shown_rate)} ${html(row.rate_type||'тип не указан')}; период ${html(row.rate_window||'не указан')}. Это сохранённое значение, не текущий замер.`);
 if(row.range_status==='out')lines.push('⚠️ На скриншоте позиция вне диапазона. Комиссии могут не начисляться.');
 if(!c.current)lines.push('⚠️ Точный пул не подтверждён. Нажмите «Уточнить мои пулы» и выберите площадку; разницу пока не считаем.');
 else if(!fresh(c.current,now))lines.push('⚠️ По вашему пулу нет свежего замера. Разницу не считаем.');
 else lines.push(`Ваш пул: ${pct(c.current.fee_apr24h)} APR комиссий 24 ч.`);
 if(c.best)lines.push(`Максимум среди сопоставимых ликвидных пулов этого актива: <b>${pct(c.best.fee_apr24h)}</b> — ${link(c.best)}.`);
 else lines.push('Сопоставимых свежих вариантов пока нет.');
 if(c.delta!==null){
  lines.push(c.delta>0?`Разница индикаторов: <b>+${c.delta.toFixed(2)} п.п.</b>${c.monthly!==null?`. Условно ${usd(c.monthly)} за 30 д на вашу сумму, если доля комиссий равна доле капитала`:''}. Это не фактически недополученный доход.`:'Ваш пул уже среди лидеров доступной выборки по этому индикатору.');
  if(c.cross_chain)lines.push('🌉 Другой блокчейн: стоимость и доступность переноса не учтены.');
 }
 return lines.join('\n');
}
export function previewText(imp,pools,page=0){
 const pages=Math.max(1,Math.ceil(imp.rows.length/4));page=Math.min(Math.max(Number(page)||0,0),pages-1);
 const unresolved=imp.rows.filter(r=>!resolvePosition(r,pools).pool).length;
 const lines=imp.rows.slice(page*4,page*4+4).map((input,i)=>{
  const r=normalizePosition(input);
  const matched=resolvePosition(r,pools).pool;
  return `${page*4+i+1}. <b>${html(r.symbol||'Не определён')} / USDC</b>\n${html(r.platform||'Площадка не определена')} · ${html(r.network||'сеть неизвестна')} · ${r.capital_usd===null?'сумма не распознана':usd(r.capital_usd)}\nКомиссия: ${pct(r.fee_tier_pct)}${r.pool_type?' · '+html(r.pool_type):''}\n${matched?'Пул сопоставлен: <code>'+html(matched.address)+'</code>':'Выберите площадку или пул кнопкой ниже'}${r.range_status==='out'?'\n⚠️ На скриншоте вне диапазона':''}${r.issue?'\n⚠️ '+html(r.issue):''}`;
 });
 return {text:`📸 <b>Проверьте LP-позиции · ${page+1}/${pages}</b>\nСопоставлено ${imp.rows.length-unresolved} из ${imp.rows.length}.${unresolved?' Неопределённые позиции: '+unresolved+'.':''}\n\n${lines.join('\n\n')||'Список пуст: сохранение удалит текущие LP-позиции.'}\n\n<b>Сохранение заменит текущий список (${imp.rows.length} строк).</b>${unresolved?'\nЕсли все позиции с одной площадки — подтвердите её кнопкой. Совпадение актива и комиссии — подсказка, а не доказательство.':''}\nИсправить сумму: <code>/poolfix 1 сумма=1000</code>. Удалить: <code>/poolfix 1 удалить</code>.\n\n${(imp.warnings||[]).slice(0,2).map(w=>'⚠️ '+html(String(w).slice(0,160))).join('\n')}\nПосле сохранения включится ежедневный мониторинг. /pause останавливает рассылку.`,pages,page};
}
export function matchingButtons(imp,pools,page=0){
 const keyboard=venueSuggestions(imp.rows,pools).slice(0,4).map(g=>[{text:`Это ${g.platform} · ${g.network} (${g.count} поз.)`,callback_data:`lp:venue:${imp.id}:${g.key}`}]);
 for(let i=page*4;i<Math.min(imp.rows.length,page*4+4);i++)if(!resolvePosition(imp.rows[i],pools).pool)keyboard.push([{text:`Выбрать пул №${i+1} · ${imp.rows[i].symbol||'?'}`,callback_data:`lp:choose:${imp.id}:${i}.0`}]);
 return keyboard;
}
export function candidatesView(imp,pools,ref){
 const [i,offset]=String(ref).split('.').map(Number),row=imp.rows[i];if(!row||!Number.isInteger(i)||!Number.isInteger(offset)||offset<0)return null;
 const candidates=positionCandidates(row,pools),start=Math.min(offset,Math.max(0,Math.floor((candidates.length-1)/5)*5)),visible=candidates.slice(start,start+5),keyboard=[];
 const lines=visible.map((p,j)=>`${start+j+1}. ${link(p)} · комиссия ${pct(p.fee_tier_pct)}\nTVL ${usd(p.tvl||0)}\n<code>${html(p.address)}</code>`);
 visible.forEach(p=>keyboard.push([{text:`${p.platform} · ${p.network} · ${p.address.slice(0,6)}…`,callback_data:`lp:pick:${imp.id}:${i}.${candidateToken(p)}`} ]));
 if(candidates.length>5)keyboard.push([...(start>0?[{text:'←',callback_data:`lp:choose:${imp.id}:${i}.${start-5}`}]:[]),...(start+5<candidates.length?[{text:'→',callback_data:`lp:choose:${imp.id}:${i}.${start+5}`}]:[])]);
 keyboard.push([{text:'← Проверка списка',callback_data:`lp:preview:${imp.id}:${Math.floor(i/4)}`}]);
 return {text:`🔎 <b>Пул №${i+1} · ${html(row.symbol||'?')} / USDC</b>\nВыберите свой пул по площадке и адресу. Доходность не определяет, какой пул принадлежит вам.\n\n${lines.join('\n\n')||'Подходящих адресов в кэше пока нет. Данные обновляются автоматически.'}\n\nЕсли нужного пула нет: <code>/poolfix ${i+1} сеть=Solana площадка=Raydium пул=АДРЕС</code>.`,keyboard};
}
export function poolsView({access,profile,markets,section='home',page=0,now=Date.now()}){
 const all=markets.flatMap(m=>m.data?.pools||[]),keyboard=[];
 if(!lpPaid(access))return {text:teaser(all,now)+'\n\n<b>Мониторинг LP — только в оплаченной подписке, 290 ₽ в неделю.</b> Пробные 3 дня обычного портфеля эту функцию не включают.',keyboard:[[{text:'💎 Подключить мониторинг',callback_data:'lp:upgrade'}],[{text:'← Главный экран',callback_data:'ui:home'}]]};
 const positions=(profile?.positions||[]).map(normalizePosition);let text,pages=1;
 if(section==='coverage'){
  pages=Math.max(1,markets.length);page=Math.min(Math.max(Number(page)||0,0),pages-1);const m=markets[page]?.data;
  const label={not_indexed:'пул пока не найден в индексе',ok:'проверен',partial:'неполная выдача',unavailable:'недоступен',no_verified_usdc:'в реестре нет USDC для проверки пары'};
  text='🔎 <b>Покрытие источников</b>\n\n'+(m?`<b>${html(m.symbol)}</b> · ${date(m.checked_at)}\n`+(m.coverage||[]).map(c=>`${html(c.source)}: ${label[c.status]||'нет данных'}`).join('\n'):'Сбор данных ещё идёт.')+'\n\nПроверяем все сети и обёртки этого актива из реестра xStocks. Поиск ограничен индексами источников: отсутствие пула в выдаче не доказывает его отсутствие в сети. Пул без проверяемой методики доходности не участвует в рейтинге. Обёртки и мостовые версии USDC несут дополнительные риски.';
 }else if(section==='unrated'){
  const ids=new Set(ranked(all,null,now).map(p=>p.key)),other=all.filter(p=>!ids.has(p.key)).sort((a,b)=>(b.tvl||0)-(a.tvl||0));
  pages=Math.max(1,Math.ceil(other.length/4));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  text=`🔎 <b>Остальные найденные пулы · ${page+1}/${pages}</b>\n\n`+(other.slice(page*4,page*4+4).map(p=>`<b>${html(p.asset)} / USDC</b> · ${link(p)}\nTVL ${usd(p.tvl||0)} · ${!fresh(p,now)?'замер устарел':p.fee_apr24h===null?'сопоставимый APR не подтверждён':'не проходит фильтр ликвидности/аномалий'}\n${p.address?'<code>'+html(p.address)+'</code>':'Карточка агрегатора: адрес пула не подтверждён'}\nПроверено ${date(p.observed_at)}`).join('\n\n')||'Других проверенных пар пока нет.')+'\n\nПроверены контракты пары, но для рейтинга нужна свежая сопоставимая доходность и достаточная ликвидность. Карточка агрегатора может описывать уже показанный пул.';
 }else if(section==='market'||!positions.length){
  const poolList=ranked(all,null,now);pages=Math.max(1,Math.ceil(poolList.length/3));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  text=`💧 <b>xStocks / USDC · ${page+1}/${pages}</b>\nСопоставимые пулы: TVL ≥ $10 000, оборот ≥ $1 000/сутки; аномалии свыше 1 000% исключены.\n\n`+(poolList.slice(page*3,page*3+3).map((p,i)=>poolLine(p,page*3+i+1,now)).join('\n\n')||'Свежие сопоставимые данные пока собираются. Уведомления придут после добавления ваших LP-позиций.')+'\n\n'+LP_CAVEAT;
 }else if(section==='positions'){
  pages=Math.max(1,Math.ceil(positions.length/2));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  const comps=positions.map(r=>comparison(r,all,now)),better=comps.filter(c=>c.delta>0),max=better.length?Math.max(...better.map(c=>c.delta)):0;
  text=`💧 <b>Ваши LP-позиции · ${page+1}/${pages}</b>\nПроверено: ${comps.filter(c=>c.delta!==null).length}/${positions.length}. Выше индикатор в других пулах: ${better.length}${max?' · до +'+max.toFixed(2)+' п.п.':''}.\nСуммы сохранены со скриншота ${date(snapshotDate(profile))}.\n\n`+positions.slice(page*2,page*2+2).map((r,i)=>positionLine(r,all,page*2+i+1,now)).join('\n\n')+'\n\n'+LP_CAVEAT;
 }else{
  pages=Math.max(1,Math.ceil(positions.length/10));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  const comps=positions.map(r=>comparison(r,all,now)),matched=comps.filter(c=>c.current).length,better=comps.filter(c=>c.delta>0),known=positions.filter(r=>r.capital_usd!==null),total=known.reduce((s,r)=>s+r.capital_usd,0),out=positions.filter(r=>r.range_status==='out');
  text=`💧 <b>Ваши пулы · ${positions.length} позиций</b>\nСумма со скриншотов: <b>${usd(total)}</b>${known.length<positions.length?' (не все суммы известны)':''}\nСопоставлено: ${matched}/${positions.length} · сравнение доступно: ${comps.filter(c=>c.delta!==null).length}/${positions.length}\n\n`;
  if(out.length)text+=`⚠️ <b>Вне диапазона на скриншоте: ${out.map(r=>html(r.symbol)).join(', ')}</b>\nТакая позиция обычно не получает торговые комиссии, пока цена вне диапазона. Текущий статус без нового снимка не подтверждён.\n\n`;
  if(matched<positions.length)text+='🔎 <b>Нужно уточнить площадку</b>\nАктивы, суммы и комиссии сохранены. Подберём адреса по этим данным — нажмите «Уточнить мои пулы». CLMM — тип пула, а не название биржи.\n\n';
  text+='<b>Позиции · сумма · APR/APY со скриншота</b>\n'+positions.slice(page*10,page*10+10).map((r,i)=>`${page*10+i+1}. ${r.range_status==='out'?'⚠️ ':''}<b>${html(r.symbol||'?')}</b> · ${r.capital_usd===null?'сумма ?':usd(r.capital_usd)} · ${r.shown_rate===null?'ставка ?':pct(r.shown_rate)+' '+html(r.rate_type||'тип ?')}`).join('\n');
  text+=`\n\n<b>Сравнение пулов</b>\n${better.length?'В '+better.length+' поз. есть пул с более высоким индикатором комиссий. До +'+Math.max(...better.map(c=>c.delta)).toFixed(2)+' п.п. Подробности — в «Сравнении по активам».':matched<positions.length?'Разницу посчитаем после подтверждения пулов.':comps.some(c=>c.delta!==null)?'Среди проверенных вариантов нет более высокого сопоставимого индикатора.':'Ждём свежие сопоставимые замеры.'}\n\nСнимок: ${date(snapshotDate(profile))}. Ставки со скриншота не являются текущим замером. Сравнение использует комиссии всего пула; личная доходность зависит от диапазона и расходов.`;
  keyboard.push([{text:'Сравнение по активам',callback_data:'lp:positions:0'}]);
 }
 if(positions.some(r=>!resolvePosition(r,all).pool))keyboard.push([{text:'🔎 Уточнить мои пулы',callback_data:'lp:match:0'}]);
 if(pages>1)keyboard.push([...(page>0?[{text:'←',callback_data:`lp:${section}:${page-1}`}]:[]),...(page+1<pages?[{text:'→',callback_data:`lp:${section}:${page+1}`}]:[])]);
  keyboard.push([{text:'📸 Добавить / заменить пулы',callback_data:'lp:upload'}]);
  keyboard.push([{text:'Другие найденные пулы',callback_data:'lp:unrated:0'}]);
 if(positions.length)keyboard.push([{text:'Мои LP-позиции',callback_data:'lp:home:0'},{text:'Все доступные пулы',callback_data:'lp:market:0'}]);
 keyboard.push([{text:'Источники и охват',callback_data:'lp:coverage:0'},{text:'← Главный экран',callback_data:'ui:home'}]);
 return {text,keyboard};
}
