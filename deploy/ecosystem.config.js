/**
 * PM2 运行配置（部署文件，随发布包上传到 /opt/monitor-backend/ecosystem.config.js）。
 *
 * 用法：
 *   pm2 start ecosystem.config.js     # 首次启动
 *   pm2 restart monitor-backend --update-env   # 更新代码后重启
 *   pm2 save                          # 保存进程表，供开机 resurrect
 *
 * 关键约定：
 *   - 应用自己读取 `dist/config/configuration.js` 同级的 `.env`（即本目录的 .env），
 *     所以这里只放进程级变量，业务配置一律留在 .env，避免两处互相覆盖。
 *   - 使用 fork 模式单实例：Bull 队列消费者不应并发多份，且 1.7 GiB 内存的机器
 *     跑 cluster 容易 OOM。
 *   - main.ts 里已注册 SIGINT/SIGTERM 优雅关闭，因此保留默认 SIGTERM +
 *     kill_timeout，让缓冲区数据落库后再退出。
 */
module.exports = {
  apps: [
    {
      name: 'monitor-backend',
      cwd: '/opt/monitor-backend',
      // 用绝对路径，避免不同 PM2 版本对 script 相对路径解析不一致。
      script: '/opt/monitor-backend/dist/main.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      source_map_support: true,
      // 单进程内存上限：超过即重启，防止小内存机器被 OOM Killer 直接杀掉。
      max_memory_restart: '450M',
      // 启动即崩溃时按指数退避重启，最多 15 次后停在 errored 状态。
      min_uptime: '20s',
      max_restarts: 15,
      exp_backoff_restart_delay: 100,
      // 优雅关闭窗口：给 app.close() 关闭 HTTP、刷新缓冲、断开队列的时间。
      kill_timeout: 15000,
      time: true,
      merge_logs: true,
      env: {
        // 生产模式：关闭 Nest 的调试输出，日志交给 PM2 收集。
        NODE_ENV: 'production',
        // 如需固定时区再取消下一行；MySQL 侧连接固定 timezone:'Z'（UTC），
        // 只有应用内按本地时间聚合的逻辑会受此变量影响。
        // TZ: 'Asia/Shanghai',
      },
    },
  ],
};
