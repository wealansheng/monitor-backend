/** 真实 Redis 与 MySQL 集成：使用随机临时库和独立键前缀验证异步采集。 */
import { randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { getQueueToken } from '@nestjs/bull';
import type { Queue } from 'bull';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { monitorConfiguration } from '../src/config/configuration';
import { dataSourceOptions, initializeDatabase } from '../src/database/data-source';
import { MonitorRepository } from '../src/database/monitor.repository';
import { IngestionBuffer } from '../src/ingestion/ingestion-buffer.service';
import { BatchWriter } from '../src/ingestion/batch-writer.service';
import { IngestionProcessor } from '../src/ingestion/ingestion.processor';
import { INGEST_QUEUE } from '../src/ingestion/ingestion.types';
import type { BufferedMessage } from '../src/ingestion/ingestion.types';
import { retentionCutoff, DAY_MS, utcDay } from '../src/database/retention';
import { PartitionMaintenance } from '../src/database/partition-maintenance';
import { digest } from '../src/records/record.protocol';
import type { RecordChunk } from '../src/records/record.protocol';
import { RecordsRepository } from '../src/records/records.repository';
import { InitialStorage1793836800000 } from '../src/database/migrations/1793836800000-initial-storage';
import { createTestApp } from './support/test-app';

/** 验证真实 Redis 5 与 MySQL 的异步采集链路。 */
describe('real Redis 5 + MySQL ingestion', () => {
  const id=randomUUID().replaceAll('-','');
  const database='buffer_test_'+id;
  const prefix='monitor:test:'+id;
  const runtimePrefix=prefix+'runtime';
  const sentinel='monitor_unrelated_test_'+id;
  const config=monitorConfiguration({...process.env,MYSQL_DATABASE:database,REDIS_DB:'5',REDIS_KEY_PREFIX:prefix});
  let source: DataSource;
  let redis: Redis;
  let buffer: IngestionBuffer;
  let writer: BatchWriter;
  let repository: MonitorRepository;
  let app: NestExpressApplication | undefined;
  const message=(appId='buffer-app',extra: Record<string,unknown>={}): BufferedMessage=>({
    id:randomUUID(),receivedAt:Date.now(),kind:'event',meta:{ip:'127.0.0.1',userAgent:'integration'},
    payload:{app_id:appId,event_id:randomUUID(),event_type:'behavior',timestamp:Date.now()-100,
      action:'click',...extra},
  });
  /** 基于当前测试连接覆盖缓冲参数，用小预算验证容量和批次边界。 */
  function custom(overrides: Partial<typeof config.ingestion>): IngestionBuffer {
    return new IngestionBuffer(redis,{...config,ingestion:{...config.ingestion,...overrides}});
  }
  /** 仅扫描并删除本用例随机前缀下的键，保留共享 Redis 的其他数据。 */
  async function clearPrefix(value: string): Promise<void> {
    if (!/^monitor:test:[a-f0-9]{32}(runtime)?$/.test(value)) throw new Error('Unsafe test prefix');
    let cursor='0';
    do {
      const [next,keys]=await redis.scan(cursor,'MATCH',value+':*','COUNT',200);
      if(keys.length) await redis.del(...keys);
      cursor=next;
    } while(cursor!=='0');
  }
  /** 通过工作台分页总数统计指定应用的有效事件，不直接读取无界表。 */
  async function count(appId:string): Promise<number> {
    const page=await repository.findDashboardEvents({appId,from:retentionCutoff(14),to:Date.now(),keyword:'',limit:1,offset:0});
    return page.total;
  }
  /** 在限定超时内轮询异步条件，超时则使测试明确失败。 */
  async function eventually(check:()=>Promise<boolean>): Promise<void> {
    const end=Date.now()+10000;
    while(Date.now()<end) { if(await check()) return; await delay(50); }
    throw new Error('Timed out waiting for asynchronous ingestion');
  }
  /** 建立本组用例的连接、样本与独立测试资源。 */
  beforeAll(async()=>{
    await initializeDatabase(config.mysql);
    source=new DataSource(dataSourceOptions({...config.mysql,username:config.mysql.adminUsername,password:config.mysql.adminPassword}));
    await source.initialize();
    redis=new Redis({host:config.redis.host,port:config.redis.port,password:config.redis.password,db:5,
      connectTimeout:3000,maxRetriesPerRequest:1});
    await redis.ping();
    await redis.set(sentinel,'session-sentinel');
    buffer=new IngestionBuffer(redis,config);
    writer=new BatchWriter(source,config);
    repository=new MonitorRepository(source,config.mysql);
  },60000);
  /** 重置本用例状态，避免前一个用例的数据干扰。 */
  beforeEach(async()=>{await clearPrefix(prefix);});
  /** 检查并清理本用例状态，恢复模拟对象或隔离资源。 */
  afterEach(async()=>{expect(await redis.get(sentinel)).toBe('session-sentinel');});
  /** 释放连接及本组创建的临时资源，保留共享服务中的其他数据。 */
  afterAll(async()=>{
    await app?.close();
    if(redis) {
      await clearPrefix(prefix); await clearPrefix(runtimePrefix); await redis.del(sentinel); await redis.quit();
    }
    if(source?.isInitialized) {
      if(!/^buffer_test_[a-f0-9]{32}$/.test(database)) throw new Error('Unsafe scratch database');
      await source.query('DROP DATABASE '+source.driver.escape(database));
      await source.destroy();
    }
  });

  /** 验证只淘汰最旧待处理项，并同时执行条数与 UTF-8 字节预算。 */
  it('evicts only the oldest waiting entries and enforces count and byte budgets',async()=>{
    const small=custom({maxItems:3,maxBytes:8192});
    const messages=Array.from({length:4},()=>message());
    await small.enqueue(messages.slice(0,3));
    await small.enqueue(messages.slice(3));
    expect(await small.status()).toMatchObject({depth:3,inflight:0,enqueued:4,droppedOverflow:1});
    const rows=(await redis.lrange(small.keys[0],0,-1)).map(text=>JSON.parse(text).id);
    expect(rows).toEqual(messages.slice(1).map(value=>value.id));
    await clearPrefix(prefix);
    const first=message('bytes',{action:'中'.repeat(100)});
    const second=message('bytes',{action:'中'.repeat(100)});
    const bytes=Buffer.byteLength(JSON.stringify(second));
    const bounded=custom({maxItems:10000,maxBytes:bytes+10});
    await bounded.enqueue([first]); await bounded.enqueue([second]);
    expect(await bounded.status()).toMatchObject({depth:1,bytes,droppedOverflow:1});
    await expect(bounded.enqueue([message('large',{action:'x'.repeat(bytes*2)})])).rejects.toMatchObject({status:413});
  });

  /** 验证在途容量、所有者隔离和租约失效后的恢复。 */
  it('counts active data in budgets, isolates owners and recovers a lost lease',async()=>{
    const small=custom({maxItems:3,maxBytes:8192,batchSize:1});
    const values=Array.from({length:4},()=>message());
    await small.enqueue(values.slice(0,3));
    const claimed=await small.claim('owner-one');
    expect(claimed).toHaveLength(1);
    expect(await small.claim('other-owner')).toEqual([]);
    await small.enqueue([values[3]]);
    expect(await small.status()).toMatchObject({depth:2,inflight:1,droppedOverflow:1});
    expect(await small.ack('wrong-owner',{written:1,invalid:0,expired:0})).toBe(false);
    expect(await small.renew('wrong-owner')).toBe(false);
    expect(await small.renew('owner-one')).toBe(true);
    await redis.pexpire(small.keys[4],1); await delay(10);
    expect(await small.claim('owner-two')).toEqual(claimed);
    expect(await small.ack('owner-one',{written:1,invalid:0,expired:0})).toBe(false);
    expect(await small.ack('owner-two',{written:1,invalid:0,expired:0})).toBe(true);
  });

  /** 验证单批字节限制，并允许合法大元素单独处理。 */
  it('enforces byte-limited batches and processes a single large entry alone',async()=>{
    const value=message('batch-bytes',{action:'x'.repeat(1024)});
    const limited=custom({batchSize:500,batchMaxBytes:100});
    await limited.enqueue([value,message()]);
    const claimed=await limited.claim('large');
    expect(claimed).toEqual([JSON.stringify(value)]);
    expect(await limited.status()).toMatchObject({depth:1,inflight:1});
    await limited.ack('large',{written:0,invalid:1,expired:0});
    expect(await limited.claim('remaining')).toHaveLength(1);
  });

  /** 验证 500 行合为一次多值写入，第 501 行留待下一批。 */
  it('merges 500 rows into one INSERT and leaves row 501 for the next batch',async()=>{
    const queries:string[]=[];
    const log=jest.spyOn(source.logger,'logQuery').mockImplementation(sql=>{if(/^INSERT INTO/.test(sql)) queries.push(sql);});
    try {
      await buffer.enqueue(Array.from({length:501},()=>message('five-hundred')));
      const first=await buffer.claim('batch-500');
      expect(first).toHaveLength(500);
      const result=await writer.write(first);
      expect(result).toEqual({written:500,invalid:0,expired:0});
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('ON DUPLICATE KEY UPDATE');
      await buffer.ack('batch-500',result);
      const remaining=await buffer.claim('last-row');
      expect(remaining).toHaveLength(1);
      await buffer.ack('last-row',await writer.write(remaining));
      expect(await count('five-hundred')).toBe(501);
      expect(await buffer.status()).toMatchObject({depth:0,inflight:0,bytes:0,written:501});
    } finally {log.mockRestore();}
  });

  /** 模拟提交后确认前崩溃，验证恢复重试不会重复计数。 */
  it('retries after SQL commit and before Redis ack without duplicate counts',async()=>{
    await buffer.enqueue([message('commit-crash')]);
    const original=await buffer.claim('before-crash');
    await writer.write(original);
    await redis.pexpire(buffer.keys[4],1); await delay(10);
    const recovered=await buffer.claim('restarted');
    expect(recovered).toEqual(original);
    await buffer.ack('restarted',await writer.write(recovered));
    expect(await count('commit-crash')).toBe(1);
  });

  /** 验证暂时性数据库故障保留批次，退避后可由新消费者恢复。 */
  it('retains temporary MySQL failures with backoff and resumes after restart',async()=>{
    await buffer.enqueue([message('outage')]);
    const failing={write:async()=>{throw Object.assign(new Error('offline'),{code:'ECONNRESET'});}};
    const processor=new IngestionProcessor(buffer,failing as unknown as BatchWriter);
    await processor.flush();
    expect(await buffer.status()).toMatchObject({inflight:1,retries:1,written:0});
    expect(await buffer.claim('too-soon')).toEqual([]);
    await processor.beforeApplicationShutdown();
    await redis.hset(buffer.keys[2],'nextRetryAt',0);
    const restarted=new IngestionProcessor(buffer,writer);
    await restarted.flush();
    expect(await count('outage')).toBe(1);
    expect(await buffer.status()).toMatchObject({inflight:0,bytes:0,written:1});
    await restarted.beforeApplicationShutdown();
  });

  /** 验证坏行隔离、过期丢弃以及相邻有效行继续提交。 */
  it('isolates bad rows, drops expired entries and commits valid neighbors',async()=>{
    const valid=message('poison');
    const invalid=message('poison',{duration:'not-a-number'});
    const expired=message('poison',{timestamp:retentionCutoff(14)-1});
    await buffer.enqueue([valid,invalid,expired]);
    const items=await buffer.claim('isolate');
    const result=await writer.write(items);
    expect(result).toEqual({written:1,invalid:1,expired:1});
    await buffer.ack('isolate',result);
    expect(await count('poison')).toBe(1);
    expect(await buffer.status()).toMatchObject({droppedInvalid:1,droppedExpired:1});
  });

  /** 验证两个独立消费者实例之间的全局租约互斥。 */
  it('allows only one consumer across separate worker instances',async()=>{
    await buffer.enqueue([message('two-workers')]);
    let release!:()=>void;
    let started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const write=jest.fn(async(items:string[])=>{started();await gate;return writer.write(items);});
    const first=new IngestionProcessor(buffer,{write} as unknown as BatchWriter);
    const second=new IngestionProcessor(buffer,writer);
    const running=first.flush();
    await entered;
    await second.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(await count('two-workers')).toBe(0);
    release();await running;
    expect(await count('two-workers')).toBe(1);
    await Promise.all([first.beforeApplicationShutdown(),second.beforeApplicationShutdown()]);
  });

  /** 生成具有真实 gzip 编码与摘要的多片录制，供乱序、去重和冲突测试复用。 */
  function recording(): RecordChunk[] {
    const started=Date.now()-1000;
    const payload=gzipSync(randomBytes(300000)).toString('base64');
    const chunk_count=Math.ceil(payload.length/(256*1024));
    const metadata={app_id:'buffer-replay',project_name:'replay',record_id:randomUUID(),session_id:'session',user_id:'',
      route:'/checkout',page_url:'https://test.example',release:'v1',environment:'test',sdk_version:'test',rrweb_version:'2.1.7',
      protocol_version:1,encoding:'gzip-base64',started_at:started,ended_at:started+500,display_start:started,
      errors:[{event_id:randomUUID(),timestamp:started+100}],end_reason:'window',context_missing:false,raw_bytes:300000,
      encoded_bytes:payload.length,checksum:digest(payload),chunk_count};
    return Array.from({length:chunk_count},(_,chunk_index)=>{
      const part=payload.slice(chunk_index*256*1024,(chunk_index+1)*256*1024);
      return {...metadata,chunk_index,payload:part,chunk_checksum:digest(part)};
    });
  }

  /** 验证混合批次按四张表分组，最多执行四条多值写入。 */
  it('writes a mixed batch in at most four multi-row statements',async()=>{
    const queries:string[]=[];
    const log=jest.spyOn(source.logger,'logQuery').mockImplementation(sql=>{if(/^INSERT INTO/.test(sql)) queries.push(sql);});
    try {
      const chunk=recording()[0];
      const result=await writer.write([
        message('mixed',{event_type:'performance',metric_name:'LCP',value:10}),
        message('mixed',{event_type:'error',error_type:'js',message:'failure'}),
        message('mixed'),
        {id:randomUUID(),kind:'record',receivedAt:Date.now(),payload:chunk},
      ].map(value=>JSON.stringify(value)));
      expect(result).toEqual({written:4,invalid:0,expired:0});
      expect(queries).toHaveLength(4);
      expect(await count('mixed')).toBe(3);
    } finally {log.mockRestore();}
  });

  /** 验证真实 Bull 定时消费、Replay 回执和管理状态接口。 */
  it('runs real Bull consumers, keeps Replay receipts and exposes protected status',async()=>{
    app=await createTestApp({realInfrastructure:true,env:{...process.env,MYSQL_DATABASE:database,
      MYSQL_USERNAME:config.mysql.adminUsername,MYSQL_PASSWORD:config.mysql.adminPassword,
      REDIS_DB:'5',REDIS_KEY_PREFIX:runtimePrefix,MONITOR_FLUSH_INTERVAL_MS:'100',MONITOR_DASHBOARD_TOKEN:'buffer-token'}});
    const queue=app.get<Queue>(getQueueToken(INGEST_QUEUE));
    await queue.pause(true);
    const [chunk]=recording();
    // HTTP 回执用例使用完整单片录制，避免分片完整性影响协议断言。
    const payload=gzipSync('[]').toString('base64');
    const single={...chunk,record_id:randomUUID(),payload,chunk_count:1,chunk_index:0,encoded_bytes:payload.length,
      checksum:digest(payload),chunk_checksum:digest(payload)};
    const value=message('http-async');
    await request(app.getHttpServer()).post('/api/v1/monitor').send(value.payload).expect(204);
    const receipt=await request(app.getHttpServer()).post('/api/v1/records').send(single).expect(200);
    expect(receipt.body).toEqual({ok:true,record_id:single.record_id,chunk_index:0,chunk_checksum:single.chunk_checksum});
    expect(await count('http-async')).toBe(0);
    await request(app.getHttpServer()).get('/api/v1/dashboard/ingestion').expect(401);
    await queue.resume(true);
    await eventually(async()=>await count('http-async')===1);
    const auth={Authorization:'Bearer buffer-token'};
    await eventually(async()=>{
      const result=await request(app!.getHttpServer()).get('/api/v1/dashboard/records/'+single.record_id)
        .query({app_id:single.app_id}).set(auth);
      return result.status===200 && result.body.record.status==='complete';
    });
    const status=await request(app.getHttpServer()).get('/api/v1/dashboard/ingestion').set(auth).expect(200);
    expect(status.body).toMatchObject({ok:true,depth:0,inflight:0,bytes:0,written:2});
    const connection=app.get(DataSource);
    await app.close(); app=undefined;
    expect(connection.isInitialized).toBe(false);
  });


  /** 真实接口在暂停 Bull 调度时仍能直接入库，失败后保留批次并允许手动跳过退避恢复。 */
  it('立即入库接口提交普通事件与 Replay，保留故障数据并遵守跨实例锁', async () => {
    await clearPrefix(runtimePrefix);
    app = await createTestApp({
      realInfrastructure: true,
      env: { ...process.env, MYSQL_DATABASE: database,
        MYSQL_USERNAME: config.mysql.adminUsername, MYSQL_PASSWORD: config.mysql.adminPassword,
        REDIS_DB: '5', REDIS_KEY_PREFIX: runtimePrefix,
        MONITOR_FLUSH_INTERVAL_MS: '60000', MONITOR_DASHBOARD_TOKEN: 'buffer-token' },
    });
    const queue = app.get<Queue>(getQueueToken(INGEST_QUEUE));
    const runtimeBuffer = app.get(IngestionBuffer);
    const runtimeWriter = app.get(BatchWriter);
    const auth = { Authorization: 'Bearer buffer-token' };
    try {
      // 暂停控制队列后再上报，证明手动接口不依赖定时器或 Bull 的排队执行。
      await queue.pause(true);
      const first = message('manual-http');
      const second = message('manual-http');
      await request(app.getHttpServer()).post('/api/v1/monitor')
        .send({ events: [first.payload, second.payload] }).expect(204);
      const [sample] = recording();
      const payload = gzipSync('[]').toString('base64');
      const chunk = { ...sample, record_id: randomUUID(), payload, chunk_count: 1, chunk_index: 0,
        encoded_bytes: payload.length, raw_bytes: 2,
        checksum: digest(payload), chunk_checksum: digest(payload) };
      await request(app.getHttpServer()).post('/api/v1/records').send(chunk).expect(200);
      expect(await count('manual-http')).toBe(0);

      // 未授权请求不能启动消费；第一次真实调用模拟数据库临时断连。
      await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush').expect(401);
      const failure = jest.spyOn(runtimeWriter, 'write')
        .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'ECONNRESET' }));
      try {
        await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush').set(auth).expect(503);
        expect(await runtimeBuffer.status()).toMatchObject({ depth: 0, inflight: 3, written: 0, retries: 1 });
        expect(await runtimeBuffer.claim('ordinary-retry')).toEqual([]);
      } finally { failure.mockRestore(); }

      // 不清除 nextRetryAt，手动调用直接恢复在途批次，并在返回 200 前完成 SQL 提交和 Redis 确认。
      const response = await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush').set(auth).expect(200);
      expect(response.body).toMatchObject({
        ok: true, completed: true, processed: { batches: 1, written: 3, invalid: 0, expired: 0 },
        depth: 0, inflight: 0, bytes: 0, written: 3,
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(await count('manual-http')).toBe(2);
      expect((await new RecordsRepository(source, config).find(chunk.app_id, chunk.record_id))?.status).toBe('complete');

      // 空缓冲重复调用不重复计数。
      const empty = await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush').set(auth).expect(200);
      expect(empty.body).toMatchObject({ completed: true, processed: { batches: 0, written: 0 }, written: 3 });

      // 模拟其他实例持有有效租约，手动调用只能报告待完成，不得抢锁确认。
      await request(app.getHttpServer()).post('/api/v1/monitor').send(message('manual-locked').payload).expect(204);
      const held = await runtimeBuffer.claim('other-instance');
      expect(held).toHaveLength(1);
      const busy = await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush').set(auth).expect(202);
      expect(busy.body).toMatchObject({ completed: false, inflight: 1, processed: { batches: 0 } });
      expect(await count('manual-locked')).toBe(0);
      await runtimeBuffer.fail('other-instance');
      await request(app.getHttpServer()).post('/api/v1/dashboard/ingestion/flush').set(auth).expect(200);
      expect(await count('manual-locked')).toBe(1);
    } finally {
      await app.close();
      app = undefined;
      await clearPrefix(runtimePrefix);
    }
  });

  /** 验证 Replay 合批保留冲突证据，并按序号重组分片。 */
  it('batches Replay variants without losing conflict evidence or chunk ordering',async()=>{
    const chunks=recording();
    const entry=(chunk:RecordChunk):BufferedMessage=>({id:randomUUID(),receivedAt:Date.now(),kind:'record',payload:chunk});
    await buffer.enqueue([entry(chunks[1]),entry(chunks[0]),entry(chunks[0])]);
    const values=await buffer.claim('replay');
    expect(await writer.write(values)).toMatchObject({written:3});
    await buffer.ack('replay',{written:3,invalid:0,expired:0});
    const records=new RecordsRepository(source,config);
    const first=chunks[0];
    expect((await records.find(first.app_id,first.record_id))?.status).toBe('complete');
    expect((await records.chunks(first.app_id,first.record_id,16,0)).map(row=>row.payload).join('')).toBe(chunks.map(row=>row.payload).join(''));
    await writer.write([JSON.stringify(entry({...first,route:'/conflict'}))]);
    expect((await records.find(first.app_id,first.record_id))?.status).toBe('corrupt');
    expect((await records.list({appId:first.app_id,hours:24,route:'/checkout',limit:20,offset:0})).records[0].status).toBe('corrupt');
  });

  /** 验证已有数据的增量迁移，不合并相同事件 UUID 的多次接收。 */
  it('upgrades populated v1 tables without losing rows or collapsing repeated event UUIDs',async()=>{
    const temporary='buffer_migration_'+randomUUID().replaceAll('-','');
    const options=dataSourceOptions({...config.mysql,database:temporary,username:config.mysql.adminUsername,password:config.mysql.adminPassword});
    let legacy:DataSource|undefined;
    let upgraded:DataSource|undefined;
    try {
      await source.query('CREATE DATABASE '+source.driver.escape(temporary)+' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin');
      legacy=new DataSource({...options,migrations:[InitialStorage1793836800000]});
      await legacy.initialize();await legacy.runMigrations();
      const eventId=randomUUID();
      const table=source.driver.escape(config.mysql.tables.behavior);
      await legacy.query('INSERT INTO '+table+' (event_id,event_type,timestamp,app_id,action) VALUES (?,?,?,?,?),(?,?,?,?,?),(?,?,?,?,?)',[
        eventId,'behavior',Date.now()-100,'legacy','click',eventId,'behavior',Date.now()-100,'legacy','click',
        randomUUID(),'behavior',retentionCutoff(14)-1,'legacy','old']);
      await legacy.destroy();
      upgraded=new DataSource(options);await upgraded.initialize();await upgraded.runMigrations();
      const rows=await upgraded.query('SELECT event_id,ingest_id,timestamp FROM '+table+' WHERE app_id=? LIMIT 10',['legacy']);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row:{ingest_id:string})=>row.ingest_id)).size).toBe(3);
      expect(rows.filter((row:{event_id:string})=>row.event_id===eventId)).toHaveLength(2);
      await new PartitionMaintenance(upgraded,{...config.mysql,database:temporary}).maintain();
      expect(await upgraded.query('SELECT event_id FROM '+table+' WHERE app_id=? LIMIT 10',['legacy'])).toHaveLength(2);
      expect(await upgraded.runMigrations()).toEqual([]);
    } finally {
      if(legacy?.isInitialized) await legacy.destroy();
      if(upgraded?.isInitialized) await upgraded.destroy();
      if(/^buffer_migration_[a-f0-9]{32}$/.test(temporary)) await source.query('DROP DATABASE IF EXISTS '+source.driver.escape(temporary));
    }
  });

  /** 验证保留期调整、停机后补分区及 EXPLAIN 的时间分区裁剪。 */
  it('maintains daily partitions, changes retention, catches up and prunes time-bounded queries',async()=>{
    const altered={...config.mysql,retentionDays:7};
    await new PartitionMaintenance(source,altered).maintain();
    const parts=await source.query('SELECT PARTITION_DESCRIPTION AS upperBound FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY PARTITION_ORDINAL_POSITION',[database,config.mysql.tables.behavior]);
    expect(Number(parts[0].upperBound)).toBe(retentionCutoff(7)+DAY_MS);
    await new PartitionMaintenance(source,{...config.mysql,retentionDays:30}).maintain();
    const expanded=await source.query('SELECT PARTITION_NAME AS name FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',[database,config.mysql.tables.behavior]);
    expect(expanded.length).toBeGreaterThan(parts.length);
    await new PartitionMaintenance(source,config.mysql).maintain(utcDay()+40*DAY_MS);
    const next=await source.query('SELECT PARTITION_DESCRIPTION AS upperBound FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY PARTITION_ORDINAL_POSITION',[database,config.mysql.tables.behavior]);
    expect(Number(next[0].upperBound)).toBe(retentionCutoff(14,utcDay()+40*DAY_MS)+DAY_MS);
    // 在独立测试库恢复当前窗口后检查 EXPLAIN，不触及非测试数据。
    await new PartitionMaintenance(source,config.mysql).maintain();
    const explain=await source.query('EXPLAIN SELECT event_id FROM '+source.driver.escape(config.mysql.tables.behavior)+
      ' WHERE app_id=? AND timestamp BETWEEN ? AND ? ORDER BY timestamp LIMIT 20',['http-async',utcDay(),Date.now()]);
    expect(String(explain[0].partitions).split(',').length).toBeLessThanOrEqual(2);
  });
});
