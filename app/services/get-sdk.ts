import { createSdk } from 'tinkoff-sdk-grpc-js';

let sdk: ReturnType<typeof createSdk> = null as any

export const getSdk = (token: string) => {
        if (!sdk)
            sdk = createSdk(token);
        return sdk;
}
