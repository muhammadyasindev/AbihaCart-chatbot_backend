const app = require('./src/app');
const config = require('./src/config/env');
const { connectDB, disconnectDB } = require('./src/config/db');
const logger = require('./src/utils/logger');

let server;

const startServer = async () => {
  try {
    // Attempt database connection
    const dbConnected = await connectDB();
    if (!dbConnected) {
      if (config.env === 'production') {
        logger.error('CRITICAL: MongoDB Atlas connection required for production deployment. Halting startup.');
        process.exit(1);
      } else {
        logger.warn('NOTICE: MongoDB Atlas disconnected. Active in development/test fallback mode.');
      }
    } else {
      logger.info('MongoDB Atlas live cluster connection established.');
    }

    server = app.listen(config.port, () => {
      logger.info(`Abihacart AI Support Backend running on port ${config.port} [${config.env}]`);
      logger.info(`Health check available at: http://localhost:${config.port}/api/health`);
    });
  } catch (error) {
    logger.error('Failed to start server:', { message: error.message });
    process.exit(1);
  }
};

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  if (server) {
    server.close(async () => {
      logger.info('HTTP server closed.');
      await disconnectDB();
      logger.info('Process terminated safely.');
      process.exit(0);
    });
  } else {
    await disconnectDB();
    process.exit(0);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', { reason, promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { message: error.message, stack: error.stack });
  process.exit(1);
});

startServer();
