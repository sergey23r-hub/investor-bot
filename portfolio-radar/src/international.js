// Public Yahoo Finance responses are a best-effort reference feed, not broker execution prices.
export const normalizedName=s=>String(s||'').toLowerCase().replace(/\b(corporation|corp|incorporated|inc|limited|ltd)\b/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export async function chart(symbol,fetchJson){
 return (await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(symbol)+'?interval=1d&range=5d',{headers:{'User-Agent':'PortfolioRadar/0.2'}},25000)).chart?.result?.[0];
}
export async function internationalQuote(p,fetchJson){
 const symbol=p.provider==='yahoo'?p.provider_id:p.isin?.startsWith('US')?String(p.symbol||p.provider_id).replace(/-RM$/,''):p.provider==='finnhub'?p.provider_id:null;
 if(!symbol)return null;
 const d=await chart(symbol,fetchJson),m=d?.meta;
 if(!m||normalizedName(m.longName||m.shortName)!==normalizedName(p.name))return null;
 if(!Number.isFinite(m.regularMarketPrice)||m.regularMarketPrice<=0||!m.regularMarketTime||Date.now()-m.regularMarketTime*1000>4*86400000||m.regularMarketTime*1000>Date.now()+300000)return null;
 const closes=d.indicators?.quote?.[0]?.close?.filter(Number.isFinite)||[];
 const previous=m.previousClose??closes.at(-2);
 const change=Number.isFinite(m.regularMarketChangePercent)?m.regularMarketChangePercent:previous>0?(m.regularMarketPrice/previous-1)*100:null;
 return {status:'ok',price:m.regularMarketPrice,currency:m.currency,change_pct:change,as_of:new Date(m.regularMarketTime*1000).toISOString(),
   basis:'последняя доступная сессия · '+(m.fullExchangeName||m.exchangeName)+'; справочная цена, доступность продажи у брокера может отличаться',
   url:'https://finance.yahoo.com/quote/'+encodeURIComponent(symbol)+'/'};
}
export async function internationalResolve(raw,fetchJson){
 const q=raw.isin||raw.symbol||raw.name;
 const data=await fetchJson('https://query1.finance.yahoo.com/v1/finance/search?q='+encodeURIComponent(q)+'&quotesCount=10&newsCount=0',{headers:{'User-Agent':'PortfolioRadar/0.2'}},25000);
 const allowed=raw.kind==='fund'?['ETF','MUTUALFUND']:['EQUITY'];
 let matches=(data.quotes||[]).filter(c=>allowed.includes(c.quoteType)&&(c.symbol.toUpperCase()===String(q).toUpperCase()||(!raw.symbol&&!raw.isin&&normalizedName(c.longname||c.shortname)===normalizedName(raw.name))));
 const exact=matches.filter(c=>c.symbol.toUpperCase()===String(q).toUpperCase());
 if(exact.length)matches=exact;
 else matches=matches.filter(c=>['NMS','NYQ','NGM','NCM','PAR','AMS','LSE','GER','EBS'].includes(c.exchange)&&!/ADR|depositary/i.test(c.shortname||''));
 if(matches.length!==1)return null;
 const c=matches[0],d=await chart(c.symbol,fetchJson);
 if(!d?.meta||raw.currency&&d.meta.currency!==raw.currency)return null;
 return {...raw,name:d.meta.longName||c.longname||c.shortname,symbol:c.symbol,key:'yahoo:'+c.symbol,provider:'yahoo',provider_id:c.symbol,verified:true,issue:null,currency:d.meta.currency,isin:raw.isin||null};
}
