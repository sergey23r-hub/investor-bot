import {handleGateway} from '../src/portfolio-gateway.mjs';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
 try{return res.status(200).json(await handleGateway(typeof req.body==='string'?JSON.parse(req.body):req.body));}
 catch(e){const unauthorized=e.message==='unauthorized';return res.status(unauthorized?401:502).json({error:unauthorized?'unauthorized':'bank_request_failed'});}
}
