import { checkDatabaseConfig } from '../utils/middleware.js';

export const onRequest = [checkDatabaseConfig];
