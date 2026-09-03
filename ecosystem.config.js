const path = require('path');
const ROOT = __dirname;

// Convexity paper desk. Alpaca Trading API + market data + CLI.
// Starts disarmed. Plug in any LLM via VOL10S_LLM_*.
module.exports = {
  apps: [
    {
      name: 'vol10s-paper',
      script: 'src/vol10s-paper-server.js',
      cwd: ROOT,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '768M',
      env: {
        NODE_ENV: 'production',
        VOL10S_ENV_FILE: path.join(ROOT, 'envs/vol10s-paper.env'),
        VOL10S_PAPER_PORT: '8977',
        VOL10S_BIND: '127.0.0.1',
        VOL10S_ARMED: 'false',
      },
    },
  ],
};
