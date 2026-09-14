import {safeUrl,decimal} from './core.js';

export const rows=block=>block?.columns&&Array.isArray(block.data)?block.data.map(row=>Object.fromEntries(block.columns.map((c,i)=>[c.toLowerCase(),row[i]]))):[];
export const currency=c=>({SUR:'RUB',RUR:'RUB',USD:'USD',RUB:'RUB'}[c]||(/^[A-Z]{3}$/.test(c||'')?c:null));
const isoDay=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d))?d:null;
const numberString=x=>{try{return decimal(x);}catch{return null;}};
export function parseCbr(xml){
 const source='https://www.cbr.ru/scripts/XML_daily.asp';
 const date=xml.match(/<ValCurs[^>]+Date="(\d{2})\.(\d{2})\.(\d{4})"/);
 if(!date)throw new Error('fx_format');
 const rates={RUB:1};
 for(const match of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)){
  const code=match[1].match(/<CharCode>([A-Z]{3})<\/CharCode>/)?.[1];
  const value=Number(match[1].match(/<Value>([\d,.]+)<\/Value>/)?.[1]?.replace(',','.'));
  const nominal=Number(match[1].match(/<Nominal>(\d+)<\/Nominal>/)?.[1]);
  if(code&&value>0&&nominal>0)rates[code]=value/nominal;
 }
 if(!rates.USD)throw new Error('fx_incomplete');
 return {status:'ok',rates,as_of:`${date[3]}-${date[2]}-${date[1]}`,source};
}
export function bondEvents(data,asset,from,to){
 const source=`https://www.moex.com/ru/issue.aspx?code=${encodeURIComponent(asset.provider_id)}`;
 const events=[];
 for(const [block,dateField,type,title] of [['coupons','coupondate','coupon','Выплата купона'],['amortizations','amortdate','principal','Погашение / амортизация'],['offers','offerdate','offer','Оферта']]){
  for(const r of rows(data[block])){
   const date=isoDay(r[dateField]);
   if(!date||date<from||date>to)continue;
   if(r.secid&&r.secid!==asset.provider_id&&(!asset.isin||r.isin!==asset.isin))continue;
   events.push({date,type,title,url:source,source:'Московская биржа',amount_per_unit:type==='offer'?null:numberString(r.value),currency:currency(r.faceunit),date_basis:'scheduled',record_date:isoDay(r.recorddate),confirmed:true});
  }
 }
 return events;
}
export function dividendEvents(data,asset,from,to){
 // Missing expected block is an unavailable feed, never "no dividends".
 if(!data.dividends)throw new Error('dividend_feed_unavailable');
 return rows(data.dividends).flatMap(r=>{
  if(r.secid&&r.secid!==asset.provider_id)return [];
  const pay=isoDay(r.paymentdate||r.payment_date),record=isoDay(r.registryclosedate||r.recorddate),date=pay||record;
  if(!date||date<from||date>to)return [];
  return [{date,type:'dividend',title:pay?'Выплата дивидендов':'Закрытие реестра по дивидендам',date_basis:pay?'scheduled':'record',record_date:record,amount_per_unit:numberString(r.value||r.dividend),currency:currency(r.currencyid||r.currency),confirmed:true,url:`https://www.moex.com/ru/issue.aspx?code=${encodeURIComponent(asset.provider_id)}`,source:'Московская биржа'}];
 });
}

export async function scheduledFacts(asset,config,fetcher,now=new Date()){
 const from=now.toISOString().slice(0,10),to=new Date(+now+31*86400000).toISOString().slice(0,10);
 const result={checked_at:now.toISOString(),status:'unavailable',events:[],issuer_id:null,issuer_name:null,sector:null};
 if(asset.key==='market'){
  try{
   const r=await fetch('https://www.cbr.ru/scripts/XML_daily.asp',{signal:AbortSignal.timeout(8000)});
   if(!r.ok)throw new Error('fx_unavailable');return {...result,status:'ok',fx:parseCbr(await r.text())};
  }catch{return result;}
 }
 if(asset.provider==='moex'){
  const id=encodeURIComponent(asset.provider_id);
  const requests=[fetcher(`https://iss.moex.com/iss/securities/${id}.json?iss.meta=off&iss.only=description`,{},8000)];
  if(asset.kind==='bond')requests.push(fetcher(`https://iss.moex.com/iss/statistics/engines/stock/markets/bonds/bondization/${id}.json?iss.meta=off&from=${from}&to=${to}`,{},8000));
  else if(asset.kind==='stock')requests.push(fetcher(`https://iss.moex.com/iss/securities/${id}/dividends.json?iss.meta=off`,{},8000));
  const results=await Promise.allSettled(requests);
  if(results[0].status==='fulfilled'){
   const d=Object.fromEntries(rows(results[0].value.description).map(r=>[r.name,r.value]));
   if(d.EMITTER_ID||d.EMITENT_ID)result.issuer_id='moex:'+(d.EMITTER_ID||d.EMITENT_ID);
   result.issuer_name=d.EMITTER_NAME||d.EMITENT_NAME||null;
   result.sector=d.SECTORNAME||d.INDUSTRYNAME||null;
   result.face_value=numberString(d.FACEVALUE);result.face_currency=currency(d.FACEUNIT);
   result.metadata_source=`https://iss.moex.com/iss/securities/${id}.json`;
  }
  if(results[1]?.status==='fulfilled')try{
   const d=results[1].value;
   if(asset.kind==='bond'){
    if(!d.coupons||!d.amortizations)throw new Error('bond_feed_unavailable');
    result.events=bondEvents(d,asset,from,to);result.status='ok';
    const truncated=[['coupons','coupondate'],['amortizations','amortdate'],['offers','offerdate']].some(([k,field])=>{const c=rows(d[k+'.cursor'])[0],values=rows(d[k]);return c&&c.total>values.length&&(!values.length||values.at(-1)[field]<to);});
    if(truncated)result.status='partial';
   }else{result.events=dividendEvents(d,asset,from,to);result.status='ok';}
  }catch{result.status='unavailable';}
 }
 if(['finnhub','yahoo'].includes(asset.provider)&&config.finnhub_key){
  const id=encodeURIComponent(asset.provider_id||asset.symbol),key=encodeURIComponent(config.finnhub_key);
  const results=await Promise.allSettled([
   fetcher(`https://finnhub.io/api/v1/stock/profile2?symbol=${id}&token=${key}`,{},8000),
   fetcher(`https://finnhub.io/api/v1/stock/dividend?symbol=${id}&from=${from}&to=${to}&token=${key}`,{},8000)
  ]);
  const profile=results[0].status==='fulfilled'?results[0].value:null;
  if(profile?.ticker?.toUpperCase()===String(asset.provider_id||asset.symbol).toUpperCase()){
   result.issuer_name=profile.name;result.issuer_id=asset.cik?'sec:'+asset.cik:null;result.sector=profile.finnhubIndustry||null;result.metadata_source='https://finnhub.io';
   if(results[1].status==='fulfilled'&&Array.isArray(results[1].value)){
    result.status='ok';result.events=results[1].value.flatMap(d=>{
     const date=isoDay(d.payDate)||isoDay(d.recordDate)||isoDay(d.date);if(!date||date<from||date>to)return [];
     return [{date,type:'dividend',title:d.payDate?'Выплата дивидендов':'Дивидендная дата',date_basis:d.payDate?'scheduled':'record',record_date:isoDay(d.recordDate),amount_per_unit:numberString(d.amount),currency:currency(d.currency),confirmed:true,url:safeUrl(profile.weburl)||'https://finnhub.io',source:'Finnhub'}];
    });
   }
  }
 }
 return result;
}
