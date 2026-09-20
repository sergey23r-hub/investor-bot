import {html,safeUrl} from './core.js';
import {newsIdentity} from './daily.js';
import {valuation,fullAccess} from './report-format.js';
import {DAY,FINAM_LICENSE} from './outlook-data.js';

const n=(x,d=2)=>Number(x).toLocaleString('ru-RU',{maximumFractionDigits:d});
const date=s=>new Date(s).toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric'});
const link=(url,title)=>safeUrl(url)?'<a href="'+html(url)+'">'+html(title)+'</a>':'';
export function outlookAssets(accounts){
 const all=new Map();for(const a of accounts)for(const p of a.positions||[]){
  const key=p.verified&&p.provider!=='cash'?newsIdentity(p):p.key;if(!key)continue;
  if(!all.has(key))all.set(key,{...p,key});
 }return [...all.values()].sort((a,b)=>a.key.localeCompare(b.key));
}
export function largestHolding(accounts,market,now=new Date()){
 const valid=accounts.map(a=>({...a,positions:(a.positions||[]).filter(p=>p.quantity===null||p.quantity===undefined||p.quantity===''||Number(p.quantity)!==0||Number(p.observed_value)>0)}));
 const v=valuation({...market,accounts:valid,as_of:now.toISOString()});
 // A partial valuation cannot establish the largest holding across the portfolio.
 if(v.missing.length||!v.entries.length)return {key:null,reason:'valuation_incomplete'};
 const values=new Map();for(const p of v.entries){if(!(p.converted>=0&&Number.isFinite(p.converted)))return {key:null,reason:'valuation_incomplete'};values.set(p.key,(values.get(p.key)||0)+p.converted);}
 const sorted=[...values].filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
 return sorted.length?{key:sorted[0][0],value:sorted[0][1],currency:v.currency,approximate:v.screenshot_count>0}:{key:null,reason:'empty'};
}
const horizon=h=>h==='12m'?'12 месяцев от даты оценки':h?'конец '+h+' года':'срок не указан';
export function outlookCard(asset,data,now=new Date()){
 const lines=['<b>'+html(String(asset.name||asset.symbol||'Актив').slice(0,110))+'</b>'];
 if(!asset.verified&&asset.provider!=='cash'){lines.push('Инструмент ещё не подтверждён. Уточните тикер или ISIN через /edit, чтобы получать оценки именно по нему.');return lines.join('\n\n');}
 const age=+now-Date.parse(data?.checked_at);
 if(!data||!Number.isFinite(age)||age<0||age>7*DAY){lines.push('Подтверждённых данных пока нет. Проверка источников проходит автоматически.');return lines.join('\n\n');}
 lines.push('<i>Проверено: '+date(data.checked_at)+(age>DAY?' · сохранённые данные':'')+'</i>');
 const c=data.consensus;
 if(c){
  lines.push('<b>Консенсус доступных оценок</b>\nМедианная цель: '+n(c.median)+' '+html(c.currency)+'\nДиапазон: '+n(c.low)+'–'+n(c.high)+' '+html(c.currency)+'\nНезависимых аналитических домов: '+c.count+'\nГоризонт: '+horizon(c.horizon)+'\nДаты оценок: '+date(c.oldest)+' — '+date(c.latest));
  const q=data.quote,qa=+now-Date.parse(q?.as_of);
  // Never compare a USD target with a RUB quote, a bond percentage or a token derivative.
  if(q?.status==='ok'&&q.currency===c.currency&&Number(q.price)>0&&qa>=0&&qa<=7*DAY)lines.push('Отклонение цели от цены '+n(q.price)+' '+html(q.currency)+' ('+date(q.as_of)+'): '+n((c.median/q.price-1)*100)+'%. Дивиденды не учтены.');
  lines.push(c.sources.slice(0,6).map(o=>link(o.url,o.house+' · '+date(o.published_at))).join(' · '));
 }else if(data.opinions?.length){
  lines.push('<b>Отдельные оценки аналитиков</b>\nСопоставимых независимых оценок пока недостаточно для консенсуса.');
  lines.push(data.opinions.slice(0,3).map(o=>link(o.url,o.house)+' · '+n(o.target)+' '+html(o.currency)+'\n'+horizon(o.horizon)+' · '+date(o.published_at)).join('\n\n'));
 }else lines.push('Сопоставимых прогнозов аналитиков в подключённых открытых источниках пока нет.');
 if(c||data.opinions?.length)lines.push('<i>Факты извлечены автоматически из публикаций Финам. '+link(FINAM_LICENSE,'CC BY 4.0')+'. Это выборка доступных оценок, не весь рынок.</i>');
 if(asset.kind==='bond'){
  const b=data.bond;
  if(b){const rows=[];if(b.yield!==null){const type=b.yield_type==='MATDATE'?'к погашению':b.yield_type==='OFFER'?'к оферте':'к расчётной дате биржи';rows.push('Эффективная доходность '+type+': '+n(b.yield)+'%'+(b.yield_date?' · '+date(b.yield_date):''));}if(b.coupon_pct!==null)rows.push('Текущая ставка купона: '+n(b.coupon_pct)+'%');if(b.maturity)rows.push('Погашение: '+date(b.maturity));if(rows.length)lines.push('<b>Параметры выпуска · '+link(b.source,'Мосбиржа')+'</b>\n'+rows.join('\n')+(b.as_of?'\nТорги: '+date(b.as_of):'')+'\nДоходность — расчёт по цене и денежным потокам, не прогноз и не гарантия выплат.');}
  lines.push('При снижении рыночных ставок цена облигаций с фиксированным купоном обычно растёт; кредитный риск может изменить эту связь. Для флоатеров и структурных выпусков зависимость иная.');
 }else if(asset.kind==='crypto'){
  const c=data.crypto,ca=+now-Date.parse(c?.as_of);
  if(c&&ca>=0&&ca<=2*DAY)lines.push('<b>Рынок бессрочных контрактов</b>\nПоследняя ставка фандинга: '+n(c.rate_pct,5)+'%\nОтклонение маркировочной цены от индекса: '+n(c.basis_pct,3)+'%\n'+link(c.source,'Binance · '+date(c.as_of))+'\nЭто условия рынка деривативов. Они не предсказывают рост или падение токена.');
 }else if(asset.kind==='fund')lines.push('<b>Как читать оценки фонда</b>\nПрогноз по фонду требует его актуального состава и весов. Цели по отдельным акциям не переносим на стоимость пая; цель по индексу также не является целью фонда.');
 else if(asset.provider==='cash'||asset.kind==='cash')lines.push('<b>Валюта и покупательная способность</b>\nМакропрогноз ниже помогает оценить фон. Это не обещание курса обмена или доходности денежных остатков.');
 const macro=data.macro;
 if(macro&&(['bond','fund','cash','currency'].includes(asset.kind)||asset.provider==='cash')){
  const pairs=macro.rates.slice(0,2).map(x=>x.year+': '+n(x.value)+'%');
  lines.push('<b>Макроконсенсус · российский рынок</b>\nСредняя ключевая ставка за год — '+pairs.join('; ')+'.'+(macro.inflation?.length?'\nИнфляция, декабрь к декабрю '+macro.inflation[0].year+': '+n(macro.inflation[0].value)+'%.':'')+((asset.provider==='cash'||asset.kind==='currency')&&macro.usd?.length?'\nСредний USD/RUB за '+macro.usd[0].year+': '+n(macro.usd[0].value)+' ₽.':'')+'\n'+link(macro.source,'Опрос Банка России · '+macro.as_of.slice(0,7))+(macro.count?' · '+macro.count+' экономиста':'')+'\nЭто медианы ответов участников опроса; среднегодовые значения отличаются от значений на конец года.');
 }
 if(!c&&!data.opinions?.length&&asset.kind==='stock')lines.push('Здесь появятся цель, горизонт, разброс и авторы после появления подтверждённых публикаций. Отсутствие оценки не означает рекомендацию держать или продавать.');
 lines.push('<i>Прогнозы могут не сбыться. Оценки источников не являются персональной рекомендацией Portfolius.</i>');
 return lines.join('\n\n');
}
export function outlookBody(user,assets,records,selection,access,page=0,now=new Date()){
 const full=fullAccess(access),freeKey=selection?.key,sorted=full?assets:[...assets].sort((a,b)=>(b.key===freeKey?1:0)-(a.key===freeKey?1:0)||a.key.localeCompare(b.key));
 const size=full?1:6,pages=Math.max(1,Math.ceil(sorted.length/size));
 if(!Number.isSafeInteger(page)||page<0||page>=pages)page=0;
 const shown=sorted.slice(page*size,(page+1)*size),lines=['<b>🔭 Portfolius · прогнозы и ориентиры</b>'];
 if(!assets.length)lines.push('Сначала добавьте портфель: пришлите скриншоты и подтвердите позиции.');
 else if(!full){lines.push('Бесплатно — крупнейший актив по стоимости позиции во всех счетах. Остальные — в подписке.');if(!freeKey)lines.push('Пока не хватает данных, чтобы сравнить стоимость всех позиций. Проверьте количество и валюты через /edit или загрузите свежий скриншот. Рыночные данные проверяются автоматически.');else if(selection.approximate)lines.push('<i>Выбор приблизительный: часть стоимости взята из последнего сохранённого скриншота.</i>');}
 for(const asset of shown){if(full||asset.key===freeKey)lines.push(outlookCard(asset,records[asset.key],now));else lines.push('🔒 <b>'+html(String(asset.name||asset.symbol||'Актив').slice(0,110))+'</b>\nПрогнозы и ориентиры по этому активу — в подписке.');}
 if(!full&&assets.length)lines.push('💎 Весь портфель — 290 ₽ в неделю. Доступность прогнозов зависит от покрытия источниками.');
 const keyboard=[];if(pages>1)keyboard.push([...(page>0?[{text:'← Назад',callback_data:'insight:outlook:'+(page-1)}]:[]),...(page+1<pages?[{text:'Далее →',callback_data:'insight:outlook:'+(page+1)}]:[])]);
 if(!full)keyboard.push([{text:'💎 Открыть весь портфель',callback_data:'billing:upgrade'}]);
 keyboard.push([{text:'📊 Мой обзор',callback_data:'insight:report'},{text:'Главный экран',callback_data:'ui:home'}]);
 return {chat_id:user,text:lines.join('\n\n'),parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:keyboard}};
}
