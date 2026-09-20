import {newsIdentity} from './daily.js';

export const DAY=86400000;
export const FINAM_LICENSE='https://creativecommons.org/licenses/by/4.0/';
export const FINAM_FEEDS=['https://www.finam.ru/analysis/nslent/rsspoint/','https://www.finam.ru/analysis/conews/rsspoint/','https://www.finam.ru/international/advanced/rsspoint/'];
export const CBR_SURVEY='https://www.cbr.ru/statistics/ddkp/mo_br/';
const num=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x))?Number(x):null;
const cleanUrl=s=>{try{const u=new URL(s);if(u.protocol!=='https:')return null;u.search='';u.hash='';return u.href;}catch{return null;}};
export const plain=s=>String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return c>0&&c<=0x10ffff?String.fromCodePoint(c):' ';}).replace(/&(nbsp|amp|quot|apos|lt|gt|ndash|mdash);/g,(_,n)=>({nbsp:' ',amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',ndash:'–',mdash:'—'}[n])).replace(/\s+/g,' ').trim();
const tag=(s,name)=>s.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+name+'>','i'))?.[1]||'';
export function parseFeed(xml,now=new Date()){
 if(!/<rss\b/i.test(xml))throw new Error('feed_format');
 return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].flatMap(m=>{
  const x=m[1],url=cleanUrl(plain(tag(x,'link'))),published=Date.parse(plain(tag(x,'pubDate')));
  if(!url||new URL(url).hostname!=='www.finam.ru'||!url.includes('/publications/item/')||!Number.isFinite(published)||+now-published>90*DAY||published>+now+3600000)return [];
  return [{title:plain(tag(x,'title')).slice(0,300),description:plain(tag(x,'content:encoded')||tag(x,'description')).slice(0,16000),author:plain(tag(x,'a10:name')||tag(x,'dc:creator')||tag(x,'author')).slice(0,100),url,published_at:new Date(published).toISOString(),license:FINAM_LICENSE}];
 }).slice(0,120);
}
const aliases={SBER:['Сбербанк'],GAZP:['Газпром'],LKOH:['Лукойл'],YDEX:['Яндекс'],MOEX:['Московская биржа','Мосбиржа'],GMKN:['Норникель'],ROSN:['Роснефть'],NVTK:['Новатэк'],MTSS:['МТС'],SMLT:['Самолет','Самолёт'],MDMG:['Мать и дитя','МД Медикал'],MSFT:['Microsoft','Майкрософт'],TSLA:['Tesla','Тесла'],COIN:['Coinbase'],AAPL:['Apple'],NVDA:['Nvidia'],AMZN:['Amazon'],GOOGL:['Alphabet','Google']};
const cryptoAliases={bitcoin:['Bitcoin','Биткоин','Биткойн'],ethereum:['Ethereum','Эфириум'],solana:['Solana','Солана']};
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function assetMention(asset,text){
 const symbol=String(asset.symbol||'').replace(/-RM$/,'');
 const names=[symbol.length>=3?symbol:null,asset.name?.length>=5?asset.name:null,...(aliases[symbol]||[]),...(cryptoAliases[asset.provider_id]||[])].filter(Boolean);
 return names.some(name=>new RegExp('(^|[^\\p{L}\\p{N}])'+escape(name)+'(?=$|[^\\p{L}\\p{N}])','iu').test(text));
}
export function articleText(html){
 for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{const data=JSON.parse(m[1]);const objects=[...(Array.isArray(data)?data:[data]),...(data['@graph']||[])];const a=objects.find(x=>typeof x.articleBody==='string');if(a)return {text:plain(a.articleBody).slice(0,35000),author:plain(a.author?.name||a.author?.[0]?.name||''),published_at:a.datePublished};}catch{}
 }
 const m=html.match(/<([a-z]+)[^>]*itemprop=["']articleBody["'][^>]*>([\s\S]*?)<\/\1>/i);
 return {text:m?plain(m[2]).slice(0,35000):'',author:''};
}
const houses=[['Финам',/финам|finam/iu],['БКС',/\bBCS\b|БКС/iu],['Альфа-Банк',/альфа[ -]?(?:банк|инвестици)/iu],['СберCIB',/SberCIB|Сбер\s*CIB|Сбербанк\s*КИБ/iu],['Т-Инвестиции',/Т[ -]Инвестици|Тинькофф/iu],['ВТБ',/ВТБ/iu],['Атон',/\bATON\b|Атон/iu],['Синара',/Синара/iu],['Велес Капитал',/Велес|Veles/iu],['Газпромбанк',/Газпромбанк/iu],['Ренессанс Капитал',/Ренессанс/iu],['Эйлер',/Эйлер/iu],['Morgan Stanley',/Morgan Stanley/iu],['Goldman Sachs',/Goldman Sachs/iu],['JPMorgan',/J\.?P\.?\s*Morgan/iu],['UBS',/\bUBS\b/u],['Citi',/\bCiti(?:group)?\b/iu],['Bank of America',/Bank of America|BofA/iu],['Bernstein',/Bernstein/iu],['Standard Chartered',/Standard Chartered/iu]];
export function parseOpinion(asset,item,article,now=new Date()){
 if(!asset.verified||!['stock','crypto','fund'].includes(asset.kind)||!assetMention(asset,item.title))return null;
 const published=Date.parse(article.published_at||item.published_at);if(!Number.isFinite(published)||+now-published>90*DAY||published>+now+3600000)return null;
 const text=plain(item.title+'. '+article.text);
 // Restrict to an explicit price-target sentence. Never infer a target from returns,
 // current quotes, revenue guidance, a round number, or a technical support level.
 const sentences=text.split(/(?<=[.!?])\s+(?=[А-ЯA-Z«])/u);
 const targetSentences=[...new Set(sentences.filter(s=>/целев(?:ая|ую|ой)\s+(?:цен|стоимост)|таргет|price target/iu.test(s)))];
 if(targetSentences.length!==1)return null;
 const s=targetSentences[0];
 if(!assetMention(asset,s))return null;
 const matches=[...s.matchAll(/(?:до|на уровне|составля(?:ет|ют)|в размере|равн[ао]|to|of|at|[—–:=])\s*(\$)?\s*(\d[\d\s\u00a0]*(?:[.,]\d+)?)\s*(тыс\.?|thousand)?\s*(руб(?:л[ьяей]+)?\.?|₽|доллар\w*|USD|RUB|\$|EUR|€)?/giu)].filter(m=>m[1]||m[4]);
 if(matches.length!==1)return null;
 const m=matches[0],target=Number(m[2].replace(/\s/g,'').replace(',','.'))*(m[3]?1000:1);
 if(!(target>0&&target<1e8))return null;
 const currency=m[1]||/доллар|USD|\$/i.test(m[4]||'')?'USD':/EUR|€/.test(m[4]||'')?'EUR':'RUB';
 const found=houses.filter(([,re])=>re.test(s));
 // An editorial byline does not establish whose target is being quoted.
 const house=found.length===1?found[0][0]:null;
 if(!house)return null;
 const horizon=/12[ -]?(?:месяц|месяч|month)|на\s+(?:ближайш(?:ий|ие)\s+)?год|горизонт\w*\s+(?:одного\s+)?года/iu.test(s)?'12m':s.match(/(?:к концу|на конец|end of)\s*(20\d{2})/iu)?.[1]||null;
 const rating=/продавать|\bsell\b/iu.test(s)?'sell':/держать|\bhold\b/iu.test(s)?'hold':/покупать|\bbuy\b/iu.test(s)?'buy':null;
 return {asset_key:newsIdentity(asset),house,target,currency,horizon,rating,published_at:new Date(published).toISOString(),url:item.url,author:article.author||item.author||house,license:FINAM_LICENSE};
}
export function consensus(opinions,now=new Date()){
 const newest=new Map();
 for(const o of [...opinions].sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at))){
  if(!o.house||!o.horizon||!Number.isFinite(o.target)||!(o.target>0)||!Number.isFinite(Date.parse(o.published_at))||+now-Date.parse(o.published_at)>90*DAY||Date.parse(o.published_at)>+now||!o.url)continue;
  if(/^20\d{2}$/.test(o.horizon)&&o.horizon<String(now.getUTCFullYear()))continue;
  const id=o.house+'|'+o.currency+'|'+o.horizon;if(!newest.has(id))newest.set(id,o);
 }
 const groups=new Map();for(const o of newest.values()){const k=o.currency+'|'+o.horizon;groups.set(k,[...(groups.get(k)||[]),o]);}
 const selected=[...groups.values()].filter(g=>g.length>=3).sort((a,b)=>b.length-a.length||String(a[0].horizon).localeCompare(String(b[0].horizon)))[0];
 if(!selected)return null;
 const values=selected.map(o=>o.target).sort((a,b)=>a-b),n=values.length;
 return {median:n%2?values[(n-1)/2]:(values[n/2-1]+values[n/2])/2,mean:values.reduce((a,b)=>a+b,0)/n,low:values[0],high:values.at(-1),count:n,currency:selected[0].currency,horizon:selected[0].horizon,oldest: selected.map(o=>o.published_at).sort()[0],latest:selected.map(o=>o.published_at).sort().at(-1),sources:selected};
}
export function parseSurvey(html,now=new Date()){
 const title=plain(html).match(/Результаты опроса:\s*([а-яё]+)\s+(20\d{2})/iu);
 const months=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
 const month=months.indexOf(title?.[1]?.toLowerCase());if(month<0)throw new Error('survey_date_missing');
 const as_of=title[2]+'-'+String(month+1).padStart(2,'0')+'-01';if(+now-Date.parse(as_of)>125*DAY||Date.parse(as_of)>+now)throw new Error('survey_stale');
 const table=html.match(/<table\b[\s\S]*?<\/table>/i)?.[0]||'';
 const tr=[...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>[...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>plain(c[1])));
 const header=tr.find(r=>r.filter(c=>/^20\d{2}/.test(c)).length>=3);if(!header)throw new Error('survey_years_missing');
 const years=header.filter(c=>/^20\d{2}/.test(c)).map(c=>Number(c.slice(0,4)));
 const field=re=>{const row=tr.find(r=>re.test(r[0]||''));if(!row||row.length-1!==years.length)return [];return years.map((year,i)=>({year,value:num(row[i+1].match(/^-?[\d,]+/)?.[0]?.replace(',','.'))})).filter(x=>x.year>=now.getUTCFullYear()&&x.value!==null);};
 const rates=field(/^Ключевая ставка/),inflation=field(/^ИПЦ.*дек\./),usd=field(/^Курс USD\/RUB/);
 if(!rates.length)throw new Error('survey_values_missing');
 const count=plain(html).match(/медианой прогнозов\s+(\d+)\s+экономистов/iu)?.[1];
 return {as_of,count:count?Number(count):null,rates,inflation,usd,source:CBR_SURVEY};
}
export function parseBond(data,asset,now=new Date()){
 const rows=b=>b?.columns&&Array.isArray(b.data)?b.data.map(r=>Object.fromEntries(b.columns.map((c,i)=>[c.toLowerCase(),r[i]]))):[];
 const securities=rows(data.securities).filter(s=>s.secid===asset.provider_id&&(!asset.isin||s.isin===asset.isin));
 const yields=rows(data.marketdata_yields).filter(y=>securities.some(s=>s.boardid===y.boardid)&&y.secid===asset.provider_id);
 const y=yields.sort((a,b)=>String(b.systime).localeCompare(String(a.systime)))[0],s=securities.find(s=>s.boardid===y?.boardid)||securities[0];if(!s)return null;
 const stamp=y?.trademoment||y?.systime;const as_of=stamp?String(stamp).replace(' ','T')+'+03:00':null;
 const fresh=as_of&&+now-Date.parse(as_of)<=7*DAY&&Date.parse(as_of)<=+now;
 return {maturity:/^20\d{2}-\d{2}-\d{2}$/.test(s.matdate||'')?s.matdate:null,coupon_pct:num(s.couponpercent),coupon_period_days:num(s.couponperiod),type:s.bondtype||null,subtype:s.bondsubtype||null,yield:fresh?num(y.effectiveyield):null,yield_date:fresh?y.yielddate:null,yield_type:fresh?y.yielddatetype:null,as_of:fresh?as_of:null,source:'https://iss.moex.com/iss/engines/stock/markets/bonds/securities/'+encodeURIComponent(asset.provider_id)+'.json'};
}
// Explicit mappings avoid assigning a same-ticker derivative to another token.
export const PERPETUALS={bitcoin:'BTCUSDT',ethereum:'ETHUSDT',solana:'SOLUSDT',ripple:'XRPUSDT',binancecoin:'BNBUSDT',dogecoin:'DOGEUSDT',cardano:'ADAUSDT',avalanche:'AVAXUSDT','avalanche-2':'AVAXUSDT',chainlink:'LINKUSDT','fetch-ai':'FETUSDT','ondo-finance':'ONDOUSDT','pyth-network':'PYTHUSDT','mina-protocol':'MINAUSDT','aster-2':'ASTERUSDT','pudgy-penguins':'PENGUUSDT',layerzero:'ZROUSDT',polkadot:'DOTUSDT',uniswap:'UNIUSDT',aave:'AAVEUSDT',sui:'SUIUSDT','the-open-network':'TONUSDT'};
export function parseFunding(data,asset,now=new Date()){
 const symbol=PERPETUALS[asset.provider_id];if(!symbol||data.symbol!==symbol||+now-data.time>DAY||data.time>+now+60000)return null;
 const rate=num(data.lastFundingRate),mark=num(data.markPrice),index=num(data.indexPrice);if(rate===null||!(mark>0&&index>0))return null;
 return {symbol,rate_pct:rate*100,basis_pct:(mark/index-1)*100,as_of:new Date(data.time).toISOString(),next_funding:Number.isFinite(data.nextFundingTime)?new Date(data.nextFundingTime).toISOString():null,source:'https://www.binance.com/en/futures/'+symbol};
}
