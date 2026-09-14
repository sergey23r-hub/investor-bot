// Observed API usage, not an invoice. Prices verified 2026-09-13.
export const RATES={input:0.75,cached:0.075,output:4.5,web_search:0.01};
export function usageRecord(response,scope,assetKey=null){
 if(!response?.id||!response.usage)return null;
 const u=response.usage,input=Number(u.input_tokens||0),cached=Number(u.input_tokens_details?.cached_tokens||0),output=Number(u.output_tokens||0);
 const calls=(response.output||[]).filter(x=>x.type==='web_search_call').length;
 return {response_id:response.id,scope,asset_key:assetKey,model:response.model||'unknown',status:response.status||'completed',input_tokens:input,cached_tokens:cached,output_tokens:output,search_calls:calls,
  estimated_usd:((input-cached)*RATES.input+cached*RATES.cached+output*RATES.output)/1e6+calls*RATES.web_search};
}
