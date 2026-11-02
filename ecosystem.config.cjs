module.exports = {
  apps: [
    {
      name: 'whatsapp-api-gateway',
      script: './src/server.js',
      instances: 'max', // Utilize all available CPU cores (e.g., Oracle Cloud Ampere ARM cores)
      exec_mode: 'cluster', // Enable PM2 Cluster Mode for automatic load-balancing
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 5000,
      wait_ready: false,
      autorestart: true,
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
