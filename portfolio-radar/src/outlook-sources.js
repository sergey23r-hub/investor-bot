import {DAY,plain} from './outlook-data.js';
import {normalizedName} from './international.js';

const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fail=reason=>{throw new Error('source_'+reason);};
export function sourceFresh(stamp,now,maxAge){
 const age=+now-Date.parse(stamp);return Number.isFinite(age)&&age>=-300000&&age<=maxAge;
}
const positive=s=>{const n=Number(String(s).replaceAll(',',''));return Number.isFinite(n)&&n>0?n:null;};
const englishDate=s=>{const ms=Date.parse(s+' 00:00:00 GMT');return Number.isFinite(ms)?new Date(ms).toISOString():null;};

// Only verified US equities are routed by ticker. The page must independently
// confirm the exchange ticker AND the full issuer name before any target is used.
export function stockForecastUrl(asset){
 if(!asset.verified||asset.kind!=='stock'||!/^US[A-Z0-9]{10}$/.test(asset.isin||''))return null;
 const ticker=String(asset.symbol||asset.provider_id||'').replace(/-RM$/,'');
 return /^[A-Z]{1,6}(?:[.-][A-Z])?$/.test(ticker)?'https://stockanalysis.com/stocks/'+ticker.toLowerCase()+'/forecast/':null;
}
export function parseStockForecast(html,asset,now=new Date()){
 const url=stockForecastUrl(asset);if(!url)return null;
 const t=plain(html),ticker=String(asset.symbol||asset.provider_id).replace(/-RM$/,''),identity=t.match(new RegExp('([^()]{1,130})\\s*\\('+escape(ticker)+'\\)\\s*(NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN):\\s*'+escape(ticker)+'\\b'));
 // Require the full issuer name immediately beside the exchange identity.
 const issuerPattern=new RegExp(escape(normalizedName(asset.name))+' '+escape(ticker.toLowerCase())+' (nasdaq|nyse|nysearca|nyseamerican) '+escape(ticker.toLowerCase())+'\\b');
 const named=normalizedName(asset.name).length>=3&&issuerPattern.test(normalizedName(t));
 if(!identity||!named||!new RegExp('(?:NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN):\\s*'+escape(ticker)+'\\s*·[^·]*·\\s*USD').test(t))fail('identity');
 const summary=t.match(/According to (\d+) analysts polled by S&P Global,[\s\S]{0,250}?average price target of \$([\d,.]+)\./);
 if(!summary||!t.includes('average 1-year stock price forecast'))fail('format');
 const table=[...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map(m=>plain(m[0])).find(s=>/^Target Low Average Median High Price /.test(s));
 const cells=table?.match(/^Target Low Average Median High Price \$([\d,.]+) \$([\d,.]+) \$([\d,.]+) \$([\d,.]+)/);
 if(!cells)fail('format');
 const [low,mean,median,high]=cells.slice(1).map(positive),count=Number(summary[1]);
 if(![low,mean,median,high].every(Boolean)||low>median||median>high||low>mean||mean>high||Math.abs(mean-positive(summary[2]))>0.011||count<3||count>300)fail('format');
 const as_of=englishDate(t.match(/Last updated:\s*([A-Z][a-z]{2} \d{1,2}, 20\d{2})/)?.[1]||'');
 if(!sourceFresh(as_of,now,7*DAY))fail('stale');
 return {kind:'source_consensus',provider:'Stock Analysis / S&P Global',url,as_of,latest:as_of,oldest:null,median,mean,low,high,count,count_kind:'analysts',currency:'USD',horizon:'12m',sources:[{url,house:'Stock Analysis · S&P Global',published_at:as_of}]};
}

// CoinGecko IDs, CoinCodex slugs and ticker/name checks are explicit: a ticker
// collision or a wrapped token must never inherit another asset's prediction.
export const CRYPTO_MODELS={
 bitcoin:['bitcoin','BTC','Bitcoin'],ethereum:['ethereum','ETH','Ethereum'],solana:['solana','SOL','Solana'],
 'aster-2':['aster','ASTER','Aster'],
 'fetch-ai':['fetch-ai','FET','Artificial Superintelligence Alliance'],
 layerzero:['layerzero','ZRO','LayerZero'],
 'mina-protocol':['mina-protocol','MINA','Mina Protocol'],
 'ondo-finance':['ondo-finance','ONDO','Ondo Finance'],
 'pudgy-penguins':['pudgy-penguins','PENGU','Pudgy Penguins'],
 'pyth-network':['pyth-network','PYTH','Pyth Network']
};
export function cryptoForecastUrl(asset){
 const mapping=asset.verified&&asset.kind==='crypto'&&asset.provider==='coingecko'&&CRYPTO_MODELS[asset.provider_id];
 return mapping?'https://coincodex.com/crypto/'+mapping[0]+'/price-prediction/':null;
}
export function parseCryptoForecast(html,asset,now=new Date()){
 const url=cryptoForecastUrl(asset);if(!url)return null;
 const [,ticker,name]=CRYPTO_MODELS[asset.provider_id],h=plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]),t=plain(html);
 if(!h.startsWith(name+' ('+ticker+') Price Prediction')||String(asset.symbol).toUpperCase()!==ticker)fail('identity');
 const stamp=t.match(/Last update:\s*([A-Z][a-z]{2} \d{1,2}, 20\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(GMT\+0\)/);
 const date=stamp&&englishDate(stamp[1]);
 const hour=stamp?Number(stamp[2])%12+(stamp[4]==='PM'?12:0):NaN;
 const as_of=date&&stamp[2]>=1&&stamp[2]<=12&&stamp[3]<60?new Date(Date.parse(date)+hour*3600000+Number(stamp[3])*60000).toISOString():null;
 if(!sourceFresh(as_of,now,2*DAY))fail('stale');
 // Read only the visible free prediction cards; never read hidden premium data
 // or infer a target from a return percentage or from a technical support level.
 const targets=['5-Day','1-Month','3-Month'].flatMap(horizon=>{
  const m=t.match(new RegExp(escape(horizon)+' Prediction\\s*\\$\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)(?=\\s|$)'));
  const target=m&&positive(m[1]);return target?[{horizon,target}]:[];
 });
 if(!targets.length)fail('format');
 return {kind:'algorithmic',provider:'CoinCodex',url,currency:'USD',as_of,targets};
}

export function newestQuote(a,b,now=new Date()){
 const valid=q=>q?.status==='ok'&&Number.isFinite(Number(q.price))&&Number(q.price)>0&&sourceFresh(q.as_of,now,7*DAY);
 if(!valid(a))return valid(b)?b:null;if(!valid(b))return a;
 return Date.parse(b.as_of)>Date.parse(a.as_of)?b:a;
}

