const mongoose = require('mongoose');
const logger = require('../utils/logger');
const config = require('./env');

let isConnected = false;

const connectDB = async () => {
  if (!config.mongodbUri) {
    logger.warn('MONGODB_URI not configured. Database operations will be unavailable.');
    return false;
  }

  try {
    const conn = await mongoose.connect(config.mongodbUri, {
      dbName: 'abihacart',
      serverSelectionTimeoutMS: 5000,
      autoIndex: config.env !== 'production',
    });

    isConnected = true;
    logger.info(`MongoDB connected successfully: ${conn.connection.host}`);
    return true;
  } catch (error) {
    isConnected = false;
    logger.error('MongoDB connection failure:', { message: error.message });
    return false;
  }
};

mongoose.connection.on('disconnected', () => {
  isConnected = false;
  logger.warn('MongoDB connection lost. Attempting reconnection...');
});

mongoose.connection.on('error', (err) => {
  logger.error('MongoDB connection error:', { message: err.message });
});

const getDBStatus = () => {
  const stateMap = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return stateMap[mongoose.connection.readyState] || 'unknown';
};

const disconnectDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    logger.info('MongoDB connection closed cleanly.');
  }
};

module.exports = {
  connectDB,
  disconnectDB,
  getDBStatus,
  isConnected: () => isConnected,
};
