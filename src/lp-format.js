import {html} from './core.js';
import {ranked,comparison,resolvePosition,fresh,positive,normalizePosition,venueSuggestions,positionCandidates,candidateToken,globalTopPools} from './lp-data.js';
import {portfolioProposals,opportunity,opportunitySummary} from './lp-opportunities.js';
export const LP_BUTTON=[{text:'💧 Доходность xStocks / USDC',callback_data:'lp:home:0'}];
export const TOP5_BUTTON=[{text:'🔥 Топ-5 пулов сейчас',callback_data:'lp:top:0'}];
export const lpPaid=access=>access?.tier==='paid';
const pct=n=>n===null||n===undefined?'нет данных':Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2})+'%';
const usd=n=>'$'+Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2});
const date=t=>t?new Date(t).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+' МСК':'не указано';
const snapshotDate=p=>(p?.positions||[]).map(r=>r.captured_at).filter(Boolean).sort()[0]||p?.updated_at;
const link=p=>`<a href="${html(p.url)}">${html(p.platform)} · ${html(p.network)}</a>`;
export const LP_CAVEAT='APR — индикатор комиссий всего пула: комиссии за 24 ч / текущий TVL × 365. До удержаний протокола, без капитализации и наград. Это не доходность вашей LP-позиции. Диапазон цены, изменение стоимости токена, IL, газ, проскальзывание и мосты меняют результат. Награды показаны отдельно; xPoints не оценены в долларах.';
const SCENARIO='Сценарная оценка: одинаковая сохранённая сумма и диапазон, текущие цена и активная ликвидность, средний темп комиссий за 24 ч. Доля протокола вычтена. Цена и ликвидность условно неизменны; история нахождения в диапазоне не учтена. Без наград, IL и неуказанных расходов. Не фактическая прибыль и не прогноз; USDC ≈ $1.';
const price=n=>Number(n).toLocaleString('ru-RU',{maximumFractionDigits:6});
const bounds=r=>r.range_lower>0&&r.range_upper>r.range_lower?`${price(r.range_lower)}–${price(r.range_upper)} USDC за токен`:'границы не указаны';
const effective=e=>`${price(e.lower)}–${price(e.upper)}`;
const REASONS={range_quote_missing:'Не удалось однозначно определить единицы цены после пересчёта токена. Пришлите карточку позиции с границами и настройкой цены.',pool_missing:'Сначала подтвердите свой пул.',current_unavailable:'Замер вашего пула устарел или не прошёл проверку. Ждём автообновление.',range_missing:'Не хватает границ диапазона. Добавьте их со скриншота или через /poolfix.',range_invalid:'Границы некорректны: минимум должен быть больше нуля и меньше максимума.',amount_needed:'Нужна сумма позиции в долларах для одинакового капитала на обеих площадках.',range_unsupported:'Расчёт для диапазона этого типа пула или сети пока не поддерживается.',range_data_missing:'Недостаточно проверенных данных об активной ликвидности и комиссиях. Ждём автообновление.',range_data_stale:'Данные о диапазоне устарели. Ждём автообновление.',range_identity:'Не удалось подтвердить одинаковые контракты токенов.',range_rounding:'Допустимый шаг цены заметно меняет ваши границы. Такой диапазон нельзя корректно сравнить.',range_fees_missing:'Нет подтверждённого объёма комиссий для расчёта.',position_too_large:'Сумма слишком велика относительно активной ликвидности для этой модели.',alternatives_missing:'Нет свежих альтернатив с сопоставимыми границами и ценой. Общий APR не подставляем.'};
const names=items=>items.slice(0,5).map(o=>html(o.row?.symbol||o.symbol||'?')).join(', ')+(items.length>5?` и ещё ${items.length-5}`:'');
export function top5Summary(markets,now=Date.now()){
 const {pools,eligible}=globalTopPools(markets.flatMap(m=>m.data?.pools||[]),now);
 const lines=pools.map((p,i)=>`${i+1}. <b>${html(p.asset)}</b> · ${html(p.platform)} / ${html(p.network)} · комиссия ${pct(p.fee_tier_pct)} · <b>${pct(p.fee_apr24h)} APR</b>`);
 return `🔥 <b>Топ-5 пулов xStocks / USDC</b>\nОбщий рейтинг по APR комиссий за 24 ч, независимо от ваших позиций.\n\n${lines.join('\n')||'Свежих подходящих пулов пока нет. Обновляем автоматически.'}${pools.length&&pools.length<5?'\nСейчас доступны '+pools.length+' из 5: остальные не проходят фильтры.':''}\n\nНаблюдаем ${markets.length} активов · подходят ${eligible} пулов.${pools.length?' Замеры: '+date(pools.map(p=>p.observed_at).sort()[0])+' — '+date(pools.map(p=>p.observed_at).sort().at(-1))+'.':''}\nДо удержаний и расходов; высокий APR не гарантирует личную доходность. Подробности и ссылки — «Топ-5 пулов сейчас».`;
}
export function top5View(markets,now=Date.now()){
 const {pools,eligible}=globalTopPools(markets.flatMap(m=>m.data?.pools||[]),now);
 const cards=pools.map((p,i)=>`${i+1}. <b>${html(p.asset)} / USDC — ${pct(p.fee_apr24h)} APR</b>\n${link(p)} · комиссия ${pct(p.fee_tier_pct)}${p.wrapped?' · обёртка':''}\nAPR за 7 д: ${pct(p.fee_apr7d)} · награды: ${pct(p.reward_apr24h)} APR\nTVL ${usd(p.tvl)} · оборот за 24 ч ${usd(p.volume24h)}${p.estimated_fees?'\nКомиссии оценены по обороту и ставке пула.':''}\nПроверено ${date(p.observed_at)} · <a href="${html(p.source)}">Источник</a>`);
 return `🔥 <b>Топ-5 пулов сейчас · xStocks / USDC</b>\nПо последним доступным замерам, от большего APR комиссий за 24 ч к меньшему. Общий рейтинг не зависит от вашего портфеля.\nНаблюдаем ${markets.length} активов; фильтры прошли ${eligible} пулов.\n\n${cards.join('\n\n')||'Свежих подходящих пулов пока нет. Обновление идёт автоматически.'}${pools.length&&pools.length<5?'\n\nСейчас доступны '+pools.length+' из 5: недостающие строки не заполняем устаревшими данными.':''}\n\nФильтры: замер ≤ 4 ч, TVL ≥ $10 000, оборот ≥ $1 000/сутки, APR ≤ 1 000%. Обновляем примерно раз в час. Охват ограничен проверенными источниками.\n\n${LP_CAVEAT}`;
}
export function opportunityLine(o){
 const r=o.row,title=`<b>${html(r.symbol||'?')}</b>${r.capital_usd!==null?' · '+usd(r.capital_usd):''}`,e=o.current_estimate;
 const range=e?.status==='ok'?`Диапазон: ${price(e.requested_lower)}–${price(e.requested_upper)} USDC за токен${e.range_quote==='scaled'&&r.range_basis_multiplier!==e.stock_multiplier?' (после пересчёта токена)':''}`:`Диапазон: ${bounds(r)}`;
 if(o.status==='range')return `⚠️ ${title}\n${range}\nТекущая цена ${price(o.current_estimate.price)} USDC вне диапазона. По этому замеру торговые комиссии не начисляются. Перенос с теми же границами это не исправит.`;
 if(o.delta===null)return `🔎 ${title}\n${range}\n${REASONS[o.reason]||'Сопоставимых данных пока нет.'}`;
 const a=o.current_estimate,b=o.best_estimate,coverage=`Сопоставлено альтернатив: ${o.coverage.checked}/${o.coverage.total}.`;
 if(o.status==='keep')return `✅ ${title}\n${range}\n${link(o.current)} · оценка для диапазона ${pct(a.apr)} APR. При текущих условиях преимущество от перехода не найдено среди сопоставимых вариантов.\n${coverage}`;
 const labels={opportunity:'🟢 Выше оценка комиссий в вашем диапазоне',costs:'🔴 Расходы съедают прибавку за 30 дней',spike:'🟡 Преимущество только при суточном темпе',small:'🟡 Разница небольшая',review:'⚠️ Нужна проверка пула'};
 const lines=[`${labels[o.status]||'Сравнение'}\n${title}`,range,`${link(o.current)} · комиссия ${pct(o.current.fee_tier_pct)} → ${link(o.best)} · комиссия ${pct(o.best.fee_tier_pct)}`,`Оценка для диапазона: ${pct(a.apr)} → <b>${pct(b.apr)} APR</b> · +${o.delta.toFixed(2)} п.п.`];
 if(a.rounded||b.rounded)lines.push(`Эффективные границы после шага цены: ${html(o.current.platform)} ${effective(a)}; ${html(o.best.platform)} ${effective(b)} USDC.`);
 if(o.monthly!==null&&o.delta>0){
  lines.push(`Разница на ту же сумму: <b>≈ +${usd(o.monthly)} за 30 дней</b> при неизменных условиях.`);
  if(o.cost===null)lines.push(`Расходы на переход должны быть ниже ${usd(o.monthly)}, чтобы покрыться за 30 дней по этому сценарию.`);
  else lines.push(`Расходы: ${usd(o.cost)}. После них: ${o.after_cost<0?'−':'+'}${usd(Math.abs(o.after_cost))} за 30 дней. Окупаемость: ≈ ${Math.ceil(o.payback_days)} д.`);
 }
 if(o.weekly_delta!==null&&o.delta>0)lines.push(o.weekly_delta>0?`При среднем темпе комиссий за 7 д: +${o.weekly_delta.toFixed(2)} п.п. Это сценарий с текущей ликвидностью, не результат за неделю.`:'При среднем темпе комиссий за 7 д преимущества нет.');
 else if(o.delta>0)lines.push('Комиссии за 7 д неизвестны; устойчивость не подтверждена.');
 lines.push(coverage+' Замер '+date([a.observed_at,b.observed_at].sort()[0])+'.');
 return lines.join('\n');
}
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
 const result=opportunity(row,pools,now);
 return opportunityLine(result)+`\nНа скриншоте: ${row.shown_rate===null?'ставка неизвестна':pct(row.shown_rate)+' '+html(row.rate_type||'тип неизвестен')}. Сумма и ставка сохранены, не являются текущим замером.`+(result.current?'\nТекущий пул: <code>'+html(result.current.address)+'</code>':'');
}
function detailedPreviewText(imp,pools,page=0){
 const pages=Math.max(1,Math.ceil(imp.rows.length/4));page=Math.min(Math.max(Number(page)||0,0),pages-1);
 const unresolved=imp.rows.filter(r=>!resolvePosition(r,pools).pool).length;
 const lines=imp.rows.slice(page*4,page*4+4).map((input,i)=>{
  const r=normalizePosition(input);
  const matched=resolvePosition(r,pools).pool;
  return `${page*4+i+1}. <b>${html(r.symbol||'Не определён')} / USDC</b>\n${html(r.platform||'Площадка не определена')} · ${html(r.network||'сеть неизвестна')} · ${r.capital_usd===null?'сумма не распознана':usd(r.capital_usd)}\nДиапазон: ${bounds(r)}\nКомиссия: ${pct(r.fee_tier_pct)}${r.pool_type?' · '+html(r.pool_type):''}\n${matched?'Пул сопоставлен: <code>'+html(matched.address)+'</code>':'Выберите площадку или пул кнопкой ниже'}${r.range_status==='out'?'\n⚠️ На скриншоте вне диапазона':''}${r.issue?'\n⚠️ '+html(r.issue):''}`;
 });
 return {text:`📸 <b>Проверьте LP-позиции · ${page+1}/${pages}</b>\nСопоставлено ${imp.rows.length-unresolved} из ${imp.rows.length}.${unresolved?' Неопределённые позиции: '+unresolved+'.':''}\n\n${lines.join('\n\n')||'Список пуст: сохранение удалит текущие LP-позиции.'}\n\n<b>Сохранение заменит текущий список (${imp.rows.length} строк).</b>${unresolved?'\nЕсли все позиции с одной площадки — подтвердите её кнопкой. Совпадение актива и комиссии — подсказка, а не доказательство.':''}\nИсправить сумму: <code>/poolfix 1 сумма=1000</code>. Границы в USDC: <code>/poolfix 1 минимум=150 максимум=180</code>. Удалить: <code>/poolfix 1 удалить</code>.\n\n${(imp.warnings||[]).slice(0,2).map(w=>'⚠️ '+html(String(w).slice(0,160))).join('\n')}\nПосле сохранения включится ежедневный мониторинг. /pause останавливает рассылку.`,pages,page};
}
export function previewText(imp,pools,page=0,manual=false){
 if(manual)return detailedPreviewText(imp,pools,page);
 const pages=Math.max(1,Math.ceil(imp.rows.length/10));page=Math.min(Math.max(Number(page)||0,0),pages-1);
 const proposals=portfolioProposals(imp.rows,pools),one=proposals.length===1?proposals[0]:null;
 const rows=imp.rows.map(normalizePosition),total=rows.reduce((s,r)=>s+(r.capital_usd||0),0);
 let text=`📸 <b>Нашёл ${rows.length} LP-позиций · ${usd(total)}</b>\n\n`;
 if(one)text+=`<b>Похоже, ваши пулы — ${html(one.platform)} · ${html(one.network)}.</b>\nПодобрали адреса по активам и комиссиям. Если всё верно — подтвердите и сохраните одной кнопкой.\n\n`;
 else if(proposals.length>1)text+='Подходят несколько площадок. Выберите свою — адреса подставим сами.\n\n';
 text+=rows.slice(page*10,page*10+10).map((r,i)=>`${page*10+i+1}. <b>${html(r.symbol||'?')}</b> · ${r.capital_usd===null?'сумма ?':usd(r.capital_usd)} · комиссия ${pct(r.fee_tier_pct)}${r.range_status==='out'?' · ⚠️ вне диапазона на снимке':''}\nДиапазон: ${bounds(r)}${!one?'\n'+html(r.platform||'площадку подбираем')+' · '+html(r.network||'сеть уточняем'):''}`).join('\n');
 text+=`\n\nСохранение заменит прежний список LP-позиций. Затем покажем, где можно получать больше, и включим ежедневные предложения.\n${(imp.warnings||[]).slice(0,2).map(w=>'⚠️ '+html(String(w).slice(0,120))).join('\n')}`;
 return {text,pages,page,proposals};
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
 keyboard.push([{text:'← Проверка списка',callback_data:`lp:options:${imp.id}:${Math.floor(i/4)}`}]);
 return {text:`🔎 <b>Пул №${i+1} · ${html(row.symbol||'?')} / USDC</b>\nВыберите свой пул по площадке и адресу. Доходность не определяет, какой пул принадлежит вам.\n\n${lines.join('\n\n')||'Подходящих адресов в кэше пока нет. Данные обновляются автоматически.'}\n\nЕсли нужного пула нет: <code>/poolfix ${i+1} сеть=Solana площадка=Raydium пул=АДРЕС</code>.`,keyboard};
}
export function poolsView({access,profile,markets,section='home',page=0,now=Date.now()}){
 const all=markets.flatMap(m=>m.data?.pools||[]),keyboard=[];
 if(!lpPaid(access))return {text:teaser(all,now)+'\n\n<b>Мониторинг LP — только в оплаченной подписке, 290 ₽ в неделю.</b> Пробные 3 дня обычного портфеля эту функцию не включают.',keyboard:[[{text:'💎 Подключить мониторинг',callback_data:'lp:upgrade'}],[{text:'← Главный экран',callback_data:'ui:home'}]]};
 const positions=(profile?.positions||[]).map(normalizePosition);let text,pages=1;
 if(section==='coverage'){
  pages=Math.max(1,markets.length);page=Math.min(Math.max(Number(page)||0,0),pages-1);const m=markets[page]?.data;
  const label={not_indexed:'пул пока не найден в индексе',ok:'проверен',partial:'неполная выдача',unavailable:'недоступен',no_verified_usdc:'в реестре нет USDC для проверки пары'};
  text='🔎 <b>Покрытие источников</b>\n\n'+(m?`<b>${html(m.symbol)}</b> · ${date(m.checked_at)}\n`+(m.coverage||[]).map(c=>`${html(c.source)}: ${label[c.status]||'нет данных'}${c.total!==undefined?' · '+c.checked+'/'+c.total:''}`).join('\n'):'Сбор данных ещё идёт.')+'\n\nПроверяем все сети и обёртки этого актива из реестра xStocks. Поиск ограничен индексами источников: отсутствие пула в выдаче не доказывает его отсутствие в сети. Пул без проверяемой методики доходности не участвует в рейтинге. Обёртки и мостовые версии USDC несут дополнительные риски.';
 }else if(section==='unrated'){
  const ids=new Set(ranked(all,null,now).map(p=>p.key)),other=all.filter(p=>!ids.has(p.key)).sort((a,b)=>(b.tvl||0)-(a.tvl||0));
  pages=Math.max(1,Math.ceil(other.length/4));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  text=`🔎 <b>Остальные найденные пулы · ${page+1}/${pages}</b>\n\n`+(other.slice(page*4,page*4+4).map(p=>`<b>${html(p.asset)} / USDC</b> · ${link(p)}\nTVL ${usd(p.tvl||0)} · ${!fresh(p,now)?'замер устарел':p.fee_apr24h===null?'сопоставимый APR не подтверждён':'не проходит фильтр ликвидности/аномалий'}\n${p.address?'<code>'+html(p.address)+'</code>':'Карточка агрегатора: адрес пула не подтверждён'}\nПроверено ${date(p.observed_at)}`).join('\n\n')||'Других проверенных пар пока нет.')+'\n\nПроверены контракты пары, но для рейтинга нужна свежая сопоставимая доходность и достаточная ликвидность. Карточка агрегатора может описывать уже показанный пул.';
 }else if(section==='top'||section==='home'&&!positions.length){
  text=top5View(markets,now);
 }else if(section==='market'||!positions.length){
  const poolList=ranked(all,null,now);pages=Math.max(1,Math.ceil(poolList.length/3));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  text=`💧 <b>xStocks / USDC · ${page+1}/${pages}</b>\nСопоставимые пулы: TVL ≥ $10 000, оборот ≥ $1 000/сутки; аномалии свыше 1 000% исключены.\n\n`+(poolList.slice(page*3,page*3+3).map((p,i)=>poolLine(p,page*3+i+1,now)).join('\n\n')||'Свежие сопоставимые данные пока собираются. Уведомления придут после добавления ваших LP-позиций.')+'\n\n'+LP_CAVEAT;
 }else if(section==='positions'){
  pages=Math.max(1,Math.ceil(positions.length/2));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  const comps=positions.map(r=>comparison(r,all,now)),better=comps.filter(c=>c.delta>0),max=better.length?Math.max(...better.map(c=>c.delta)):0;
  text=`💧 <b>Ваши LP-позиции · ${page+1}/${pages}</b>\nПроверено: ${comps.filter(c=>c.delta!==null).length}/${positions.length}. Выше оценка в том же диапазоне: ${better.length}${max?' · до +'+max.toFixed(2)+' п.п.':''}.\nСуммы сохранены со скриншота ${date(snapshotDate(profile))}.\n\n`+positions.slice(page*2,page*2+2).map((r,i)=>positionLine(r,all,page*2+i+1,now)).join('\n\n')+'\n\n'+SCENARIO;
 }else if(section==='holdings'){
  pages=Math.max(1,Math.ceil(positions.length/10));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  const comps=positions.map(r=>comparison(r,all,now)),matched=comps.filter(c=>c.current).length,better=comps.filter(c=>c.delta>0),known=positions.filter(r=>r.capital_usd!==null),total=known.reduce((s,r)=>s+r.capital_usd,0),out=positions.filter(r=>r.range_status==='out');
  text=`💧 <b>Ваши пулы · ${positions.length} позиций</b>\nСумма со скриншотов: <b>${usd(total)}</b>${known.length<positions.length?' (не все суммы известны)':''}\nСопоставлено: ${matched}/${positions.length} · сравнение доступно: ${comps.filter(c=>c.delta!==null).length}/${positions.length}\n\n`;
  if(out.length)text+=`⚠️ <b>Вне диапазона на скриншоте: ${out.map(r=>html(r.symbol)).join(', ')}</b>\nТакая позиция обычно не получает торговые комиссии, пока цена вне диапазона. Текущий статус без нового снимка не подтверждён.\n\n`;
  if(matched<positions.length)text+='🔎 <b>Нужно уточнить площадку</b>\nАктивы, суммы и комиссии сохранены. Подберём адреса по этим данным — нажмите «Уточнить мои пулы». CLMM — тип пула, а не название биржи.\n\n';
  text+='<b>Позиции · сумма · APR/APY со скриншота</b>\n'+positions.slice(page*10,page*10+10).map((r,i)=>`${page*10+i+1}. ${r.range_status==='out'?'⚠️ ':''}<b>${html(r.symbol||'?')}</b> · ${r.capital_usd===null?'сумма ?':usd(r.capital_usd)} · ${r.shown_rate===null?'ставка ?':pct(r.shown_rate)+' '+html(r.rate_type||'тип ?')}\nДиапазон: ${bounds(r)}`).join('\n');
  text+=`\n\n<b>Сравнение пулов</b>\n${better.length?'В '+better.length+' поз. есть пул с более высокой оценкой комиссий в том же диапазоне. До +'+Math.max(...better.map(c=>c.delta)).toFixed(2)+' п.п. Подробности — в «Сравнении по активам».':matched<positions.length?'Разницу посчитаем после подтверждения пулов.':comps.some(c=>c.delta!==null)?'Среди проверенных вариантов нет более высокой оценки в том же диапазоне.':'Ждём свежие сопоставимые замеры.'}\n\nСнимок: ${date(snapshotDate(profile))}. Ставки со скриншота не являются текущим замером. Сравнение использует одинаковые сумму и границы, текущую активную ликвидность и комиссии. Общий APR пула показан отдельно в топ-5.`;
  keyboard.push([{text:'Сравнение по активам',callback_data:'lp:positions:0'}]);
 }else{
  const proposals=portfolioProposals(positions,all,now),proposal=proposals.length===1?proposals[0]:null;
  const summary=opportunitySummary(proposal?.rows||positions,all,now),offers=summary.sorted.filter(o=>o.delta>0&&!['range','review'].includes(o.status));
  pages=Math.max(1,Math.ceil(offers.length/2));page=Math.min(Math.max(Number(page)||0,0),pages-1);
  text=`💧 <b>Где ваш капитал может приносить больше</b>\n${positions.length} позиций · ${usd(positions.reduce((s,r)=>s+(r.capital_usd||0),0))} по сохранённым снимкам\n\n`;
  if(proposal){
   text+=`🔎 <b>Похоже, ваши пулы — ${html(proposal.platform)} · ${html(proposal.network)}.</b> Подобрали ${proposal.count}. Подтвердите одной кнопкой; ниже — предварительный расчёт при этом предположении.\n\n`;
   keyboard.push([{text:`✅ Да, это мои пулы · подтвердить ${proposal.count}`,callback_data:`lp:accept:${profile.version}:${proposal.token}`}]);
   keyboard.push([{text:'Другая площадка / посмотреть варианты',callback_data:'lp:match:0'}]);
  }else if(summary.pending.length)text+='🔎 Часть пулов пока не определена. Предложим подходящие варианты кнопкой ниже.\n\n';
  else text+='✅ Пулы определены. Сравнение обновляется автоматически.\n\n';
  if(summary.gain>0)text+=`<b>Потенциал дополнительного дохода от комиссий: ≈ +${usd(summary.gain)} за 30 дней</b>\nВариантов с заметной прибавкой: ${summary.offers.length}. ${proposal?'Предварительно. ':''}Если темп сохранится; до неуказанных расходов.\n\n`;
  else if(summary.all.some(o=>o.delta===null))text+='Недостаточно данных для полного сравнения ваших диапазонов. Причины по каждой позиции — в «Сравнении по всем активам».\n\n';
  else text+='В сопоставимых диапазонах заметной прибавки сейчас не нашли.\n\n';
  if(summary.range.length)text+=`⚠️ <b>Вне диапазона по текущему замеру: ${names(summary.range)}</b>. Перенос с теми же границами не восстановит начисление комиссий.\n\n`;
  text+=offers.slice(page*2,page*2+2).map(opportunityLine).join('\n\n');
  if(summary.keep.length)text+=`\n\n✅ <b>В проверенных диапазонах преимущества нет:</b> ${names(summary.keep)}.`;
  if(!offers.length&&summary.pending.length){
   const picks=summary.pending.filter(o=>o.best).slice(0,3);
   if(picks.length)text+='\n\n<b>Лучшие найденные варианты для ваших активов</b>\n'+picks.map(o=>`${html(o.row.symbol)}: ${link(o.best)} · ${pct(o.best.fee_apr24h)} APR. Разницу с вашим пулом ещё уточняем.`).join('\n');
  }
  text+=`\n\n<i>${SCENARIO}</i>\nСнимки: ${date(snapshotDate(profile))}.\nПроверяем примерно раз в час. Ежедневная сводка — /time; устойчивые значимые изменения — отдельным сообщением, не чаще раза в сутки. /pause — остановить.`;
  const top=top5Summary(markets,now);text+='\n\n'+(text.length+top.length<3950?top:'🔥 Общий рейтинг пулов — кнопка «Топ-5 пулов сейчас». Он не учитывает ваш диапазон.');
  keyboard.push([{text:'Сравнение по всем активам',callback_data:'lp:positions:0'},{text:'Мои позиции',callback_data:'lp:holdings:0'}]);
 }
 if(section!=='top')keyboard.push(TOP5_BUTTON);
 if(section!=='home'&&positions.some(r=>!resolvePosition(r,all).pool)||section==='home'&&!portfolioProposals(positions,all,now).length&&positions.some(r=>!resolvePosition(r,all).pool))keyboard.push([{text:'🔎 Предложить мои пулы',callback_data:'lp:match:0'}]);
 if(pages>1)keyboard.push([...(page>0?[{text:'←',callback_data:`lp:${section}:${page-1}`}]:[]),...(page+1<pages?[{text:'→',callback_data:`lp:${section}:${page+1}`}]:[])]);
  keyboard.push([{text:'📸 Добавить / заменить пулы',callback_data:'lp:upload'}]);
  keyboard.push([{text:'Другие найденные пулы',callback_data:'lp:unrated:0'}]);
 keyboard.push([{text:'Моя выгода',callback_data:'lp:home:0'},{text:'Все доступные пулы',callback_data:'lp:market:0'}]);
 keyboard.push([{text:'Источники и охват',callback_data:'lp:coverage:0'},{text:'← Главный экран',callback_data:'ui:home'}]);
 return {text,keyboard};
}

