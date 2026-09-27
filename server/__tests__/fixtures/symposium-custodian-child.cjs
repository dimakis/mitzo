let epoch;
process.on('message', frame => {
  if (frame.kind === 'ready') {
    epoch = frame.epoch;
    process.send({kind:'request',command:{epoch,requestId:`request-${epoch}`,operation:'director.status',sessionId:'s',body:{},query:{},authorization:{id:`fresh-app-jti-${epoch}`,expiresAt:Date.now()+60000}}});
  } else if (frame.kind === 'response') process.send({fixtureResult:frame.result});
});
process.once('disconnect',()=>process.exit(1));
setInterval(()=>{if(epoch)process.send({kind:'heartbeat',epoch});},20);
process.send({kind:'hello'});
