/** 缓冲准入回归：验证请求超限、Redis 故障及在途预算不足。 */
import { ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { IngestionBuffer } from '../src/ingestion/ingestion-buffer.service';
import { createTestApp, createTestConfig } from './support/test-app';
import type { BufferedMessage } from '../src/ingestion/ingestion.types';
import { randomUUID } from 'node:crypto';

/** 验证缓冲准入失败的 HTTP 与服务语义。 */
describe('ingestion admission failures',()=>{
  const message: BufferedMessage={id:randomUUID(),receivedAt:Date.now(),kind:'event',meta:{ip:'',userAgent:''},
    payload:{event_id:randomUUID(),app_id:'app',event_type:'behavior',timestamp:Date.now(),action:'click'}};
  /** 验证单请求超预算时直接返回 413，不调用 Redis。 */
  it('rejects oversized requests before contacting Redis',async()=>{
    const evalCommand=jest.fn();
    const config=createTestConfig({MONITOR_BUFFER_MAX_ITEMS:'1'});
    const buffer=new IngestionBuffer({eval:evalCommand} as unknown as Redis,config);
    await expect(buffer.enqueue([message,message])).rejects.toMatchObject({status:413});
    expect(evalCommand).not.toHaveBeenCalled();
  });
  /** 验证 Redis 故障返回隐藏内部信息的 503，且不回退 MySQL。 */
  it('returns a sanitized 503 for Redis failure without calling MySQL',async()=>{
    const buffer=new IngestionBuffer({eval:async()=>{throw new Error('internal connection details');}} as unknown as Redis,createTestConfig());
    const app=await createTestApp({configure:builder=>builder.overrideProvider(IngestionBuffer).useValue(buffer)});
    try {
      const response=await request(app.getHttpServer()).post('/api/v1/monitor').send(message.payload).expect(503);
      expect(response.body).toEqual({ok:false,error:'Redis ingestion buffer unavailable'});
      expect(response.text).not.toContain('connection details');
    } finally {await app.close();}
  });
  /** 验证状态接口需要令牌，未配置令牌时不开放。 */
  it('keeps management status protected and disables it without a token',async()=>{
    const app=await createTestApp();
    try {await request(app.getHttpServer()).get('/api/v1/dashboard/ingestion').expect(404);}
    finally {await app.close();}
  });
  /** 验证在途数据占满预算时拒绝新请求。 */
  it('does not accept a saturated in-flight buffer',async()=>{
    const buffer=new IngestionBuffer({eval:async()=>-2} as unknown as Redis,createTestConfig());
    await expect(buffer.enqueue([message])).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
