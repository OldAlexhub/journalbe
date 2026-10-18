function clientKey(req) {
  const raw = String(req.ip || req.socket.remoteAddress || 'unknown').toLowerCase();
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function fixedWindowRateLimit({windowMs,limit,message='Too many requests. Try again later.',json=false}) {
  const clients = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key,value] of clients) if (value.resetAt <= now) clients.delete(key);
  }, Math.max(30_000,windowMs)).unref();
  const middleware = (req,res,next) => {
    const now=Date.now();const key=clientKey(req);let value=clients.get(key);
    if(!value||value.resetAt<=now){value={count:0,resetAt:now+windowMs};clients.set(key,value);}
    value.count+=1;res.set('RateLimit-Limit',String(limit));res.set('RateLimit-Remaining',String(Math.max(0,limit-value.count)));res.set('RateLimit-Reset',String(Math.ceil(value.resetAt/1000)));
    if(value.count>limit){res.set('Retry-After',String(Math.ceil((value.resetAt-now)/1000)));return json?res.status(429).json({error:{code:'RATE_LIMITED',retryable:true}}):res.status(429).type('text/plain').send(message);}
    next();
  };
  middleware.close=()=>clearInterval(cleanup);
  return middleware;
}
