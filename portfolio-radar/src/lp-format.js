import {html} from './core.js';
import {ranked,comparison,resolvePosition,fresh,positive} from './lp-data.js';
export const LP_BUTTON=[{text:'💧 Доходность xStocks / USDC',callback_data:'lp:home:0'}];
export const lpPaid=access=>access?.tier==='paid';
const pct=n=>n===null||n===undefined?'нет данных':Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2})+'%';
const usd=n=>'$'+Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2});
const date=t=>t?new Date(t).toLocaleString('ru-RU',{timeZone:'UTC',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+' UTC':'не указано';
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
 const c=comparison(row,pools,now),amount=positive(row.capital_usd),lines=[`<b>${i}. ${html(row.symbol||'Актив не определён')} / USDC</b>`,`${html(row.platform||'Площадка не указана')} · ${html(row.network||'Сеть не указана')} · ${amount===null?'сумма неизвестна':usd(amount)}`];
 if(row.shown_rate!==null&&row.shown_rate!==undefined)lines.push(`На скриншоте: ${pct(row.shown_rate)} ${html(row.rate_type||'тип не указан')}; период ${html(row.rate_window||'не указан')}. Это сохранённое значение, не текущий замер.`);
 if(row.range_status==='out')lines.push('⚠️ На скриншоте позиция вне диапазона. Комиссии могут не начисляться.');
 if(!c.current)lines.push('⚠️ Точный пул не подтверждён. Уточните адрес через /poolfix; личную разницу пока не считаем.');
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
 const lines=imp.rows.slice(page*4,page*4+4).map((r,i)=>{
  const matched=resolvePosition(r,pools).pool;
  return `${page*4+i+1}. <b>${html(r.symbol||'Не определён')} / USDC</b>\n${html(r.platform||'?')} · ${html(r.network||'?')} · ${r.capital_usd===null?'сумма не распознана':usd(r.capital_usd)}\n${matched?'Пул сопоставлен: '+html(matched.address):'Нужно уточнить точный адрес пула'}${r.issue?'\n⚠️ '+html(r.issue):''}`;
 });
 return {text:`📸 <b>Проверьте LP-позиции · ${page+1}/${pages}</b>\n\n${lines.join('\n\n')||'Список пуст: сохранение удалит текущие LP-позиции.'}\n\n<b>Новый список заменит все сохранённые LP-позиции (${imp.rows.length} строк).</b>\nИсправить: <code>/poolfix 1 актив=MSFTx сеть=Solana площадка=Raydium сумма=1000 пул=АДРЕС</code>\nМожно указать только нужное поле. Удалить: <code>/poolfix 1 удалить</code>.\n\n${(imp.warnings||[]).slice(0,2).map(w=>'⚠️ '+html(String(w).slice(0,160))).join('\n')}\nПосле сохранения включится ежедневный мониторинг. /pause останавливает рассылку.`,pages,page};
}
export function poolsView({access,profile,markets,section='home',page=0,now=Date.now()}){
 const all=markets.flatMap(m=>m.data?.pools||[]),keyboard=[];
 if(!lpPaid(access))return {text:teaser(all,now)+'\n\n<b>Мониторинг LP — только в оплаченной подписке, 290 ₽ в неделю.</b> Пробные 3 дня обычного портфеля эту функцию не включают.',keyboard:[[{text:'💎 Подключить мониторинг',callback_data:'lp:upgrade'}],[{text:'← Главный экран',callback_data:'ui:home'}]]};
 const positions=profile?.positions||[];let text,pages=1;
 if(section==='coverage'){
  pages=Math.max(1,markets.length);page=Math.min(Math.max(Number(page)||0,0),pages-1);const m=markets[page]?.data;
  const label={ok:'проверен',partial:'неполная выдача',unavailable:'недоступен',no_verified_usdc:'в реестре нет USDC для проверки пары'};
  text='🔎 <b>Покрытие источников</b>\n\n'+(m?`<b>${html(m.symbol)}</b> · ${date(m.checked_at)}\n`+(m.coverage||[]).map(c=>`${html(c.source)}: ${label[c.status]||'нет данных'}`).join('\n'):'Сбор данных ещё идёт.')+'\n\nПроверяем все сети и обёртки этого актива из реестра xStocks. Поиск ограничен индексами источников: отсутствие пула в выдаче не доказывает его отсутствие в сети. Пул без проверяемой методики доходности не участвует в рейтинге. Обёртки и мостовые версии USDC несут дополнительные риски.';
 }else if(section==='unrated'){
  const ids=new Set(ranked(all,null,now).map(p=>p.key)),other=all.filter(p=>!ids.has(p.key)).sort((a,b)=>(b.tvl||0)-(a.tvl||0));
  pages=Math.max(1,Math.ceil(other.length/4));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  text=`🔎 <b>Остальные найденные пулы · ${page+1}/${pages}</b>\n\n`+(other.slice(page*4,page*4+4).map(p=>`<b>${html(p.asset)} / USDC</b> · ${link(p)}\nTVL ${usd(p.tvl||0)} · ${!fresh(p,now)?'замер устарел':p.fee_apr24h===null?'сопоставимый APR не подтверждён':'не проходит фильтр ликвидности/аномалий'}\n${p.address?'<code>'+html(p.address)+'</code>':'Карточка агрегатора: адрес пула не подтверждён'}\nПроверено ${date(p.observed_at)}`).join('\n\n')||'Других проверенных пар пока нет.')+'\n\nПроверены контракты пары, но для рейтинга нужна свежая сопоставимая доходность и достаточная ликвидность. Карточка агрегатора может описывать уже показанный пул.';
 }else if(section==='market'||!positions.length){
  const poolList=ranked(all,null,now);pages=Math.max(1,Math.ceil(poolList.length/3));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  text=`💧 <b>xStocks / USDC · ${page+1}/${pages}</b>\nСопоставимые пулы: TVL ≥ $10 000, оборот ≥ $1 000/сутки; аномалии свыше 1 000% исключены.\n\n`+(poolList.slice(page*3,page*3+3).map((p,i)=>poolLine(p,page*3+i+1,now)).join('\n\n')||'Свежие сопоставимые данные пока собираются. Уведомления придут после добавления ваших LP-позиций.')+'\n\n'+LP_CAVEAT;
 }else{
  pages=Math.max(1,Math.ceil(positions.length/2));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  const comps=positions.map(r=>comparison(r,all,now)),better=comps.filter(c=>c.delta>0),max=better.length?Math.max(...better.map(c=>c.delta)):0;
  text=`💧 <b>Ваши LP-позиции · ${page+1}/${pages}</b>\nПроверено: ${comps.filter(c=>c.delta!==null).length}/${positions.length}. Выше индикатор в других пулах: ${better.length}${max?' · до +'+max.toFixed(2)+' п.п.':''}.\nСуммы сохранены со скриншота ${date(profile.updated_at)}.\n\n`+positions.slice(page*2,page*2+2).map((r,i)=>positionLine(r,all,page*2+i+1,now)).join('\n\n')+'\n\n'+LP_CAVEAT;
 }
 if(pages>1)keyboard.push([...(page>0?[{text:'←',callback_data:`lp:${section}:${page-1}`}]:[]),...(page+1<pages?[{text:'→',callback_data:`lp:${section}:${page+1}`}]:[])]);
  keyboard.push([{text:'📸 Добавить / заменить пулы',callback_data:'lp:upload'}]);
  keyboard.push([{text:'Другие найденные пулы',callback_data:'lp:unrated:0'}]);
 if(positions.length)keyboard.push([{text:'Мои LP-позиции',callback_data:'lp:home:0'},{text:'Все доступные пулы',callback_data:'lp:market:0'}]);
 keyboard.push([{text:'Источники и охват',callback_data:'lp:coverage:0'},{text:'← Главный экран',callback_data:'ui:home'}]);
 return {text,keyboard};
}
