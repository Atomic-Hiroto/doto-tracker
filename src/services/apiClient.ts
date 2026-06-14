import axios from 'axios';
import axiosRetry from 'axios-retry';
import { logger } from './loggerService';

const opendotaClient = axios.create({
    baseURL: 'https://api.opendota.com/api',
    timeout: 30000,
});

axiosRetry(opendotaClient, {
    retries: 3,
    shouldResetTimeout: true,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return (
            axiosRetry.isNetworkOrIdempotentRequestError(error) ||
            error.response?.status === 429 ||
            error.response?.status === 503 ||
            error.response?.status === 502
        );
    },
    onRetry: (retryCount, error) => {
        logger.warn(`OpenDota API retry #${retryCount} — ${error.message}`);
    },
});

opendotaClient.interceptors.response.use(
    (response) => response,
    (error) => {
        if (axios.isAxiosError(error)) {
            logger.debug(`OpenDota API error: ${error.response?.status} ${error.config?.url}`);
        }
        return Promise.reject(error);
    }
);

export { opendotaClient };
