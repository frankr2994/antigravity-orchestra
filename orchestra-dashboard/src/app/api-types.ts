import type { useApiClient } from './useApiClient';

export type ReturnTypeApi = ReturnType<typeof useApiClient>['api'];
