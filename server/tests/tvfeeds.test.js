import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFeedManager} from '../tvfeeds.js';

test('feed selections persist per instrument and restore native ticks on restart', async()=>{
  let saved=null;const invalidated=[];
  const catalog={XAUUSD:{tv:'OANDA:XAUUSD'},EURUSD:{tv:'OANDA:EURUSD'}};
  const deps={catalog,describe:async tv=>({tv,tvPine:{mintick:tv.startsWith('OANDA:')?0.001:0.01}}),load:async()=>saved,save:async v=>{saved=structuredClone(v);},invalidate:s=>invalidated.push(s)};
  const manager=createFeedManager(deps);await manager.init();
  await manager.set('XAUUSD','PEPPERSTONE:XAUUSD');
  assert.equal(catalog.XAUUSD.tv,'PEPPERSTONE:XAUUSD');
  assert.equal(catalog.EURUSD.tv,'OANDA:EURUSD');
  assert.deepEqual(invalidated,['XAUUSD']);
  const fresh={XAUUSD:{tv:'OANDA:XAUUSD'}};
  await createFeedManager({...deps,catalog:fresh}).init();
  assert.deepEqual(fresh.XAUUSD,saved.XAUUSD);
});

test('unavailable feeds and failed saves leave the current feed intact',async()=>{
  const catalog={XAUUSD:{tv:'OANDA:XAUUSD'}};let count=0;
  const manager=createFeedManager({catalog,load:async()=>null,save:async()=>{throw Error('Disk full');},invalidate:()=>count++,describe:async tv=>{if(tv==='BAD:XAUUSD')throw Error('No candles');return {tv};}});
  await manager.init();
  await assert.rejects(manager.set('XAUUSD','BAD:XAUUSD'),/No candles/);
  await assert.rejects(manager.set('XAUUSD','NYSE:GOLD'),/different instrument/);
  await assert.rejects(manager.set('XAUUSD','PEPPERSTONE:XAUUSD'),/Disk full/);
  await assert.rejects(manager.set('UNKNOWN','OANDA:XAUUSD'),/symbol/);
  assert.equal(catalog.XAUUSD.tv,'OANDA:XAUUSD');assert.equal(count,0);
});
